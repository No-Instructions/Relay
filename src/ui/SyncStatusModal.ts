import { App, Modal } from "obsidian";
import SyncStatusModalContent from "../components/SyncStatusModalContent.svelte";
import type { SharedFolder } from "../SharedFolder";
import type { TimeProvider } from "../TimeProvider";

export class SyncStatusModal extends Modal {
	private component?: SyncStatusModalContent;

	constructor(
		app: App,
		private sharedFolder: SharedFolder,
		private timeProvider: TimeProvider,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText(`Sync Status: ${this.sharedFolder.name}`);

		this.component = new SyncStatusModalContent({
			target: contentEl,
			props: {
				sharedFolder: this.sharedFolder,
				app: this.app,
				timeProvider: this.timeProvider,
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
	}
}
