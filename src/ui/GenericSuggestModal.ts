import { App, Modal } from "obsidian";

export class GenericSuggestModal<T> extends Modal {
	private component?: any;

	constructor(
		app: App,
		private ComponentClass: any,
		private componentProps: any,
		private onSelect: (item: T) => void,
	) {
		super(app);
	}

	onOpen() {
		const { modalEl } = this;

		// Find the modal container and hide the modal wrapper
		const modalContainer = modalEl.closest(".modal-container");
		modalEl.style.display = "none";
		const contentEl = modalContainer || modalEl;

		this.component = new this.ComponentClass({
			target: contentEl,
			props: {
				...this.componentProps,
				autofocus: true,
				onSelect: (item: T) => {
					this.onSelect(item);
					this.close();
				},
			},
		});
	}

	onClose() {
		this.component?.$destroy();
	}

	destroy() {
		this.onSelect = null as any;
		this.componentProps = null as any;
		this.ComponentClass = null as any;
	}
}
