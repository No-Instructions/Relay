import { Modal, type App } from "obsidian";

/**
 * Asks for a new name, starting from the current one with its stem
 * selected. Resolves with the new name, or null when the prompt is
 * cancelled or submitted unchanged.
 */
export class RenamePrompt extends Modal {
	private resolve?: (name: string | null) => void;
	private value: string;

	constructor(
		app: App,
		private options: { name: string; kind: "file" | "folder" },
	) {
		super(app);
		this.value = options.name;
	}

	prompt(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen() {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("relay-rename-prompt");
		titleEl.setText(`Rename ${this.options.kind}`);
		const input = contentEl.createEl("input", {
			type: "text",
			value: this.options.name,
			attr: { "aria-label": "New name" },
		});
		input.addEventListener("input", () => {
			this.value = input.value;
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.submit();
			}
		});
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const rename = buttons.createEl("button", { text: "Rename", cls: "mod-cta" });
		rename.addEventListener("click", () => this.submit());
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		input.focus();
		const stem = this.options.name.replace(/\.[^.]+$/, "");
		input.setSelectionRange(0, this.options.kind === "file" ? stem.length : this.options.name.length);
	}

	private submit() {
		const next = this.value.trim();
		this.settle(next && next !== this.options.name ? next : null);
		this.close();
	}

	private settle(name: string | null) {
		this.resolve?.(name);
		this.resolve = undefined;
	}

	onClose() {
		this.settle(null);
		this.contentEl.empty();
	}
}
