import { MarkdownView, getFrontMatterInfo, parseYaml } from "obsidian";
import { Document } from "../Document";
import type { ViewRenderer } from "./ViewRenderer";
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
			return;
		}

		try {
			// @ts-ignore - accessing internal Obsidian API
			const metadataEditor = this.view.metadataEditor;

			if (!metadataEditor) {
				return;
			}

			// Parse frontmatter from localDoc content
			const fmi = getFrontMatterInfo(document.localText);
			const fm = fmi.frontmatter;

			if (fm) {
				metadataEditor.synchronize(parseYaml(fm));

				// Re-render each property, but skip the one the user is
				// actively editing so we don't destroy their input context.
				const focused = globalThis.document?.activeElement;
				for (const prop of metadataEditor.rendered) {
					if (focused && prop.containerEl?.contains(focused)) {
						continue;
					}
					prop.renderProperty(prop.entry, true);
				}
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
