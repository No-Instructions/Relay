/**
 * MergeManager - Manages Multiple MergeHSM Instances
 *
 * Provides centralized management for all document HSMs.
 *
 * Lifecycle:
 * - register(): Creates HSM in idle mode
 * - getHSM(): Acquires lock, transitions to active mode
 * - unload(): Releases lock, transitions back to idle mode
 * - unregister(): Destroys HSM completely
 *
 * HSM instances persist across lock cycles, maintaining state
 * and processing events even when no editor is open.
 */

import * as Y from 'yjs';
import { MergeHSM } from './MergeHSM';
import type {
  SyncStatus,
  MergeEffect,
  PersistedMergeState,
  CreatePersistence,
} from './types';
import type { TimeProvider } from '../TimeProvider';
import { DefaultTimeProvider } from '../TimeProvider';
import { ObservableMap } from '../observable/ObservableMap';

// =============================================================================
// Types
// =============================================================================

export interface MergeManagerConfig {
  /**
   * Function to generate vault ID for a document.
   * Convention: `${appId}-relay-doc-${guid}`
   */
  getVaultId: (guid: string) => string;

  /** Time provider (for testing) */
  timeProvider?: TimeProvider;

  /** Hash function */
  hashFn?: (contents: string) => Promise<string>;

  /** Callback to load persisted state for a document */
  loadState?: (guid: string) => Promise<PersistedMergeState | null>;

  /** Callback when an effect is emitted by any HSM */
  onEffect?: (guid: string, effect: MergeEffect) => void;

  /**
   * Callback to get disk state for a document (for polling).
   * Returns { contents, mtime, hash } or null if file doesn't exist.
   */
  getDiskState?: (path: string) => Promise<{
    contents: string;
    mtime: number;
    hash: string;
  } | null>;

  /**
   * Callback to persist the sync status index.
   */
  persistIndex?: (status: Map<string, SyncStatus>) => Promise<void>;

  /**
   * Factory to create persistence for localDoc.
   * Production: pass IndexeddbPersistence constructor wrapper.
   * Tests: omit for default no-op persistence.
   */
  createPersistence?: CreatePersistence;
}

export interface PollOptions {
  /** Only poll specific GUIDs */
  guids?: string[];
}

export interface RegisteredDocument {
  guid: string;
  path: string;
  syncStatus: SyncStatus;
}

// =============================================================================
// MergeManager Implementation
// =============================================================================

export class MergeManager {
  // Sync status for ALL registered documents - Observable per spec
  private readonly _syncStatus = new ObservableMap<string, SyncStatus>('MergeManager.syncStatus');

  // All HSM instances (both idle and active)
  private hsms: Map<string, MergeHSM> = new Map();

  // GUIDs with editor open (lock acquired)
  private activeDocs: Set<string> = new Set();

  // Configuration
  private getVaultId: (guid: string) => string;
  private timeProvider: TimeProvider;
  private hashFn?: (contents: string) => Promise<string>;
  private loadState?: (guid: string) => Promise<PersistedMergeState | null>;
  private onEffect?: (guid: string, effect: MergeEffect) => void;
  private getDiskState?: (path: string) => Promise<{
    contents: string;
    mtime: number;
    hash: string;
  } | null>;
  private _persistIndex?: (status: Map<string, SyncStatus>) => Promise<void>;
  private createPersistence?: CreatePersistence;

