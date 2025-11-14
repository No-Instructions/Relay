/**
 * Simplified Login Manager for OIDC-only authentication
 * 
 * This replaces the original LoginManager which supported multiple providers.
 * Now only supports OpenID Connect (Keycloak) authentication.
 */

import { App, Notice } from 'obsidian';
import { EndpointManager } from './EndpointManager';

export interface AuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export class LoginManager {
  private app: App;
  private endpointManager: EndpointManager;
  private authToken: AuthToken | null = null;
  private callbackResolver: ((token: AuthToken) => void) | null = null;
  private callbackRejecter: ((error: Error) => void) | null = null;

  constructor(app: App, endpointManager: EndpointManager) {
    this.app = app;
    this.endpointManager = endpointManager;
    
    // Register the obsidian:// protocol handler for OAuth callback
    this.registerProtocolHandler();
  }

  /**
   * Register the Obsidian protocol handler for OAuth callbacks
   */
  private registerProtocolHandler(): void {
    this.app.registerObsidianProtocolHandler('relay-callback', async (params) => {
      try {
        const code = params.code;
        const error = params.error;

        if (error) {
          const errorMsg = params.error_description || error;
          this.handleCallbackError(new Error(`OAuth error: ${errorMsg}`));
          return;
        }

        if (!code) {
          this.handleCallbackError(new Error('No authorization code received'));
          return;
        }

        // Exchange code for token
        await this.exchangeCodeForToken(code);
      } catch (error) {
        this.handleCallbackError(error as Error);
      }
    });
  }

  /**
   * Exchange authorization code for access token
   */
  private async exchangeCodeForToken(code: string): Promise<void> {
    try {
      const response = await fetch(`${this.endpointManager.getAuthUrl()}/api/oauth/callback?code=${code}`, {
        method: 'GET',
        credentials: 'include', // Important for session cookies
      });

      if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.statusText}`);
      }

      // The control plane sets a session cookie, so we don't need to store the token
      // We just need to verify we're authenticated
      const userInfo = await this.fetchUserInfo();
      
      const authToken: AuthToken = {
        accessToken: 'session', // Using session cookies instead
        expiresAt: Date.now() + 3600000, // 1 hour
      };

      this.authToken = authToken;
      await this.saveToken(authToken);

      if (this.callbackResolver) {
        this.callbackResolver(authToken);
        this.callbackResolver = null;
        this.callbackRejecter = null;
      }

      new Notice('Successfully signed in!');
    } catch (error) {
      throw new Error(`Failed to exchange code for token: ${error.message}`);
    }
  }

  /**
   * Fetch user info to verify authentication
   */
  private async fetchUserInfo(): Promise<any> {
    const response = await fetch(`${this.endpointManager.getApiUrl()}/whoami`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to fetch user info');
    }

    return await response.json();
  }

  /**
   * Handle callback errors
   */
  private handleCallbackError(error: Error): void {
    console.error('OAuth callback error:', error);
    new Notice(`Sign in failed: ${error.message}`);
    
    if (this.callbackRejecter) {
      this.callbackRejecter(error);
      this.callbackResolver = null;
      this.callbackRejecter = null;
    }
  }

  /**
   * Initiate login flow
   */
  async login(): Promise<AuthToken> {
    return new Promise((resolve, reject) => {
      this.callbackResolver = resolve;
      this.callbackRejecter = reject;

      // Open the login URL in the system browser
      const loginUrl = this.endpointManager.getLoginUrl();
      window.open(loginUrl);

      new Notice('Opening sign in page in your browser...');

      // Set a timeout for the login process
      setTimeout(() => {
        if (this.callbackResolver) {
          this.callbackRejecter?.(new Error('Login timeout'));
          this.callbackResolver = null;
          this.callbackRejecter = null;
        }
      }, 300000); // 5 minute timeout
    });
  }

  /**
   * Logout
   */
  async logout(): Promise<void> {
    try {
      await fetch(`${this.endpointManager.getApiUrl()}/auth.logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      console.error('Logout error:', error);
    }

    this.authToken = null;
    await this.clearToken();
    new Notice('Signed out successfully');
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    if (!this.authToken) {
      return false;
    }

    // Check if token is expired
    if (this.authToken.expiresAt < Date.now()) {
      this.authToken = null;
      return false;
    }

    return true;
  }

  /**
   * Get the current auth token
   */
  getToken(): AuthToken | null {
    return this.authToken;
  }

  /**
   * Save token to local storage
   */
  private async saveToken(token: AuthToken): Promise<void> {
    // In Obsidian, we can use the plugin's data storage
    // This is a placeholder - actual implementation would use the plugin's save method
    localStorage.setItem('relay_auth_token', JSON.stringify(token));
  }

  /**
   * Load token from local storage
   */
  async loadToken(): Promise<void> {
    try {
      const tokenStr = localStorage.getItem('relay_auth_token');
      if (tokenStr) {
        const token = JSON.parse(tokenStr) as AuthToken;
        
        // Check if token is still valid
        if (token.expiresAt > Date.now()) {
          this.authToken = token;
        } else {
          await this.clearToken();
        }
      }
    } catch (error) {
      console.error('Failed to load auth token:', error);
      await this.clearToken();
    }
  }

  /**
   * Clear token from storage
   */
  private async clearToken(): Promise<void> {
    localStorage.removeItem('relay_auth_token');
  }
}
