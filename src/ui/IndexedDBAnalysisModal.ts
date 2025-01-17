import { App, Modal } from "obsidian";
import IndexedDBAnalysisModalContent from "../components/IndexedDBAnalysisModalContent.svelte";
import type Live from "../main";

export class IndexedDBAnalysisModal extends Modal {
	private component?: IndexedDBAnalysisModalContent;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new IndexedDBAnalysisModalContent({
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
