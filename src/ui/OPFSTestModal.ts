import { App, Modal } from "obsidian";
import OPFSTestModalContent from "../components/OPFSTestModalContent.svelte";
import type Live from "../main";

export class OPFSTestModal extends Modal {
	private component?: OPFSTestModalContent;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new OPFSTestModalContent({
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