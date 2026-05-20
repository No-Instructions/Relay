import { App, Modal, Notice } from "obsidian";
import EndpointConfigModalContent from "../components/EndpointConfigModalContent.svelte";
import type Live from "../main";

export class EndpointConfigModal extends Modal {
	private component?: EndpointConfigModalContent;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
		this.setTitle("Enterprise tenant configuration");
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new EndpointConfigModalContent({
			target: contentEl,
			props: {
				plugin: this.plugin,
			},
		});

		// Listen for close event from component
		this.component.$on("close", () => {
			this.close();
		});

		// Listen for apply event from component
		this.component.$on("apply", () => {
			this.close();
			new Notice("Reload the Relay plugin to apply endpoint changes.", 8000);
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
	}
}
