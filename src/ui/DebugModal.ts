import { App, Modal } from "obsidian";
import DebugModalContent from "../components/DebugModalContent.svelte";
import type Live from "../main";

export class DebugModal extends Modal {
	private component?: DebugModalContent;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new DebugModalContent({
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
