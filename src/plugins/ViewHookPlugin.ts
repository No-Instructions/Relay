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
	private _ytext: YText;
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

		this._ytext = this.document.ytext;
		this.installMarkdownHooks(this.view);
		this.setupDocumentObserver();
		this.renderAll();
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
							if (that.view.getMode?.() === "preview" && that.saving) {
								that.debug("Syncing metadata changes to CRDT during save");
								diffMatchPatch(
									that.document.ydoc,
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
									diffMatchPatch(that.document.ydoc, data, that.document);
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
		this.observer = async (event: YTextEvent, tr: Transaction) => {
			if (!this.active()) {
				this.debug("Received yjs event against a non-active view");
				return;
			}
			if (this.destroyed) {
				this.debug("Received yjs event but plugin was destroyed");
				return;
			}

			this.debug("Document changed, updating all renderers");
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
		this.debug(`Rendering all components for mode: ${viewMode}`);

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
		let currentPos = 0;

		for (const [type, text] of diffs) {
			switch (type) {
				case 0: // EQUAL
					currentPos += text.length;
					break;
				case 1: // INSERT
					changes.push({
						from: currentPos,
						to: currentPos,
						insert: text,
					});
					currentPos += text.length;
					break;
				case -1: // DELETE
					changes.push({
						from: currentPos,
						to: currentPos + text.length,
						insert: "",
					});
					break;
			}
		}
		return changes;
	}
	/**
	 * Initialize the plugin after document is ready
	 */
	async initialize(): Promise<void> {
		await this.document.whenReady();

		// Perform initial render
		// @ts-ignore
		this.view.previewMode.renderer.set(this.document.text);
		this.renderAll();

		this.document.connect();
		this.debug("ViewHookPlugin initialized");
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
