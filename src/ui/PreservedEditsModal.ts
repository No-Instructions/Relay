import { Modal, type App } from "obsidian";
import { getDocsUrl, openDocs } from "../documentationLinks";

/**
 * Offers to compare or discard the edits a read-only document preserves;
 * closing keeps them for a later promotion.
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

		const docsLink = contentEl.createEl("p").createEl("a", {
			text: "Learn more about read-only access",
			cls: "relay-preserved-edits-docs",
			attr: {
				href: getDocsUrl("read-only-content-stashed"),
				target: "_blank",
				rel: "noopener noreferrer",
			},
		});
		docsLink.addEventListener("click", (event) => openDocs("read-only-content-stashed", event));

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
