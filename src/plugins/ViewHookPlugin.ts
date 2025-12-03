import { MarkdownView } from "obsidian";
import { getPatcher } from "../Patcher";
import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { Document } from "../Document";
import type { ViewRenderer } from "./ViewRenderer";
import { HasLogging } from "../debug";

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
