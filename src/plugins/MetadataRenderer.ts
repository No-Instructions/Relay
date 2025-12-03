import { MarkdownView, getFrontMatterInfo, parseYaml } from "obsidian";
import { Document } from "../Document";
import type { ViewRenderer } from "./ViewRenderer";
import { flags } from "../flagManager";
import { HasLogging } from "../debug";

/**
 * Pure UI rendering logic for metadata editor synchronization.
 * Updates metadata editor UI when document changes occur.
 */
export class MetadataRenderer extends HasLogging implements ViewRenderer {
	private view: MarkdownView;
	private destroyed = false;

	constructor(view: MarkdownView) {
		super();
		this.view = view;
		this.setLoggers(`[MetadataRenderer][${view.file?.path}]`);
		this.debug("created");
	}

	render(document: Document, viewMode: string): void {
		if (this.destroyed) {
			this.debug("Skipping render - renderer destroyed");
			return;
		}

		if (!flags().enableMetadataViewHooks) {
			this.debug("Metadata view hooks disabled via flags");
			return;
		}

		try {
			this.debug("Rendering metadata from document");
			
			// @ts-ignore - accessing internal Obsidian API
			const metadataEditor = this.view.metadataEditor;
			
			if (!metadataEditor) {
				this.debug("No metadata editor available");
				return;
			}

			// Parse frontmatter from document text
			const fmi = getFrontMatterInfo(document.text);
			const fm = fmi.frontmatter;
			
			if (fm) {
				// Synchronize the metadata editor with parsed frontmatter
				metadataEditor.synchronize(parseYaml(fm));
				for (const prop of metadataEditor.rendered) {
					prop.renderProperty(prop.entry, true); // true = force
				}
			} else {
				this.debug("No frontmatter found in document");
			}
		} catch (error) {
			this.error("Error rendering metadata:", error);
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.debug("destroyed");
		this.view = null as any;
	}
}