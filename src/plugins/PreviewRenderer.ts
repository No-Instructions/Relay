import { MarkdownView } from "obsidian";
import type { Document } from "../Document";
import type { ViewRenderer } from "./ViewRenderer";
import { HasLogging } from "../debug";

/**
 * Pure UI rendering logic for preview mode synchronization.
 * Updates preview UI when document changes occur.
 */
export class PreviewRenderer extends HasLogging implements ViewRenderer {
	private view: MarkdownView;
	private destroyed = false;

	constructor(view: MarkdownView) {
		super();
		this.view = view;
		this.setLoggers(`[PreviewRenderer][${view.file?.path}]`);
		this.debug("created");
	}

	render(document: Document, viewMode: string): void {
		if (this.destroyed) {
			this.debug("Skipping render - renderer destroyed");
			return;
		}

		if (viewMode !== "preview") {
			return;
		}

		try {
			this.debug("Rendering preview from document");

			// Use localText to get editor state from localDoc
			const text = document.localText;

			// Update the view's internal text state
			// @ts-ignore - accessing internal Obsidian API
			this.view.text = text;

			// Update the preview renderer
			// @ts-ignore - accessing internal Obsidian API
			this.view.previewMode.renderer.set(text);

			// Live preview already applies Relay updates through CM6. Re-entering
			// Obsidian's internal quick-preview pipeline from here can bounce back
			// into setViewData while the view is mid-update.
			// @ts-ignore - accessing internal Obsidian API
			if (!this.view.editor?.cm) {
				// @ts-ignore - accessing internal Obsidian API
				this.view.onInternalDataChange?.();
			}

			this.debug("Preview render completed");
		} catch (error) {
			this.error("Error rendering preview:", error);
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.debug("destroyed");
		this.view = null as any;
	}
}
