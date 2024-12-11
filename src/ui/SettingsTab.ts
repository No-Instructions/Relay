"use strict";

import { App, PluginSettingTab } from "obsidian";
import Live from "src/main";
import PluginSettings from "src/components/PluginSettings.svelte";

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
		this.plugin.relayManager.update();
		this.component = new PluginSettings({
			target: this.targetEl,
			props: {
				plugin: this.plugin,
				close: () => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					(this as any).setting.close();
				},
			},
		});
	}

	navigateTo(path: string) {
		this.component?.$set({
			path: path,
		});
	}

	hide(): void {
		try {
			this.component?.$destroy();
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			//(this as any).setting.close();
		} catch (e) {
			console.warn(e);
		}
	}

	destroy() {
		this.hide();
		this.plugin = null as any;
	}
}
