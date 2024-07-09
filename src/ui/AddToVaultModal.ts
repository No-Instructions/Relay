import { App, Modal } from "obsidian";
import type { RemoteSharedFolder } from "src/Relay";
import AddToVaultModalContent from "../components/AddToVaultModalContent.svelte";
import type { SharedFolders } from "src/SharedFolder";

export class AddToVaultModal extends Modal {
	private component?: AddToVaultModalContent;

	constructor(
		app: App,
		private sharedFolders: SharedFolders,
		public remoteFolder: RemoteSharedFolder,
		private onConfirm: (
			remoteFolder: RemoteSharedFolder,
			folderName: string,
			folderLocation: string
		) => void
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
				sharedFolders: this.sharedFolders,
				onConfirm: (
					remoteFolder: RemoteSharedFolder,
					folderName: string,
					folderLocation: string
				) => {
					this.onConfirm(remoteFolder, folderName, folderLocation);
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
	}
}
