import { Modal, type App } from "obsidian";

/**
 * Notice shown for a document with read-only access that carries preserved
 * local edits (a fork from a write-capable session). Offers to compare the
 * preserved edits against the shared version or discard them; closing keeps
 * the fork intact for a later promotion.
 */
export class PreservedEditsModal extends Modal {
	constructor(
		app: App,
		private options: {
			fileName: string;
			onCompare: () => void;
			onDiscard: () => void;
		},
	) {
		super(app);
	}

	onOpen() {
		const { contentEl, titleEl } = this;
		titleEl.setText("Local edits held");
		contentEl.createEl("p", {
			text:
				`Relay is keeping earlier edits to "${this.options.fileName}" ` +
				`separately while this file follows the shared version. Keep them ` +
				`to restore when you can write, or revert them now.`,
		});

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const keep = buttons.createEl("button", {
			text: "Keep edits to restore",
			cls: "mod-cta",
		});
		keep.addEventListener("click", () => {
			this.close();
		});

		const compare = buttons.createEl("button", { text: "Review local edits" });
		compare.addEventListener("click", () => {
			this.close();
			this.options.onCompare();
		});

		const discard = buttons.createEl("button", {
			text: "Revert local edits",
			cls: "mod-warning",
		});
		discard.addEventListener("click", () => {
			this.close();
			this.options.onDiscard();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
