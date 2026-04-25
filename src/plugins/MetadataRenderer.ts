import { MarkdownView, getFrontMatterInfo, parseYaml } from "obsidian";
import type { Document } from "../Document";
import type { ViewRenderer } from "./ViewRenderer";
import { HasLogging } from "../debug";

/**
 * Pure UI rendering logic for metadata editor synchronization.
 * Updates metadata editor UI when document changes occur.
 */
export class MetadataRenderer extends HasLogging implements ViewRenderer {
	private view: MarkdownView;
	private destroyed = false;
	private pendingFocusedProps: any[] = [];
	private focusoutEl: any = null;
	private readonly focusoutHandler = () => {
		Promise.resolve().then(() => this.flushPendingFocusedProps());
	};

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

			if (!fm) {
				this.setPendingFocusedProps([], metadataEditor.contentEl);
				return;
			}

			metadataEditor.synchronize(parseYaml(fm));

			// Re-render each property, but defer rows where the user is
			// actively typing so we don't destroy their input context.
			const focused = globalThis.document?.activeElement;
			const skipped: any[] = [];
			for (const prop of metadataEditor.rendered) {
				if (this.shouldDeferPropertyRender(focused, prop)) {
					skipped.push(prop);
					continue;
				}
				prop.renderProperty(prop.entry, true);
			}
			this.setPendingFocusedProps(skipped, metadataEditor.contentEl);
		} catch (error) {
			this.error("Error rendering metadata:", error);
		}
	}

	private shouldDeferPropertyRender(focused: any, prop: any): boolean {
		if (!focused || !prop.containerEl?.contains(focused)) return false;
		return this.isTextEditingElement(focused);
	}

	private isTextEditingElement(el: any): boolean {
		const tagName = String(el?.tagName ?? "").toUpperCase();
		if (tagName === "TEXTAREA") return true;
		if (tagName === "INPUT") {
			const type = String(el.type ?? "text").toLowerCase();
			return ![
				"button",
				"checkbox",
				"color",
				"file",
				"hidden",
				"radio",
				"range",
				"reset",
				"submit",
			].includes(type);
		}
		return el?.isContentEditable === true || el?.contentEditable === "true";
	}

	private setPendingFocusedProps(props: any[], contentEl: any): void {
		this.pendingFocusedProps = props;
		if (props.length > 0) {
			if (this.focusoutEl !== contentEl) {
				this.removeFocusoutListener();
				this.focusoutEl = contentEl;
				this.focusoutEl?.addEventListener?.("focusout", this.focusoutHandler);
			}
			return;
		}
		this.removeFocusoutListener();
	}

	private flushPendingFocusedProps(): void {
		if (this.destroyed || this.pendingFocusedProps.length === 0) return;

		const focused = globalThis.document?.activeElement;
		const stillPending: any[] = [];
		for (const prop of this.pendingFocusedProps) {
			if (this.shouldDeferPropertyRender(focused, prop)) {
				stillPending.push(prop);
				continue;
			}
			prop.renderProperty(prop.entry, true);
		}
		this.pendingFocusedProps = stillPending;
		if (stillPending.length === 0) {
			this.removeFocusoutListener();
		}
	}

	private removeFocusoutListener(): void {
		if (this.focusoutEl) {
			this.focusoutEl.removeEventListener?.("focusout", this.focusoutHandler);
			this.focusoutEl = null;
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.pendingFocusedProps = [];
		this.removeFocusoutListener();
		this.debug("destroyed");
		this.view = null as any;
	}
}
