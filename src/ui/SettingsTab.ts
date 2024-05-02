import { App, PluginSettingTab } from "obsidian";
import Live from "src/main";
import PluginSettings from "src/components/PluginSettings.svelte";
import store from "src/Store";

export class LiveSettingsTab extends PluginSettingTab {
	plugin: Live;
	component?: PluginSettings;
	constructor(app: App, plugin: Live) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		const targetEl = containerEl.parentElement as HTMLElement;
		targetEl.empty();
		store.plugin.set(this.plugin);
		this.component = new PluginSettings({
			target: targetEl,
			props: {},
		});
	}

	hide(): void {
		this.component?.$destroy();
	}
}
