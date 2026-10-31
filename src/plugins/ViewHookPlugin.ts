import { MarkdownView } from "obsidian";
import { getPatcher } from "../Patcher";
import type { EditorView } from "@codemirror/view";
import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import type { Document } from "../Document";
import type { ViewRenderer } from "./ViewRenderer";
import { PreviewRenderer } from "./PreviewRenderer";
import { HasLogging } from "../debug";
import type { ChangeSpec } from "@codemirror/state";
import { trackPromise } from "../trackPromise";
import { diffTextChanges } from "../textChanges";
import { MetadataRenderer } from "./MetadataRenderer";

/**
 * Centralized Obsidian UI hooks coordinator.
 * Manages all UI-specific edit pathways and coordinates save operations.
 */
export class ViewHookPlugin extends HasLogging {
	private view: MarkdownView;
	private document: Document;
	private renderers: ViewRenderer[];
	private unsubscribes: Array<() => void> = [];
	private observer?: (event: YTextEvent, tr: Transaction) => void;
	private _ytext: YText | null = null;
	private destroyed = false;
	private saving = false;
	private previewRestore?: number;
	private renderQueued = false;

	constructor(view: MarkdownView, document: Document) {
		super();
		this.view = view;
		this.document = document;
		this.setLoggers(`[ViewHookPlugin][${document.path}]`);
		this.debug("created");

		// Initialize renderers
		this.renderers = [];
		this.renderers.push(new PreviewRenderer(view));
		this.renderers.push(new MetadataRenderer(view));

		this.installMarkdownHooks(this.view);
	}

	private runWithRelaySaving<T>(fn: () => T): T {
		const view = this.view as MarkdownView & { __relaySaving?: boolean };
		const hadOwnFlag = Object.prototype.hasOwnProperty.call(view, "__relaySaving");
		const previous = view.__relaySaving;
		view.__relaySaving = true;
		try {
			return fn();
		} finally {
			if (hadOwnFlag) {
				view.__relaySaving = previous;
			} else {
				delete view.__relaySaving;
			}
		}
	}

	private syncViewTextToHsm(text: string, reason: string): void {
		const hsm = this.document.hsm;
		if (!hsm) {
			this.debug(`Skipping ${reason}: no HSM`);
			return;
		}

		if (this.document.localText === text) {
			return;
		}

		hsm.send({
			type: "CM6_CHANGE",
			changes: hsm.computeDiffChanges(this.document.localText, text),
			docText: text,
			userEvent: "set",
		});
	}

	private get readOnly(): boolean {
		return this.document.canWriteContent === false ||
			this.document.hsm?.statePath?.startsWith("active.reading") === true;
	}

	private restorePreview(): void {
		const win = this.view.containerEl.ownerDocument.defaultView;
		if (!win) return;
		if (this.previewRestore !== undefined) win.clearTimeout(this.previewRestore);
		// Native checkbox handling also schedules a DOM update. Reparse after it
		// so neither that tick nor cached section HTML can outlive a denied edit.
		this.previewRestore = win.setTimeout(() => {
			this.previewRestore = undefined;
			if (this.destroyed) return;
			this.renderAll();
			this.view.previewMode.rerender(true);
		}, 0);
	}

	/**
	 * Attach the document observer once localDoc is available.
	 * Waits for the HSM to enter active mode if needed.
	 */
	async initialize(): Promise<void> {
		// Wait for localDoc to become available (HSM entering active mode)
		let localDoc = this.document.localDoc;
		if (!localDoc) {
			const hsm = this.document.hsm;
			if (hsm?.awaitState) {
				await trackPromise(`viewHook:awaitActive:${this.document.guid}`, hsm.awaitState((s) => s.startsWith("active.")));
			}
			if (this.destroyed || this.document.destroyed) return;
			localDoc = this.document.localDoc;
		}
		if (this.destroyed || this.document.destroyed || !localDoc) return;

		this._ytext = localDoc.getText("contents");
		this.setupDocumentObserver();

		const hsm = this.document.hsm;
		let ready = this.canRender();
		if (hsm) this.unsubscribes.push(hsm.onStateChange((from, to) => {
			const nextReady = this.canRender();
			const becameReady = nextReady && !ready;
			ready = nextReady;
			const modeChanged = from.startsWith("active.reading") !== to.startsWith("active.reading");
			if (!nextReady || (!becameReady && !modeChanged) || this.renderQueued) return;
			// Cancellation can restore deleted structs without a text event.
			// Refresh when the live document becomes ready, after editor updates.
			this.renderQueued = true;
			queueMicrotask(() => {
				this.renderQueued = false;
				this.renderAll();
			});
		}));
		this.renderAll();

		void this.document.connect();
		this.debug("initialized");
	}

	/**
	 * Install hooks into Obsidian's internal methods for UI-specific edit pathways
	 */
	private installMarkdownHooks(view: MarkdownView): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- Renderer hooks need the plugin instance when Obsidian supplies another receiver.
		const that = this;

