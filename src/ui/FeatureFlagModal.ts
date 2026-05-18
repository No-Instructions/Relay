import { App, Modal } from "obsidian";
import FeatureFlagModalContent from "../components/FeatureFlagModalContent.svelte";

export class FeatureFlagToggleModal extends Modal {
	private component?: FeatureFlagModalContent;

	constructor(app: App) {
		super(app);
		this.setTitle("Feature flags");
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new FeatureFlagModalContent({
			target: contentEl,
			props: {
				close: () => this.close(),
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
	}
}
