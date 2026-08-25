import { App, Modal } from "obsidian";
import type { Component } from "svelte";
import { mountComponent, type MountedComponent } from "./svelteHost.svelte";

export class GenericSuggestModal<T> extends Modal {
	private component?: MountedComponent;

	constructor(
		app: App,
		private content: Component<Record<string, unknown>>,
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

		this.component = mountComponent(this.content, {
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
		this.component?.destroy();
	}

	destroy() {
		this.onSelect = null as unknown as typeof this.onSelect;
		this.componentProps = null as unknown as typeof this.componentProps;
		this.content = null as unknown as typeof this.content;
	}
}
