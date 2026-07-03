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
		titleEl.setText("Local edits preserved");
		contentEl.createEl("p", {
			text:
				`You have edits to "${this.options.fileName}" that are not shared ` +
				`because your access is read-only. They are preserved on this ` +
				`device and will sync automatically if you regain write access.`,
		});

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });

		const compare = buttons.createEl("button", { text: "Compare" });
		compare.addEventListener("click", () => {
			this.close();
			this.options.onCompare();
		});

		const discard = buttons.createEl("button", {
			text: "Discard local edits",
			cls: "mod-warning",
		});
		discard.addEventListener("click", () => {
			this.close();
			this.options.onDiscard();
		});

		const keep = buttons.createEl("button", {
			text: "Keep for later",
			cls: "mod-cta",
		});
		keep.addEventListener("click", () => {
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
