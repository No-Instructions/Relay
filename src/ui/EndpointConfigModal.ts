import { App, Modal } from "obsidian";
import EndpointConfigModalContent from "../components/EndpointConfigModalContent.svelte";
import type Live from "../main";

export class EndpointConfigModal extends Modal {
	private component?: EndpointConfigModalContent;

	constructor(
		app: App,
		private plugin: Live,
		private reload: () => void,
	) {
		super(app);
		this.setTitle("Enterprise Tenant Configuration");
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new EndpointConfigModalContent({
			target: contentEl,
			props: {
				plugin: this.plugin,
				reload: this.reload,
			},
		});

		// Listen for close event from component
		this.component.$on("close", () => {
			this.close();
		});

		// Listen for apply event from component
		this.component.$on("apply", () => {
			this.close();
			// Reload the plugin to apply changes
			setTimeout(() => {
				this.reload();
			}, 100);
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
	}
}