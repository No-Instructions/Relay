import { MarkdownView } from "obsidian";
import { getPatcher } from "../Patcher";
import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { Document } from "../Document";
import type { ViewRenderer } from "./ViewRenderer";
import { PreviewRenderer } from "./PreviewRenderer";
import { diffMatchPatch } from "../y-diffMatchPatch";
import { flags } from "../flagManager";
import { HasLogging } from "../debug";
import type { ChangeSpec } from "@codemirror/state";
import diff_match_patch from "diff-match-patch";
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
				await hsm.awaitState((s) => s.startsWith("active."));
			}
			localDoc = this.document.localDoc;
		}
		if (this.destroyed || !localDoc) return;

		this._ytext = localDoc.getText("contents");
		this.setupDocumentObserver();

		// Perform initial render using localDoc content
		// @ts-ignore
		this.view.previewMode.renderer.set(this.document.localText);
		this.renderAll();

		this.document.connect();
		this.debug("initialized");
	}

	/**
	 * Install hooks into Obsidian's internal methods for UI-specific edit pathways
	 */
	private installMarkdownHooks(view: MarkdownView): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const that = this;

		// Hook 1: Track metadata saves (if enableMetadataViewHooks)
		if (flags().enableMetadataViewHooks) {
			this.unsubscribes.push(
				getPatcher().patch(view, {
					// @ts-ignore
					saveFrontmatter(old: any) {
						return function (data: any) {
							that.debug("saveFrontmatter hook triggered");
							that.document.hsm?.send({
								type: 'OBSIDIAN_SAVE_FRONTMATTER',
								path: that.document.path,
							});
							that.saving = true;
							// @ts-ignore
							const result = old.call(this, data);
							that.saving = false;
							return result;
						};
					},
				}),
			);
		}

		// Hook 2: Coordinate saves between pathways
		this.unsubscribes.push(
			getPatcher().patch(view, {
				// @ts-ignore
				save(old: any) {
					return function (data: any) {
						// @ts-ignore
						const result = old.call(this, data);
						try {
							// @ts-ignore
							const viewMode = that.view.getMode?.() ?? "unknown";
							if (viewMode === "preview" && that.saving) {
								that.debug("Syncing metadata changes to CRDT during save");
								that.document.hsm?.send({
									type: 'OBSIDIAN_METADATA_SYNC',
									path: that.document.path,
									mode: viewMode,
								});
								diffMatchPatch(
									that.document.getWritableDoc(),
									// @ts-ignore
									that.view.text,
									that.document,
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

		// Hook 3: Preview mode direct edits (if enablePreviewViewHooks)
		if (flags().enablePreviewViewHooks) {
			this.unsubscribes.push(
				getPatcher().patch(view.previewMode as any, {
					edit(old: any) {
						return function (data: string) {
							that.debug("Preview edit hook triggered");
							//@ts-ignore
							if (that.view.getMode?.() === "preview") {
								//@ts-ignore
								if (that.view.editor) {
									// If CodeMirror editor is available, dispatch changes there
									const changes = that.incrementalBufferChange(data);
									// @ts-ignore
									that.view.editor.cm.dispatch({
										changes,
									});
									that.debug("Dispatched preview edit to CodeMirror");
								} else {
									// Otherwise sync directly to CRDT
									diffMatchPatch(that.document.getWritableDoc(), data, that.document);
									that.debug("Synced preview edit directly to CRDT");
								}
								return;
							}

							// @ts-ignore
							return old.call(this, data);
						};
					},
				}),
			);
		}
	}

	/**
	 * Setup document observer to trigger UI updates
	 */
	private setupDocumentObserver(): void {
		if (!this._ytext) return;

		this.observer = async (event: YTextEvent, tr: Transaction) => {
			if (!this.active()) {
				this.debug("Received yjs event against a non-active view");
				return;
			}
			if (this.destroyed) {
				this.debug("Received yjs event but plugin was destroyed");
				return;
			}

			this.renderAll();
		};

		this._ytext.observe(this.observer);
	}

	/**
	 * Check if this plugin is still active
	 */
	private active(): boolean {
		return !this.destroyed && !!this.view;
	}

	/**
	 * Update all UI renderers when document changes
	 */
	private renderAll(): void {
		const viewMode =
			// @ts-ignore
			this.view.getMode?.() || this.view.getViewType?.() || "unknown";
		this.renderers.forEach((renderer) => {
			try {
				renderer.render(this.document, viewMode);
			} catch (error) {
				this.error("Error in renderer:", error);
			}
		});
	}
	/**
	 * Calculate incremental buffer changes using diff-match-patch
	 */
	private incrementalBufferChange(newBuffer: string): ChangeSpec[] {
		// @ts-ignore
		const currentBuffer = this.view.editor.cm.state.doc.toString();
		const dmp = new diff_match_patch();
		const diffs = dmp.diff_main(currentBuffer, newBuffer);
		dmp.diff_cleanupSemantic(diffs);

		const changes: ChangeSpec[] = [];
		let pos = 0;

		for (const [type, text] of diffs) {
			switch (type) {
				case 0: // EQUAL
					pos += text.length;
					break;
				case 1: // INSERT
					changes.push({
						from: pos,
						to: pos,
						insert: text,
					});
					break;
				case -1: // DELETE
					changes.push({
						from: pos,
						to: pos + text.length,
						insert: "",
					});
					pos += text.length;
					break;
			}
		}

		// Merge adjacent delete+insert pairs into single replacements.
		// CM6 silently drops split delete/insert at the same boundary.
		const merged: ChangeSpec[] = [];
		let i = 0;
		while (i < changes.length) {
			const current = changes[i] as { from: number; to: number; insert: string };
			const next = changes[i + 1] as { from: number; to: number; insert: string } | undefined;
			if (
				next &&
				current.insert === "" &&
				next.from === current.to &&
				next.to === next.from
			) {
				merged.push({ from: current.from, to: current.to, insert: next.insert });
				i += 2;
			} else {
				merged.push(current);
				i++;
			}
		}
		return merged;
	}

	/**
	 * Clean up hooks and renderers
	 */
	destroy(): void {
		this.destroyed = true;
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
		this._ytext = null as any;
		this.view = null as any;
		this.document = null as any;
	}
}
