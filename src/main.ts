/**
 * Obsidian Relay Plugin - Modified for Self-Hosted Control Plane
 * 
 * This is a simplified version of the original plugin that works with
 * a self-hosted control plane instead of System3's infrastructure.
 */

import { Plugin } from 'obsidian';
import { EndpointManager, RelaySettings } from './EndpointManager';
import { LoginManager } from './LoginManager';
import { TokenStore } from './TokenStore';
import { RelaySettingsTab } from './SettingsTab';

interface RelayPluginSettings extends RelaySettings {
  // Add any additional settings here
}

const DEFAULT_SETTINGS: RelayPluginSettings = {
  controlPlaneUrl: 'http://localhost:3000',
  relayId: '',
};

export default class RelayPlugin extends Plugin {
  settings: RelayPluginSettings;
  endpointManager: EndpointManager;
  loginManager: LoginManager;
  tokenStore: TokenStore;

  async onload() {
    console.log('Loading Relay plugin (self-hosted version)');

    // Load settings
    await this.loadSettings();

    // Initialize managers
    this.endpointManager = new EndpointManager(this.settings);
    this.loginManager = new LoginManager(this.app, this.endpointManager);
    this.tokenStore = new TokenStore(this.endpointManager, this.loginManager);

    // Load saved auth token
    await this.loginManager.loadToken();

    // Add settings tab
    this.addSettingTab(new RelaySettingsTab(this.app, this));

    // Add ribbon icon for quick login
    this.addRibbonIcon('cloud', 'Relay: Sign In', async () => {
      if (this.loginManager.isAuthenticated()) {
        await this.loginManager.logout();
      } else {
        await this.loginManager.login();
      }
    });

    // Add command for signing in
    this.addCommand({
      id: 'relay-sign-in',
      name: 'Sign In',
      callback: async () => {
        if (this.loginManager.isAuthenticated()) {
          console.log('Already signed in');
          return;
        }
        await this.loginManager.login();
      }
    });

    // Add command for signing out
    this.addCommand({
      id: 'relay-sign-out',
      name: 'Sign Out',
      callback: async () => {
        await this.loginManager.logout();
      }
    });

    // Add command to clear token cache
    this.addCommand({
      id: 'relay-clear-cache',
      name: 'Clear Token Cache',
      callback: () => {
        this.tokenStore.clearCache();
        console.log('Token cache cleared');
      }
    });

    // Periodically clean expired tokens
    this.registerInterval(
      window.setInterval(() => {
        this.tokenStore.cleanExpiredTokens();
      }, 60000) // Every minute
    );

    console.log('Relay plugin loaded successfully');
  }

  async onunload() {
    console.log('Unloading Relay plugin');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Get a document token for collaboration
   * This is the main method that other parts of the plugin will call
   */
  async getDocumentToken(docId: string, folder: string): Promise<string> {
    const token = await this.tokenStore.requestToken(docId, folder);
    return token.url;
  }

  /**
   * Get a file token for file uploads
   */
  async getFileToken(
    hash: string,
    docId: string,
    folder: string,
    contentType?: string,
    contentLength?: number
  ): Promise<string> {
    const token = await this.tokenStore.requestFileToken(
      hash,
      docId,
      folder,
      contentType,
      contentLength
    );
    return token.url;
  }
}
