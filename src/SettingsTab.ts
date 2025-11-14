/**
 * Settings Tab for the Relay plugin
 * 
 * Simplified to only include control plane URL and relay ID configuration.
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import type RelayPlugin from './main';

export class RelaySettingsTab extends PluginSettingTab {
  plugin: RelayPlugin;

  constructor(app: App, plugin: RelayPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Relay Settings' });

    // Control Plane URL
    new Setting(containerEl)
      .setName('Control Plane URL')
      .setDesc('URL of your self-hosted control plane (e.g., https://control.example.com)')
      .addText(text => text
        .setPlaceholder('https://control.example.com')
        .setValue(this.plugin.settings.controlPlaneUrl)
        .onChange(async (value) => {
          this.plugin.settings.controlPlaneUrl = value;
          await this.plugin.saveSettings();
          this.plugin.endpointManager.updateSettings({ controlPlaneUrl: value });
        }));

    // Relay ID
    new Setting(containerEl)
      .setName('Relay ID')
      .setDesc('The ID of the relay to use for collaboration (from your control plane dashboard)')
      .addText(text => text
        .setPlaceholder('relay-id-from-dashboard')
        .setValue(this.plugin.settings.relayId)
        .onChange(async (value) => {
          this.plugin.settings.relayId = value;
          await this.plugin.saveSettings();
          this.plugin.endpointManager.updateSettings({ relayId: value });
        }));

    // Authentication section
    containerEl.createEl('h3', { text: 'Authentication' });

    const authStatus = this.plugin.loginManager.isAuthenticated()
      ? '✅ Signed in'
      : '❌ Not signed in';

    new Setting(containerEl)
      .setName('Status')
      .setDesc(authStatus)
      .addButton(button => {
        if (this.plugin.loginManager.isAuthenticated()) {
          button
            .setButtonText('Sign Out')
            .onClick(async () => {
              await this.plugin.loginManager.logout();
              this.display(); // Refresh the settings display
            });
        } else {
          button
            .setButtonText('Sign In')
            .setCta()
            .onClick(async () => {
              try {
                await this.plugin.loginManager.login();
                this.display(); // Refresh the settings display
              } catch (error) {
                console.error('Login failed:', error);
              }
            });
        }
      });

    // Debug section
    containerEl.createEl('h3', { text: 'Debug' });

    new Setting(containerEl)
      .setName('Clear Token Cache')
      .setDesc('Clear cached tokens (use if experiencing authentication issues)')
      .addButton(button => button
        .setButtonText('Clear Cache')
        .onClick(() => {
          this.plugin.tokenStore.clearCache();
          this.plugin.tokenStore.cleanExpiredTokens();
        }));
  }
}
