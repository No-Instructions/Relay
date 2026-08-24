import { App, Modal } from "obsidian";

export class GenericSuggestModal<T> extends Modal {
	private component?: { $destroy(): void };

	constructor(
		app: App,
		private ComponentClass: new (options: { target: Element; props: Record<string, unknown> }) => { $destroy(): void },
		private componentProps: Record<string, unknown>,
		private onSelect: (item: T) => void,
	) {
		super(app);
	}

	onOpen() {
		const { modalEl } = this;

		// Find the modal container and hide the modal wrapper
		const modalContainer = modalEl.closest(".modal-container");
		modalEl.addClass("relay-hidden-modal-wrapper");
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
		this.onSelect = null as unknown as typeof this.onSelect;
		this.componentProps = null as unknown as typeof this.componentProps;
		this.ComponentClass = null as unknown as typeof this.ComponentClass;
	}
}
