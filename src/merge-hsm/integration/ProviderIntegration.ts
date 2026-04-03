/**
 * ProviderIntegration - YSweet/WebSocket Provider Integration for MergeHSM
 *
 * Bridges the MergeHSM with a Yjs provider (e.g., YSweetProvider):
 * - Subscribes to provider events and forwards to HSM
 * - Handles connection state changes
 * - Observes remoteDoc for updates
 */

import * as Y from 'yjs';
import type { MergeHSM } from '../MergeHSM';
import { curryLog } from '../../debug';

const providerError = curryLog("[ProviderIntegration]", "error");

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * Minimal interface for a Yjs provider.
 * Compatible with YSweetProvider, y-websocket, etc.
 */
export interface YjsProvider {
  on(event: 'sync', callback: () => void): void;
  on(event: 'connection-close' | 'disconnect', callback: () => void): void;
  on(event: 'connection-error', callback: (error: Error) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;
  connect(): void;
  disconnect(): void;
  destroy(): void;

  // Optional: for checking initial state
  synced?: boolean;
  connectionState?: { status: string };
}

// =============================================================================
// ProviderIntegration Class
// =============================================================================

export class ProviderIntegration {
  private hsm: MergeHSM;
  private remoteDoc: Y.Doc;
  private provider: YjsProvider;

  // Bound event handlers for cleanup
  private onSync: () => void;
  private onDisconnect: () => void;
  private onError: (error: Error) => void;
  private onRemoteUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(
    hsm: MergeHSM,
    remoteDoc: Y.Doc,
    provider: YjsProvider
  ) {
    this.hsm = hsm;
    this.remoteDoc = remoteDoc;
    this.provider = provider;

    // Create bound handlers
    this.onSync = this.handleSync.bind(this);
    this.onDisconnect = this.handleDisconnect.bind(this);
    this.onError = this.handleError.bind(this);
    this.onRemoteUpdate = this.handleRemoteUpdate.bind(this);

    // Subscribe to provider events
    this.provider.on('sync', this.onSync);
    this.provider.on('connection-close', this.onDisconnect);
    this.provider.on('connection-error', this.onError);

    // Observe remoteDoc for updates from provider
    this.remoteDoc.on('update', this.onRemoteUpdate);

    // Send initial state if already connected/synced
    // (in case ProviderIntegration is created after provider is already connected)
    if (provider.connectionState?.status === 'connected') {
      hsm.send({ type: 'CONNECTED' });
    }
    if (provider.synced) {
      hsm.send({ type: 'PROVIDER_SYNCED' });
    }
  }

  /**
   * Handle provider sync event (initial sync complete).
   *
   * Asserts that the provider actually delivered data into remoteDoc.
   * If remoteDoc's state vector is empty after sync, the provider lied
   * about being synced (BUG-123).
   */
  private handleSync(): void {
    const sv = Y.encodeStateVector(this.remoteDoc);
    if (sv.length <= 1) {
      // State vector is empty — no ops were delivered.
      // This should not happen if the provider truly synced.
      providerError(
        'PROVIDER_SYNCED fired but remoteDoc state vector is empty. ' +
        'The provider reported sync before delivering document data.'
      );
    }
    this.hsm.send({ type: 'PROVIDER_SYNCED' });
    this.hsm.send({ type: 'CONNECTED' });
  }

  /**
   * Handle provider disconnect event.
   */
  private handleDisconnect(): void {
    this.hsm.send({ type: 'DISCONNECTED' });
  }

  /**
   * Handle provider error event.
   */
  private handleError(error: Error): void {
    this.hsm.send({ type: 'ERROR', error });
  }

  /**
   * Handle updates received on remoteDoc from the provider.
   */
  private handleRemoteUpdate(update: Uint8Array, origin: unknown): void {
    // Skip updates originated by the HSM or this integration (our own writes)
    if (origin === this.hsm || origin === this) {
      return;
    }

    // Always send REMOTE_UPDATE with the raw bytes so every HSM state
    // (including active.entering substates) can accumulate or apply it.
    // In active.tracking the applyRemoteToRemoteDoc action is a harmless
    // no-op because the provider already applied the update to remoteDoc.
    this.hsm.send({ type: 'REMOTE_UPDATE', update });
  }

  /**
   * Connect the provider.
   */
  connect(): void {
    this.provider.connect();
  }

  /**
   * Disconnect the provider.
   */
  disconnect(): void {
    this.provider.disconnect();
  }

  /**
   * Destroy the integration and cleanup.
   * Note: Does NOT destroy the provider - it outlives the integration.
   */
  destroy(): void {
    // Unsubscribe from provider events
    this.provider.off('sync', this.onSync as (...args: unknown[]) => void);
    this.provider.off('connection-close', this.onDisconnect as (...args: unknown[]) => void);
    this.provider.off('connection-error', this.onError as (...args: unknown[]) => void);

    // Unobserve remoteDoc
    this.remoteDoc.off('update', this.onRemoteUpdate);

    // NOTE: Do NOT destroy the provider - it outlives the integration.
    // The provider is managed by HasProvider/Document and persists across lock cycles.
  }
}
