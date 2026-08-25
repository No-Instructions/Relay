import { App, Modal, Notice } from "obsidian";
import EndpointConfigModalContent from "../components/EndpointConfigModalContent.svelte";
import { mountComponent, type MountedComponent } from "./svelteHost.svelte";
import type Live from "../main";

export class EndpointConfigModal extends Modal {
	private component?: MountedComponent;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
		this.setTitle("Enterprise tenant configuration");
	}

	onOpen() {
		const { contentEl } = this;

		this.component = mountComponent(EndpointConfigModalContent, {
			target: contentEl,
			props: {
				plugin: this.plugin,
				onClose: () => {
					this.close();
				},
				onApply: () => {
					this.close();
					new Notice("Reload the plugin to apply endpoint changes.", 8000);
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
