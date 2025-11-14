/**
 * Token Store for requesting tokens from the control plane
 * 
 * This replaces the original LiveTokenStore which requested tokens from System3.
 * Now requests tokens from the self-hosted control plane.
 */

import { EndpointManager } from './EndpointManager';
import { LoginManager } from './LoginManager';

export interface ClientToken {
  url: string;
  baseUrl?: string;
  docId: string;
  token: string;
  authorization: 'full' | 'read-only';
  expiryTime?: number;
  contentType?: number;
  contentLength?: number;
  fileHash?: number;
}

export class TokenStore {
  private endpointManager: EndpointManager;
  private loginManager: LoginManager;
  private tokenCache: Map<string, ClientToken> = new Map();

  constructor(endpointManager: EndpointManager, loginManager: LoginManager) {
    this.endpointManager = endpointManager;
    this.loginManager = loginManager;
  }

  /**
   * Request a document token from the control plane
   */
  async requestToken(docId: string, folder: string): Promise<ClientToken> {
    // Check cache first
    const cacheKey = `doc:${docId}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiryTime && cached.expiryTime > Date.now() + 60000) {
      return cached;
    }

    // Ensure user is authenticated
    if (!this.loginManager.isAuthenticated()) {
      throw new Error('Not authenticated. Please sign in first.');
    }

    const relayId = this.endpointManager.getRelayId();
    if (!relayId) {
      throw new Error('No relay configured. Please set a relay ID in settings.');
    }

    try {
      const response = await fetch(`${this.endpointManager.getApiUrl()}/token.generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include', // Important for session cookies
        body: JSON.stringify({
          docId,
          relay: relayId,
          folder,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token request failed: ${error}`);
      }

      const data = await response.json();
      const token = data.result.data as ClientToken;

      // Cache the token
      this.tokenCache.set(cacheKey, token);

      return token;
    } catch (error) {
      console.error('Token request error:', error);
      throw new Error(`Failed to request token: ${error.message}`);
    }
  }

  /**
   * Request a file token from the control plane
   */
  async requestFileToken(
    hash: string,
    docId: string,
    folder: string,
    contentType?: string,
    contentLength?: number
  ): Promise<ClientToken> {
    // Check cache first
    const cacheKey = `file:${hash}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiryTime && cached.expiryTime > Date.now() + 60000) {
      return cached;
    }

    // Ensure user is authenticated
    if (!this.loginManager.isAuthenticated()) {
      throw new Error('Not authenticated. Please sign in first.');
    }

    const relayId = this.endpointManager.getRelayId();
    if (!relayId) {
      throw new Error('No relay configured. Please set a relay ID in settings.');
    }

    try {
      const response = await fetch(`${this.endpointManager.getApiUrl()}/token.generateFile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          hash,
          docId,
          relay: relayId,
          folder,
          contentType,
          contentLength,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`File token request failed: ${error}`);
      }

      const data = await response.json();
      const token = data.result.data as ClientToken;

      // Cache the token
      this.tokenCache.set(cacheKey, token);

      return token;
    } catch (error) {
      console.error('File token request error:', error);
      throw new Error(`Failed to request file token: ${error.message}`);
    }
  }

  /**
   * Clear the token cache
   */
  clearCache(): void {
    this.tokenCache.clear();
  }

  /**
   * Remove expired tokens from cache
   */
  cleanExpiredTokens(): void {
    const now = Date.now();
    for (const [key, token] of this.tokenCache.entries()) {
      if (token.expiryTime && token.expiryTime < now) {
        this.tokenCache.delete(key);
      }
    }
  }
}
