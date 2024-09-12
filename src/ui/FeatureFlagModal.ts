import { App, Modal } from "obsidian";
import FeatureFlagModalContent from "../components/FeatureFlagModalContent.svelte";

export class FeatureFlagToggleModal extends Modal {
	private component?: FeatureFlagModalContent;

	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new FeatureFlagModalContent({
			target: contentEl,
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
	}
}
