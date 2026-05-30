import { App, Modal, Notice } from "obsidian";
import type { SharedFolder } from "../SharedFolder";
import type { IgnoredRemoteEntry } from "../ignoredFolderPolicy";

export class IgnoredRemoteEntriesModal extends Modal {
	private entries: IgnoredRemoteEntry[];

	constructor(
		app: App,
		private sharedFolder: SharedFolder,
	) {
		super(app);
		this.entries = sharedFolder.getIgnoredRemoteEntries();
		this.setTitle("Ignored remote entries");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("p", {
			text: `${this.entries.length} remote entr${this.entries.length === 1 ? "y" : "ies"} match the ignored folder name "${this.sharedFolder.getIgnoredFolderName()}". Cleanup removes Relay metadata only. Local files are not deleted, trashed, moved, or rewritten.`,
		});

		const list = contentEl.createEl("ul");
		for (const entry of this.entries) {
			list.createEl("li", {
				text: `${entry.path} (${entry.type})`,
			});
		}

		const controls = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = controls.createEl("button", { text: "Cancel" });
		cancel.onClickEvent(() => this.close());

		const clean = controls.createEl("button", {
			text: "Remove Relay metadata",
			cls: "mod-destructive",
		});
		clean.onClickEvent(() => {
			const removed = this.sharedFolder.cleanupIgnoredRemoteEntries(this.entries);
			new Notice(`Removed ${removed} ignored remote entr${removed === 1 ? "y" : "ies"}.`);
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
