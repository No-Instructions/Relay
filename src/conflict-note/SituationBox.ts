import { setIcon } from "obsidian";

export interface SituationAction {
	label: string;
	warning?: boolean;
	primary?: boolean;
	run(): void;
}

/** The note-level explanation and whole-note actions shared by review surfaces. */
export class SituationBox {
	readonly element: HTMLDivElement;
	readonly body: HTMLDivElement;
	private readonly buttons: HTMLButtonElement[];
	private readonly status: HTMLSpanElement;

	constructor(host: HTMLElement, copy: { title: string; text: string; status: string }, actions: SituationAction[], onClose?: () => void) {
		this.element = host.createDiv({ cls: "relay-conflict-box" });
		const head = this.element.createDiv({ cls: "relay-conflict-head", attr: onClose ? {} : { role: "button", tabindex: "0", "aria-label": copy.title, "aria-expanded": "true" } });
		if (!onClose) setIcon(head.createSpan({ cls: "relay-conflict-chevron" }), "chevron-down");
		head.createDiv({ cls: "relay-conflict-title", text: copy.title });
		this.status = head.createSpan({ cls: "relay-conflict-status", text: copy.status });
		this.body = this.element.createDiv({ cls: "relay-conflict-body" });
		this.body.createEl("p", { cls: "relay-conflict-text", text: copy.text });
		const options = this.body.createDiv({ cls: "relay-conflict-options" });
		this.buttons = actions.map(action => {
			const button = options.createEl("button", { text: action.label, attr: { type: "button" } });
			if (action.warning) button.addClass("mod-warning");
			if (action.primary) button.addClass("mod-cta");
			button.addEventListener("click", () => action.run());
			return button;
		});
		if (onClose) {
			this.element.addClass("is-dismissible");
			const close = head.createEl("button", { cls: "clickable-icon relay-conflict-close", attr: { type: "button", "aria-label": "Close review" } });
			setIcon(close, "x");
			this.buttons.push(close);
			close.addEventListener("click", onClose);
			return;
		}
		const toggle = () => {
			const collapsed = this.element.classList.toggle("is-collapsed");
			head.setAttribute("aria-expanded", String(!collapsed));
		};
		head.addEventListener("click", toggle);
		head.addEventListener("keydown", event => {
			if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
		});
	}

	setBusy(busy: boolean): void { for (const button of this.buttons) button.disabled = busy; }
	setStatus(status: string): void { this.status.setText(status); }
	destroy(): void { this.element.remove(); }
}
