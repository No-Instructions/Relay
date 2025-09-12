import { App, Modal } from "obsidian";
import SelfHostModalContent from "../components/SelfHostModalContent.svelte";
import type { RelayManager } from "../RelayManager";
import type { Relay } from "../Relay";

export class SelfHostModal extends Modal {
	private component?: SelfHostModalContent;

	constructor(
		app: App,
		private relayManager: RelayManager,
		private onSuccess: (relay: Relay) => void,
	) {
		super(app);
		this.setTitle("Self Host Relay Server");
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new SelfHostModalContent({
			target: contentEl,
			props: {
				relayManager: this.relayManager,
				onConfirm: async (
					url?: string,
					providerId?: string,
					organizationId?: string,
				) => {
					const relay = await this.relayManager.createSelfHostedRelay(
						url,
						providerId,
						organizationId,
					);
					this.close();
					this.onSuccess(relay);
				},
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
	}
}
