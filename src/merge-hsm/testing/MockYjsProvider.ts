/**
 * MockYjsProvider - Minimal mock implementing the YjsProvider interface.
 *
 * Simulates a Yjs WebSocket provider for unit testing ProviderIntegration.
 * Supports connect/disconnect/destroy lifecycle and event emission.
 */

import * as Y from 'yjs';
import type { YjsProvider } from '../integration/ProviderIntegration';

type EventCallback = (...args: any[]) => void;

export class MockYjsProvider implements YjsProvider {
  synced = false;
  connectionState: { status: string } = { status: 'disconnected' };

  private listeners = new Map<string, Set<EventCallback>>();
  private _remoteDoc: Y.Doc;
  private _serverDoc: Y.Doc;
  private _destroyed = false;

  /**
   * @param remoteDoc - The remoteDoc this provider is "attached" to
   * @param serverDoc - The shared server Y.Doc to sync against
   */
  private _updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
  /** Count of updates forwarded to server (for debugging) */
  forwardedCount = 0;
  /** When false, updates are silently dropped (simulates transport failure) */
  forwardingEnabled = true;
  /** True when the WebSocket is "open" — set after deferred sync completes.
   * Matches y-websocket's wsconnected flag: false until onopen fires. */
  wsReady = false;

  constructor(remoteDoc: Y.Doc, serverDoc: Y.Doc) {
    this._remoteDoc = remoteDoc;
    this._serverDoc = serverDoc;

    // Forward remoteDoc updates to server (like y-websocket does).
    // Only forwards when wsReady is true — matches y-websocket's broadcastMessage
    // which checks wsconnected && ws.readyState === OPEN. Updates that arrive
    // before the WebSocket opens are SILENTLY DROPPED (BUG-123 sender-side root cause).
    this._updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === 'provider' || this._destroyed) return;
      if (!this.wsReady) return;  // WebSocket not open yet — drop silently
      if (!this.forwardingEnabled) return;
      this.forwardedCount++;
      Y.applyUpdate(this._serverDoc, update, 'provider-forward');
    };
    this._remoteDoc.on('update', this._updateHandler);
  }

  on(event: string, callback: EventCallback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach(cb => cb(...args));
  }

  connect(): void {
    if (this._destroyed) return;
    this.connectionState = { status: 'connected' };

    // Defer sync to match production timing: the WebSocket provider
    // connects, data arrives asynchronously, then 'sync' fires.
    // Data is applied BEFORE sync fires — sync means "initial state
    // is fully loaded into remoteDoc."
    Promise.resolve().then(() => {
      if (this._destroyed || this.connectionState.status !== 'connected') return;

      // Pull server state into remoteDoc
      const serverUpdate = Y.encodeStateAsUpdate(
        this._serverDoc,
        Y.encodeStateVector(this._remoteDoc),
      );
      if (serverUpdate.length > 2) {
        Y.applyUpdate(this._remoteDoc, serverUpdate, 'provider');
      }

      this.wsReady = true;  // WebSocket is "open" — start forwarding
      this.synced = true;
      this.emit('sync');
    });
  }

  disconnect(): void {
    if (this._destroyed) return;
    this.connectionState = { status: 'disconnected' };
    this.synced = false;
    this.emit('connection-close');
  }

  destroy(): void {
    this._destroyed = true;
    if (this._updateHandler) {
      this._remoteDoc.off('update', this._updateHandler);
      this._updateHandler = null;
    }
    this.listeners.clear();
  }

  /**
   * Simulate receiving a server update (as if server pushed data).
   * Applies the update to remoteDoc with origin 'provider'.
   */
  receiveServerUpdate(update: Uint8Array): void {
    if (this._destroyed || this.connectionState.status !== 'connected') return;
    Y.applyUpdate(this._remoteDoc, update, 'provider');
  }

  /**
   * Push local remoteDoc changes to the server.
   * Call this to simulate the provider's outbound sync.
   */
  pushToServer(origin: string): void {
    if (this._destroyed || this.connectionState.status !== 'connected') return;
    const update = Y.encodeStateAsUpdate(
      this._remoteDoc,
      Y.encodeStateVector(this._serverDoc),
    );
    if (update.length > 2) {
      Y.applyUpdate(this._serverDoc, update, origin);
    }
  }
}
