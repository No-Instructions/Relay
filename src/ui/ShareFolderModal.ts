import { App, Modal } from "obsidian";
import type { Relay } from "src/Relay";
import type { SharedFolder, SharedFolders } from "src/SharedFolder";
import type { RelayManager } from "src/RelayManager";
import ShareFolderModalContent from "../components/ShareFolderModalContent.svelte";

export class ShareFolderModal extends Modal {
	private component?: ShareFolderModalContent;

	constructor(
		app: App,
		private relay: Relay,
		private sharedFolders: SharedFolders,
		private relayManager: RelayManager,
		private onConfirm: (
			folderPath: string,
			folderName: string,
			isPrivate: boolean,
			userIds: string[],
		) => Promise<SharedFolder>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new ShareFolderModalContent({
			target: contentEl,
			props: {
				app: this.app,
				relay: this.relay,
				relayManager: this.relayManager,
				sharedFolders: this.sharedFolders,
				onConfirm: async (
					folderPath: string,
					folderName: string,
					isPrivate: boolean,
					userIds: string[],
				) => {
					const result = await this.onConfirm(
						folderPath,
						folderName,
						isPrivate,
						userIds,
					);
					this.close();
					return result;
				},
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
	}

	destroy() {
		this.relay = null as any;
		this.sharedFolders = null as any;
		this.relayManager = null as any;
		this.onConfirm = null as any;
	}
}