  constructor(config: MergeManagerConfig) {
    this.getVaultId = config.getVaultId;
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.hashFn = config.hashFn;
    this.loadState = config.loadState;
    this.onEffect = config.onEffect;
    this.getDiskState = config.getDiskState;
    this._persistIndex = config.persistIndex;
    this.createPersistence = config.createPersistence;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get sync status for all registered documents (ObservableMap per spec).
   */
  get syncStatus(): ObservableMap<string, SyncStatus> {
    return this._syncStatus;
  }

  /**
   * Register a document and create its HSM in idle mode.
   * The HSM will persist across lock cycles until unregister() is called.
   *
   * @param guid - Document GUID
   * @param path - Virtual path within shared folder
   * @param remoteDoc - Remote YDoc, managed externally with provider attached
   */
  async register(guid: string, path: string, remoteDoc: Y.Doc): Promise<void> {
    // Skip if already registered
    if (this.hsms.has(guid)) {
      return;
    }

    // Create HSM in idle mode
    const hsm = new MergeHSM({
      guid,
      path,
      vaultId: this.getVaultId(guid),
      remoteDoc,
      timeProvider: this.timeProvider,
      hashFn: this.hashFn,
      createPersistence: this.createPersistence,
    });

    // Subscribe to effects
    hsm.subscribe((effect) => {
      this.handleHSMEffect(guid, effect);
    });

    // Subscribe to state changes to update sync status
    hsm.onStateChange(() => {
      this.updateSyncStatus(guid, hsm.getSyncStatus());
    });

    // Store HSM
    this.hsms.set(guid, hsm);

    // Initialize HSM through loading → idle
    hsm.send({ type: 'LOAD', guid, path });

    // Load persisted state (LCA). Updates are loaded by IndexeddbPersistence internally.
    const persistedState = this.loadState ? await this.loadState(guid) : null;

    hsm.send({
      type: 'PERSISTENCE_LOADED',
      updates: new Uint8Array(),
      lca: persistedState?.lca
        ? {
            contents: persistedState.lca.contents,
            meta: {
              hash: persistedState.lca.hash,
              mtime: persistedState.lca.mtime,
            },
            stateVector: persistedState.lca.stateVector,
          }
        : null,
    });

    // HSM is now in idle.* state - update sync status
    this.updateSyncStatus(guid, hsm.getSyncStatus());
  }

  /**
   * Get HSM for a document, acquiring lock to transition to active mode.
   * If not already registered, registers the document first.
   *
   * @param guid - Document GUID
   * @param path - Virtual path within shared folder
   * @param remoteDoc - Remote YDoc, managed externally with provider attached
   */
  async getHSM(guid: string, path: string, remoteDoc: Y.Doc): Promise<MergeHSM> {
    // Ensure HSM exists (register if needed)
    if (!this.hsms.has(guid)) {
      await this.register(guid, path, remoteDoc);
    }

    const hsm = this.hsms.get(guid)!;

    // If not already active, acquire lock
    if (!this.activeDocs.has(guid)) {
      hsm.send({ type: 'ACQUIRE_LOCK' });
      this.activeDocs.add(guid);
    }

    return hsm;
  }

  /**
   * Check if an HSM is currently in active mode (lock acquired).
   */
  isLoaded(guid: string): boolean {
    return this.activeDocs.has(guid);
  }

  /**
   * Check if a document is registered (HSM exists).
   */
  isRegistered(guid: string): boolean {
    return this.hsms.has(guid);
  }

  /**
   * Release lock on an HSM, transitioning back to idle mode.
   * The HSM stays alive and continues processing events.
   */
  async unload(guid: string): Promise<void> {
    const hsm = this.hsms.get(guid);
    if (!hsm) return;

    // Only send RELEASE_LOCK if currently active
    if (this.activeDocs.has(guid)) {
      hsm.send({ type: 'RELEASE_LOCK' });
      this.activeDocs.delete(guid);
    }

    // HSM stays alive in idle.* state
    // Sync status preserved
  }

  /**
   * Fully unregister a document, destroying its HSM.
   * Use this when removing a document from sync.
   */
  async unregister(guid: string): Promise<void> {
    const hsm = this.hsms.get(guid);
    if (!hsm) return;

    // Ensure released from active mode first
    if (this.activeDocs.has(guid)) {
      hsm.send({ type: 'RELEASE_LOCK' });
      this.activeDocs.delete(guid);
    }

    // Now fully unload
    hsm.send({ type: 'UNLOAD' });

    // Cleanup
    this.hsms.delete(guid);
    this._syncStatus.delete(guid);
  }

  /**
   * Handle a remote update for a document.
   * Forwards to the HSM which handles it appropriately in either idle or active mode.
   */
  async handleIdleRemoteUpdate(guid: string, update: Uint8Array): Promise<void> {
    const hsm = this.hsms.get(guid);
    if (hsm) {
      // Forward to HSM - it handles idle vs active mode internally
      hsm.send({ type: 'REMOTE_UPDATE', update });
    }
    // If no HSM, document isn't registered - ignore
  }

  /**
   * Poll for disk changes on registered documents.
   * Only sends DISK_CHANGED if the disk state actually differs from HSM's knowledge.
   */
  async pollAll(options?: PollOptions): Promise<void> {
    if (!this.getDiskState) {
      return; // No disk state provider configured
    }

    const guids = options?.guids ?? Array.from(this.hsms.keys());

    for (const guid of guids) {
      const hsm = this.hsms.get(guid);
      if (!hsm) continue;

      const path = hsm.state.path;
      const diskState = await this.getDiskState(path);
      if (diskState) {
        // BUG-007 fix: Only send DISK_CHANGED if something actually changed
        const currentDisk = hsm.state.disk;
        if (this.shouldSendDiskChanged(currentDisk, diskState)) {
          hsm.send({
            type: 'DISK_CHANGED',
            contents: diskState.contents,
            mtime: diskState.mtime,
            hash: diskState.hash,
          });
        }
      }
    }
  }

  /**
   * Determine if DISK_CHANGED event should be sent based on current vs new disk state.
   * Returns true if disk state has changed, false if unchanged.
   */
  private shouldSendDiskChanged(
    currentDisk: { hash: string; mtime: number } | null,
    newDiskState: { mtime: number; hash: string }
  ): boolean {
    // No current disk state - always send
    if (!currentDisk) return true;

    // Compare mtime first (fast check)
    if (currentDisk.mtime !== newDiskState.mtime) return true;

    // Compare hash as fallback (handles clock skew edge cases)
    if (currentDisk.hash !== newDiskState.hash) return true;

    return false;
  }

  /**
   * Persist the sync status index.
   */
  async persistIndex(): Promise<void> {
    if (!this._persistIndex) {
      return; // No persistence provider configured
    }

    // Convert ObservableMap to regular Map for persistence
    const statusMap = new Map<string, SyncStatus>();
    for (const [guid, status] of this._syncStatus.entries()) {
      statusMap.set(guid, status);
    }

    await this._persistIndex(statusMap);
  }

  /**
   * Subscribe to sync status changes.
   * @deprecated Use syncStatus.subscribe() directly for ObservableMap subscription.
   */
  onStatusChange(
    listener: (guid: string, status: SyncStatus) => void
  ): () => void {
    // Wrap the listener to work with ObservableMap subscription
    const observableListener = () => {
      // This gets called when any status changes - caller can check what changed
      for (const [guid, status] of this._syncStatus.entries()) {
        listener(guid, status);
      }
    };
    return this._syncStatus.subscribe(observableListener);
  }

  /**
   * Get all registered document GUIDs.
   */
  getRegisteredGuids(): string[] {
    return Array.from(this.hsms.keys());
  }

  /**
   * Get the path for a registered document.
   */
  getPath(guid: string): string | undefined {
    return this.hsms.get(guid)?.state.path;
  }

  /**
   * Get HSM without acquiring lock (for inspection/testing).
   * Returns undefined if document is not registered.
   */
  getIdleHSM(guid: string): MergeHSM | undefined {
    return this.hsms.get(guid);
  }

  // ===========================================================================
  // Internal Methods
  // ===========================================================================

  /**
   * Handle an effect emitted by an HSM.
   */
  private handleHSMEffect(guid: string, effect: MergeEffect): void {
    // Forward to external handler
    if (this.onEffect) {
      this.onEffect(guid, effect);
    }

    // Handle specific effects
    switch (effect.type) {
      case 'STATUS_CHANGED':
        this.updateSyncStatus(guid, effect.status);
        break;

      case 'PERSIST_STATE':
        // Integration layer handles actual persistence
        break;

      case 'PERSIST_UPDATES':
        // HSM handles internally now - no need to store in idleUpdates
        break;
    }
  }

  /**
   * Update sync status.
   * ObservableMap automatically notifies subscribers when set() is called.
   */
  private updateSyncStatus(guid: string, status: SyncStatus): void {
    this._syncStatus.set(guid, status);
  }
}
