import { Modal, App } from "obsidian";
import SyncQueueModalContent from "../components/SyncQueueModalContent.svelte";
import type { BackgroundSync } from "../BackgroundSync";
import type { SharedFolders } from "../SharedFolder";

export class SyncQueueModal extends Modal {
	private component?: SyncQueueModalContent;

	constructor(
		app: App,
		private readonly backgroundSync: BackgroundSync,
		private readonly sharedFolders: SharedFolders,
		private readonly focusedFolderGuid?: string,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.component = new SyncQueueModalContent({
			target: contentEl,
			props: {
				backgroundSync: this.backgroundSync,
				sharedFolders: this.sharedFolders,
				focusedFolderGuid: this.focusedFolderGuid,
				closeModal: () => this.close(),
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
	}
}
