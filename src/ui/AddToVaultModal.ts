import { App, Modal } from "obsidian";
import type { RemoteSharedFolder } from "src/Relay";
import AddToVaultModalContent from "../components/AddToVaultModalContent.svelte";
import type { SharedFolder, SharedFolders } from "src/SharedFolder";

export class AddToVaultModal extends Modal {
	private component?: AddToVaultModalContent;

	constructor(
		app: App,
		private sharedFolders: SharedFolders,
		public remoteFolder: RemoteSharedFolder | undefined,
		private availableFolders: RemoteSharedFolder[],
		private onConfirm: (
			remoteFolder: RemoteSharedFolder,
			folderName: string,
			folderLocation: string,
		) => Promise<SharedFolder>,
	) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new AddToVaultModalContent({
			target: contentEl,
			props: {
				remoteFolder: this.remoteFolder,
				availableFolders: this.availableFolders,
				sharedFolders: this.sharedFolders,
				onConfirm: async (
					remoteFolder: RemoteSharedFolder,
					folderName: string,
					folderLocation: string,
				) => {
					await this.onConfirm(remoteFolder, folderName, folderLocation);
					this.close();
				},
				app: this.app,
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
		this.onConfirm = null as any;
		this.sharedFolders = null as any;
		this.remoteFolder = undefined;
		this.availableFolders.length = 0;
	}
}
