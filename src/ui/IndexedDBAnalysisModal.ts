import { App, Modal } from "obsidian";
import IndexedDBAnalysisModalContent from "../components/IndexedDBAnalysisModalContent.svelte";
import { mountComponent, type MountedComponent } from "./svelteHost.svelte";
import type Live from "../main";

export class IndexedDBAnalysisModal extends Modal {
	private component?: MountedComponent;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = mountComponent(IndexedDBAnalysisModalContent, {
			target: contentEl,
			props: {
				plugin: this.plugin,
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.destroy();
	}
}
