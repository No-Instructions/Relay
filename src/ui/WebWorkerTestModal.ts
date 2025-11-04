import { App, Modal } from "obsidian";
import WebWorkerTestModalContent from "../components/WebWorkerTestModalContent.svelte";
import type Live from "../main";

export class WebWorkerTestModal extends Modal {
	private component?: WebWorkerTestModalContent;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new WebWorkerTestModalContent({
			target: contentEl,
			props: {
				plugin: this.plugin,
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
	}
}