import { App, Modal } from "obsidian";
import FeatureFlagModalContent from "../components/FeatureFlagModalContent.svelte";
import { mountComponent, type MountedComponent } from "./svelteHost.svelte";

export class FeatureFlagToggleModal extends Modal {
	private component?: MountedComponent;

	constructor(app: App) {
		super(app);
		this.setTitle("Feature flags");
	}

	onOpen() {
		const { contentEl } = this;

		this.component = mountComponent(FeatureFlagModalContent, {
			target: contentEl,
			props: {
				close: () => this.close(),
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.destroy();
	}
}
