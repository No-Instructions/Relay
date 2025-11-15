/**
 * Simplified Endpoint Manager for self-hosted control plane
 * 
 * This replaces the original EndpointManager which had hardcoded System3 endpoints.
 * All endpoints now point to the self-hosted control plane.
 */

export interface RelaySettings {
  controlPlaneUrl: string;
  relayId: string;
}

export class EndpointManager {
  private settings: RelaySettings;

  constructor(settings: RelaySettings) {
    this.settings = settings;
  }

  /**
   * Get the base URL for the control plane API
   */
  getApiUrl(): string {
    return `${this.settings.controlPlaneUrl}/api`;
  }

  /**
   * Get the authentication URL
   */
  getAuthUrl(): string {
    return this.settings.controlPlaneUrl;
  }

  /**
   * Get the OAuth/OIDC login URL
   */
  getLoginUrl(): string {
    const redirectUri = 'obsidian://relay-callback';
    return `${this.getAuthUrl()}/api/auth/oidc/login?redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  /**
   * Get the relay ID from settings
   */
  getRelayId(): string {
    return this.settings.relayId;
  }

  /**
   * Update settings
   */
  updateSettings(settings: Partial<RelaySettings>): void {
    this.settings = { ...this.settings, ...settings };
  }
}
