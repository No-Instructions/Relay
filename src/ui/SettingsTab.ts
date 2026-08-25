"use strict";

import { App, PluginSettingTab } from "obsidian";
import Live from "src/main";
import PluginSettings from "src/components/PluginSettings.svelte";
import { mountComponent, type MountedComponent } from "src/ui/svelteHost.svelte";

export class LiveSettingsTab extends PluginSettingTab {
	plugin: Live;
	component?: MountedComponent;
	targetEl!: HTMLElement;
	constructor(app: App, plugin: Live) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		this.targetEl = containerEl.parentElement as HTMLElement;
		this.targetEl.empty();
		void this.plugin.relayManager.update();
		this.component = mountComponent(PluginSettings, {
			target: this.targetEl,
			props: {
				plugin: this.plugin,
				close: () => {
					(
						this as Partial<{
							setting: { close(): void };
						}>
					).setting!.close();
				},
			},
		});
	}

	navigateTo(path: string) {
		this.component?.set({
			path: path,
		});
	}

	hide(): void {
		try {
			this.component?.destroy();
			//(this as any).setting.close();
		} catch (e) {
			console.warn(e);
		}
	}

	destroy() {
		this.hide();
		this.plugin = null as unknown as typeof this.plugin;
	}
}
