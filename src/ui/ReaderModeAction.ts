import ReaderModeIcon from "src/components/ReaderModeIcon.svelte";
import { mountComponent, type MountedComponent } from "src/ui/svelteHost.svelte";

function readerIndicator(doc: Document): HTMLSpanElement {
	const indicator = doc.createElement("span");
	indicator.className = "clickable-icon view-action relay-reader-action";
	indicator.setAttribute("role", "img");
	indicator.setAttribute("aria-label", "Shared folder is read only");
	indicator.setAttribute("title", "Shared folder is read only");
	return indicator;
}

/** Replace Obsidian's mode button with a read-only indicator in the same slot. */
export class ReaderModeAction {
	private actions?: HTMLElement;
	private native?: HTMLButtonElement;
	private replacement?: HTMLSpanElement;
	private icon?: MountedComponent;
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
		if (!this.replacement) {
			this.replacement = readerIndicator(native.ownerDocument);
			this.icon = mountComponent(ReaderModeIcon, {
				target: this.replacement,
				props: {},
			});
		}
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
		this.icon?.destroy();
		this.icon = undefined;
		this.replacement = undefined;
		this.native = undefined;
		this.actions = undefined;
	}
}
