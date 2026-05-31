import { App, Modal, Notice } from "obsidian";
import type { SharedFolder } from "../SharedFolder";
import type { IgnoredRemoteEntry } from "../ignoredFolderPolicy";

export class IgnoredRemoteEntriesModal extends Modal {
	private entries: IgnoredRemoteEntry[];

	constructor(
		app: App,
		private sharedFolder: SharedFolder,
		entries?: IgnoredRemoteEntry[],
	) {
		super(app);
		this.entries = entries ?? sharedFolder.getIgnoredRemoteEntries();
		this.setTitle("Remove ignored Relay entries");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("p", {
			text: `${this.entries.length} remote Relay entr${this.entries.length === 1 ? "y" : "ies"} are already synced under this .relayignore folder. Removing them deletes the subtree from the Relay server, preserves local files on this device, and may appear as remote deletions on other devices.`,
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
