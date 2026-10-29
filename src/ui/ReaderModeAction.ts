/** Replace Obsidian's mode button with a read-only indicator in the same slot. */
const SVG_NS = "http://www.w3.org/2000/svg";
const READER_PATHS = [
	"M11 7v14",
	"M11 7a4 4 0 0 0-4-4H3a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h5a3 3 0 0 1 3 3",
	"M11 7a4 4 0 0 1 4-4h4a1 1 0 0 1 1 1v6.5",
	"M11 21a2.5 2.5 0 0 1 2.5-2.5",
	"M22 17v-2a2 2 0 1 0-4 0v2",
];

function readerIcon(doc: Document): SVGSVGElement {
	const svg = doc.createElementNS(SVG_NS, "svg");
	for (const [name, value] of Object.entries({
		width: "24",
		height: "24",
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "2",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		class: "svg-icon inline-icon relay-book-open-lock",
	})) {
		svg.setAttribute(name, value);
	}
	for (const d of READER_PATHS) {
		const path = doc.createElementNS(SVG_NS, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	const lock = doc.createElementNS(SVG_NS, "rect");
	for (const [name, value] of Object.entries({
		x: "16",
		y: "17",
		width: "7",
		height: "5",
		rx: "1",
	})) {
		lock.setAttribute(name, value);
	}
	svg.append(lock);
	return svg;
}

function readerIndicator(doc: Document): HTMLSpanElement {
	const indicator = doc.createElement("span");
	indicator.className = "clickable-icon view-action relay-reader-action";
	indicator.setAttribute("role", "img");
	indicator.setAttribute("aria-label", "Shared folder is read only");
	indicator.setAttribute("title", "Shared folder is read only");
	indicator.append(readerIcon(doc));
	return indicator;
}

export class ReaderModeAction {
	private actions?: HTMLElement;
	private native?: HTMLButtonElement;
	private replacement?: HTMLSpanElement;
	private observer?: MutationObserver;

	constructor(private readonly container: HTMLElement) {}

	setActive(active: boolean): boolean {
		if (!active) {
			this.destroy();
			return false;
		}
		const actions = this.container.querySelector<HTMLElement>(".view-actions");
		if (!actions) {
			this.destroy();
			return false;
		}
		if (this.actions !== actions) {
			this.destroy();
			this.actions = actions;
			this.observer = new MutationObserver(() => this.reconcile());
			this.observer.observe(actions, { childList: true, subtree: true });
		}
		this.reconcile();
		return this.replacement?.parentNode === actions;
	}

	private reconcile(): void {
		const actions = this.actions;
		if (!actions) return;
		const native = Array.from(actions.querySelectorAll<HTMLButtonElement>(":scope > button.view-action"))
			.find((button) => button.getAttribute("aria-label")?.startsWith("Current view:") ||
				button.querySelector(":scope > svg.lucide-book-open, :scope > svg.lucide-edit-3"));
		if (!native) return;
		this.native = native;
		this.replacement ??= readerIndicator(native.ownerDocument);
		// Moving the existing indicator here also removes it from any old slot.
		// The native button and its listeners remain intact for restoration.
		native.replaceWith(this.replacement);
	}

	destroy(): void {
		this.observer?.disconnect();
		this.observer = undefined;
		if (this.replacement?.parentNode && this.native) {
			this.replacement.replaceWith(this.native);
		}
		this.replacement = undefined;
		this.native = undefined;
		this.actions = undefined;
	}
}
