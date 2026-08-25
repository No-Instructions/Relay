import { App, Modal } from "obsidian";
import type { RemoteSharedFolder, Role } from "src/Relay";
import type { RelayManager } from "src/RelayManager";
import UserSelectModalContent from "../components/UserSelectModalContent.svelte";
import { mountComponent, type MountedComponent } from "./svelteHost.svelte";

export class UserSelectModal extends Modal {
	private component?: MountedComponent;

	constructor(
		app: App,
		private relayManager: RelayManager,
		private folder: RemoteSharedFolder,
		private onAdd: (userIds: string[], role: Role) => Promise<void>,
		private preSelectedUserIds?: string[],
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = mountComponent(UserSelectModalContent, {
			target: contentEl,
			props: {
				relayManager: this.relayManager,
				folder: this.folder,
				preSelectedUserIds: this.preSelectedUserIds,
				onAdd: async (userIds: string[], role: Role) => {
					await this.onAdd(userIds, role);
					this.close();
				},
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.destroy();
	}
}