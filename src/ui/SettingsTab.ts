"use strict";

import { App, PluginSettingTab } from "obsidian";
import Live from "src/main";
import PluginSettings from "src/components/PluginSettings.svelte";
import store from "src/Store";

export class LiveSettingsTab extends PluginSettingTab {
	plugin: Live;
	component?: PluginSettings;
	targetEl!: HTMLElement;
	constructor(app: App, plugin: Live) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		this.targetEl = containerEl.parentElement as HTMLElement;
		this.targetEl.empty();
		store.plugin.set(this.plugin);
		this.plugin.relayManager.update();
		this.component = new PluginSettings({
			target: this.targetEl,
			props: {
				plugin: this.plugin,
				close: () => {
					this.closeModal();
				},
			},
		});
	}

	closeModal() {
		const modal = this.targetEl.closest(".modal");
		console.log(modal);
		// @ts-ignore
		//modal?.prototype.close();
	}

	hide(): void {
		try {
			this.component?.$destroy();
		} catch (e) {
			console.error(e);
		}
	}
}
