import { App, Modal } from "obsidian";
import ReleaseManagerContent from "../components/ReleaseManagerContent.svelte";
import type Live from "../main";

export class ReleaseManager extends Modal {
	private component?: ReleaseManagerContent;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new ReleaseManagerContent({
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