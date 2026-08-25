import { App, Modal } from "obsidian";
import BugReportModalContent from "../components/BugReportModalContent.svelte";
import { mountComponent, type MountedComponent } from "./svelteHost.svelte";
import type Live from "../main";

export class BugReportModal extends Modal {
	private component?: MountedComponent;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = mountComponent(BugReportModalContent, {
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
