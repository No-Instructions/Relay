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
import { isEmptyDoc, snapshotFromDoc } from '../snapshots';

const providerError = curryLog("[ProviderIntegration]", "error");
const providerWarn = curryLog("[ProviderIntegration]", "warn");

/**
 * Normalize a provider connection-error payload into an Error.
 *
 * Providers emit this event with whatever the transport produced: an Error
 * (or arbitrary thrown value) from a failed reconnect hook, or a WebSocket
 * error Event, which carries no failure detail beyond its type. Diagnostics
 * need a real Error either way.
 */
export function normalizeConnectionError(raw: unknown): Error {
  if (raw instanceof Error) {
    return raw;
  }
  if (raw && typeof raw === 'object') {
    const shape = raw as { error?: unknown; message?: unknown; type?: unknown };
    if (shape.error instanceof Error) {
      return shape.error;
    }
    if (typeof shape.message === 'string' && shape.message.length > 0) {
      return new Error(shape.message);
    }
    if (typeof shape.type === 'string') {
      return new Error(`connection error ('${shape.type}' event)`);
    }
  }
  return new Error(`connection error: ${String(raw)}`);
}

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * Minimal interface for a Yjs provider.
 * Compatible with YSweetProvider, y-websocket, etc.
 */
export interface YjsProvider {
  on(event: 'sync', callback: (synced?: boolean) => void): void;
  on(event: 'connection-close' | 'disconnect', callback: () => void): void;
  on(event: 'connection-error', callback: (error: unknown) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;
  connect(): void;
  disconnect(): void;
  destroy(): void;

  // Optional: for checking initial state
  synced?: boolean;
  connectionState?: { status: string };
}

export interface ProviderIntegrationOptions {
  onSyncedRemoteHead?: (snapshot: Uint8Array) => void;
}

// =============================================================================
// ProviderIntegration Class
// =============================================================================

export class ProviderIntegration {
  private hsm: MergeHSM;
  private remoteDoc: Y.Doc;
  private provider: YjsProvider;
  private lastRemoteText: string;

  // Bound event handlers for cleanup
  private onSync: (synced?: boolean) => void;
  private onDisconnect: () => void;
  private onError: (error: unknown) => void;
  private onRemoteUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(
    hsm: MergeHSM,
    remoteDoc: Y.Doc,
    provider: YjsProvider,
    private readonly options: ProviderIntegrationOptions = {},
  ) {
    this.hsm = hsm;
    this.remoteDoc = remoteDoc;
    this.provider = provider;
    this.lastRemoteText = this.readRemoteText();

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
    this.resampleConnectionState();
  }

  /**
   * Re-send connection and sync state read from the provider's current level.
   *
   * The HSM's sync gate is edge-triggered and can be cleared while the
   * provider stays connected and synced (e.g. when a lock is acquired). A
   * genuinely synced provider fires no new 'sync' event afterwards, so a
   * caller that reuses this integration instead of constructing a fresh one
   * must re-sample the provider to restore the gate.
   */
  resampleConnectionState(): void {
    if (this.provider.connectionState?.status === 'connected') {
      this.hsm.send({ type: 'CONNECTED' });
    }
    if (this.provider.synced && this.isProviderConnected()) {
      this.options.onSyncedRemoteHead?.(snapshotFromDoc(this.remoteDoc).snapshot);
      this.hsm.send({ type: 'PROVIDER_SYNCED' });
    }
  }

  /**
   * Handle provider sync event (initial sync complete).
   *
   * Asserts that the provider actually delivered data into remoteDoc.
   * If remoteDoc holds no ops after sync, the provider lied about being
   * synced.
   */
  private handleSync(synced?: boolean): void {
    if (synced === false) return;
    if (!this.isProviderConnected()) return;

    if (isEmptyDoc(this.remoteDoc)) {
      // No ops were delivered.
      // This should not happen if the provider truly synced.
      providerError(
        'PROVIDER_SYNCED fired but remoteDoc holds no ops. ' +
        'The provider reported sync before delivering document data.'
      );
    }
    this.options.onSyncedRemoteHead?.(snapshotFromDoc(this.remoteDoc).snapshot);
    this.hsm.send({ type: 'PROVIDER_SYNCED' });
    this.hsm.send({ type: 'CONNECTED' });
  }

  private isProviderConnected(): boolean {
    const status = this.provider.connectionState?.status;
    return !status || status === 'connected';
  }

  /**
   * Handle provider disconnect event.
   */
  private handleDisconnect(): void {
    this.hsm.send({ type: 'DISCONNECTED' });
  }

  /**
   * Handle provider connection-error event.
   *
   * A connection error is connectivity loss, not a machine fault: in active
   * mode the HSM goes offline exactly as it does for connection-close, and in
   * idle mode the machine is left alone — reconnection and retry belong to
   * the background sync layer there. The payload is normalized because the
   * provider forwards whatever the transport produced.
   */
  private handleError(raw: unknown): void {
    const error = normalizeConnectionError(raw);
    const mode = this.hsm.isActive() ? 'active' : 'idle';
    providerWarn(`connection error (${mode}): ${error.message}`);
    if (this.hsm.isActive()) {
      this.hsm.send({ type: 'DISCONNECTED' });
    }
  }

  /**
   * Handle updates received on remoteDoc from the provider.
   */
  private handleRemoteUpdate(update: Uint8Array, origin: unknown): void {
    const currentRemoteText = this.readRemoteText();
    const affectsText = currentRemoteText !== this.lastRemoteText;
    this.lastRemoteText = currentRemoteText;

    // Skip updates originated by the HSM or this integration (our own writes)
    if (origin === this.hsm || origin === this) {
      return;
    }

    // Always send REMOTE_UPDATE with the raw bytes so every HSM state
    // (including active.entering substates) can accumulate or apply it.
    // In active.tracking the applyRemoteToRemoteDoc action is a harmless
    // no-op because the provider already applied the update to remoteDoc.
    this.hsm.send({ type: 'REMOTE_UPDATE', update, affectsText });
  }

  private readRemoteText(): string {
    return this.remoteDoc.getText('contents').toString();
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
