import { App, Modal } from "obsidian";
import FeatureFlagModalContent from "../components/FeatureFlagModalContent.svelte";

export class FeatureFlagToggleModal extends Modal {
	private component?: FeatureFlagModalContent;

	constructor(
		app: App,
		private reload: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = new FeatureFlagModalContent({
			target: contentEl,
			props: {
				reload: this.reload,
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		this.component?.$destroy();
	}
}