		// Hook 1: Track metadata saves.
		this.unsubscribes.push(
			getPatcher().patch(view, {
				// @ts-ignore
				saveFrontmatter(old: (...args: unknown[]) => unknown) {
					return function (this: unknown, data: unknown) {
						if (that.readOnly) {
							that.restorePreview();
							return;
						}
						that.debug("saveFrontmatter hook triggered");
						that.document.hsm?.send({
							type: 'OBSIDIAN_SAVE_FRONTMATTER',
							path: that.document.path,
						});
						that.saving = true;
						const result = old.call(this, data);
						that.saving = false;
						return result;
					};
				},
			}),
		);

		// Hook 2: Coordinate saves between pathways
		this.unsubscribes.push(
			getPatcher().patch(view, {
				// @ts-ignore
				save(old: (...args: unknown[]) => unknown) {
					return function (this: unknown, ...args: unknown[]) {
						const result = old.apply(this, args);
						try {
							const viewMode = that.view.getMode?.() ?? "unknown";
							if (viewMode === "preview" && that.saving) {
								that.debug("Syncing metadata changes through HSM during save");
								that.document.hsm?.send({
									type: "OBSIDIAN_METADATA_SYNC",
									path: that.document.path,
									mode: viewMode,
								});
								that.syncViewTextToHsm(
									(that.view as MarkdownView & { text?: string }).text ?? "",
									"preview.save",
								);
							}
						} catch (e) {
							that.error("Error syncing during save:", e);
						}
						return result;
					};
				},
			}),
		);

		// Hook 3: Preview mode direct edits.
		this.unsubscribes.push(
			getPatcher().patch(view.previewMode as unknown as Record<string, unknown>, {
				edit(old: (...args: unknown[]) => unknown) {
					return function (this: unknown, data: string) {
						if (that.readOnly) {
							that.restorePreview();
							return;
						}
						that.debug("Preview edit hook triggered");
						//@ts-ignore
						if (that.view.getMode?.() === "preview") {
							const editor = (
								that.view as MarkdownView & {
									editor?: { cm?: EditorView };
								}
							).editor;
							if (editor?.cm) {
								// If CodeMirror editor is available, dispatch changes there
								const changes = that.incrementalBufferChange(data);
								editor.cm.dispatch({
									changes,
								});
								that.debug("Dispatched preview edit to CodeMirror");
							} else {
								// Otherwise route the preview edit through HSM.
								that.syncViewTextToHsm(data, "preview.edit");
								that.debug("Synced preview edit through HSM");
							}
							return;
						}

						return old.call(this, data);
					};
				},
			}),
		);
	}

	/**
	 * Setup document observer to trigger UI updates
	 */
	private setupDocumentObserver(): void {
		if (!this._ytext) return;

		this.observer = (event: YTextEvent, tr: Transaction) => {
			void (async () => {
			if (!this.active()) {
				this.debug("Received yjs event against a non-active view");
				return;
			}
			if (this.destroyed) {
				this.debug("Received yjs event but plugin was destroyed");
				return;
			}

			this.renderAll();
			})();
		};

		this._ytext.observe(this.observer);
	}

	/**
	 * Check if this plugin is still active
	 */
	private active(): boolean {
		return !this.destroyed && !!this.view;
	}

	/** A pending stash still contains unpublished operations in the local document. */
	private canRender(): boolean {
		if (this.destroyed || this.document.destroyed || !this.document.localDoc) return false;
		const hsm = this.document.hsm;
		return !hsm?.isReadMode() || !hsm.hasFork() || hsm.hasRetainedStash();
	}

	private renderAll(): void {
		if (!this.canRender()) return;
		const viewMode = this.view.getMode?.() || this.view.getViewType?.() || "unknown";
		this.runWithRelaySaving(() => {
			this.renderers.forEach((renderer) => {
				try {
					renderer.render(this.document, viewMode);
				} catch (error) {
					this.error("Error in renderer:", error);
				}
			});
		});
	}
	/**
	 * Calculate incremental buffer changes using diff-match-patch
	 */
	private incrementalBufferChange(newBuffer: string): ChangeSpec[] {
		const currentBuffer =
			(
				this.view as MarkdownView & { editor?: { cm?: EditorView } }
			).editor?.cm?.state.doc.toString() ?? "";
		return diffTextChanges(currentBuffer, newBuffer);
	}

	/**
	 * Clean up hooks and renderers
	 */
	destroy(): void {
		this.destroyed = true;
		if (this.previewRestore !== undefined) this.view.containerEl.ownerDocument.defaultView?.clearTimeout(this.previewRestore);
		this.previewRestore = undefined;
		this.debug("destroyed");

		// Clean up document observer
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}

		// Clean up Obsidian hooks
		this.unsubscribes.forEach((unsubscribe) => unsubscribe());
		this.unsubscribes.length = 0;

		// Clean up renderers
		this.renderers.forEach((renderer) => renderer.destroy());
		this.renderers.length = 0;

		// Clear references
		this._ytext = null;
		this.view = null as unknown as typeof this.view;
		this.document = null as unknown as typeof this.document;
	}
}
