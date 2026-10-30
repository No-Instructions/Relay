/** Keep native reading-view controls consistent with a note's write access. */
export class ReaderInteractionGuard {
	private observer?: MutationObserver;
	private readonly originals = new Map<HTMLElement, { attribute: string; value: string | null }>();
	private readonly blockCheckbox = (event: Event): void => {
		const target = event.target as HTMLElement | null;
		const checkbox = target?.closest?.("input.task-list-item-checkbox");
		if (!checkbox || checkbox.closest(".markdown-embed")) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	constructor(private readonly container: HTMLElement) {}

	activate(): void {
		if (this.observer || typeof MutationObserver === "undefined") return;
		// Capture before Obsidian changes its cached HTML and the visible tick.
		this.container.addEventListener("click", this.blockCheckbox, true);
		this.observer = new MutationObserver(() => this.reconcile());
		this.observer.observe(this.container, {
			childList: true, subtree: true, attributes: true,
			attributeFilter: ["contenteditable", "disabled"],
		});
		this.reconcile();
	}

	private reconcile(): void {
		for (const [element, original] of this.originals) {
			if (!this.container.contains(element)) {
				this.restore(element, original);
				this.originals.delete(element);
			}
		}
		for (const element of Array.from(this.container.querySelectorAll<HTMLElement>("input.task-list-item-checkbox, .inline-title"))) {
			// An embedded note has its own access policy.
			if (element.closest(".markdown-embed")) continue;
			const attribute = element.matches(".inline-title") ? "contenteditable" : "disabled";
			if (!this.originals.has(element)) {
				this.originals.set(element, { attribute, value: element.getAttribute(attribute) });
			}
			const value = attribute === "contenteditable" ? "false" : "";
			if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
		}
	}

	private restore(element: HTMLElement, original: { attribute: string; value: string | null }): void {
		if (original.value === null) element.removeAttribute(original.attribute);
		else element.setAttribute(original.attribute, original.value);
	}

	destroy(): void {
		this.observer?.disconnect();
		this.observer = undefined;
		this.container.removeEventListener?.("click", this.blockCheckbox, true);
		for (const [element, original] of this.originals) this.restore(element, original);
		this.originals.clear();
	}
}
