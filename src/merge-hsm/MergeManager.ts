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
  PersistenceMetadata,
  LoadUpdatesRaw,
  LCAState,
} from './types';
import type { TimeProvider } from '../TimeProvider';
import { DefaultTimeProvider } from '../TimeProvider';
import { ObservableMap } from '../observable/ObservableMap';
import { awaitOnReload } from '../reloadUtils';

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

  /**
   * Callback to load all persisted states for bulk LCA cache initialization.
   * Called during initialize() to bulk-load all LCA states into cache.
   * Production: pass a function that uses getAllStates from MergeHSMDatabase.
   * Tests: can omit for default empty array.
   */
  loadAllStates?: () => Promise<PersistedMergeState[]>;

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

  /**
   * Callback to get persistence metadata for a document.
   * Metadata is set on the IndexedDB persistence for recovery/debugging.
   */
  getPersistenceMetadata?: (guid: string, path: string) => PersistenceMetadata;

  /**
   * User ID for PermanentUserData tracking.
   * If provided, each HSM will set up user mapping on localDoc.
   */
  userId?: string;

  /**
   * Callback to load raw Yjs updates from IndexedDB.
   * Used to load local CRDT state for PERSISTENCE_LOADED event.
   * Production: pass loadUpdatesRaw from src/storage/y-indexeddb.js
   * Tests: omit for default empty array.
   */
  loadUpdatesRaw?: LoadUpdatesRaw;
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

  // Pending registration promises (for awaiting all registrations)
  private pendingRegistrations: Map<string, Promise<void>> = new Map();

  // Track destroyed state to prevent operations after cleanup
  private destroyed = false;

  // Track initialized state - initialize() must be called before registering HSMs
  private _initialized = false;

  // LCA cache - bulk-loaded during initialize(), owned by MergeManager
  private _lcaCache = new Map<string, LCAState | null>();

  // Configuration
  private getVaultId: (guid: string) => string;
  private timeProvider: TimeProvider;
  private hashFn?: (contents: string) => Promise<string>;
  private loadState?: (guid: string) => Promise<PersistedMergeState | null>;
  private loadAllStates?: () => Promise<PersistedMergeState[]>;
  private onEffect?: (guid: string, effect: MergeEffect) => void;
  private getDiskState?: (path: string) => Promise<{
    contents: string;
    mtime: number;
    hash: string;
  } | null>;
  private _persistIndex?: (status: Map<string, SyncStatus>) => Promise<void>;
  private createPersistence?: CreatePersistence;
  private getPersistenceMetadata?: (guid: string, path: string) => PersistenceMetadata;
  private userId?: string;
  private loadUpdatesRaw?: LoadUpdatesRaw;

  constructor(config: MergeManagerConfig) {
    this.getVaultId = config.getVaultId;
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.hashFn = config.hashFn;
    this.loadState = config.loadState;
    this.loadAllStates = config.loadAllStates;
    this.onEffect = config.onEffect;
    this.getDiskState = config.getDiskState;
    this._persistIndex = config.persistIndex;
    this.createPersistence = config.createPersistence;
    this.getPersistenceMetadata = config.getPersistenceMetadata;
    this.userId = config.userId;
    this.loadUpdatesRaw = config.loadUpdatesRaw;
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
   * Check if initialize() has been called.
   */
  get initialized(): boolean {
    return this._initialized;
  }

  // ===========================================================================
  // LCA Cache (Gap 7: MergeManager owns reads AND writes)
  // ===========================================================================

  /**
   * Get LCA from cache (synchronous).
   * Returns the cached LCA state, or null if not found or not in cache.
   *
   * HSMs should call this instead of receiving LCA via PERSISTENCE_LOADED event.
   * The cache is populated during initialize() via bulk load.
   */
  getLCA(guid: string): LCAState | null {
    return this._lcaCache.get(guid) ?? null;
  }

  /**
   * Update LCA in cache and persist to storage.
   * HSMs should call this instead of emitting PERSIST_STATE effect.
   *
   * @param guid - Document GUID
   * @param lca - New LCA state, or null to clear
   */
  async setLCA(guid: string, lca: LCAState | null): Promise<void> {
    // Update cache immediately (synchronous)
    this._lcaCache.set(guid, lca);

    // Persist to storage via the onEffect callback
    // The integration layer handles actual IndexedDB writes
    const hsm = this.hsms.get(guid);
    if (hsm && this.onEffect) {
      const persistedState: PersistedMergeState = {
        guid,
        path: hsm.state.path,
        lca: lca
          ? {
              contents: lca.contents,
              hash: lca.meta.hash,
              mtime: lca.meta.mtime,
              stateVector: lca.stateVector,
            }
          : null,
        disk: hsm.state.disk,
        localStateVector: hsm.state.localStateVector,
        lastStatePath: hsm.state.statePath,
        deferredConflict: hsm.state.deferredConflict,
        persistedAt: this.timeProvider.now(),
      };

      this.onEffect(guid, {
        type: 'PERSIST_STATE',
        guid,
        state: persistedState,
      });
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize MergeManager - MUST be called before registering HSMs.
   * Performs bulk read of all LCA states from IndexedDB into cache.
   *
   * This enables synchronous LCA lookups during HSM operations and avoids
   * per-document IndexedDB reads during registration.
   */
  async initialize(): Promise<void> {
    if (this._initialized) {
      return; // Already initialized
    }

    if (this.destroyed) {
      return; // Don't initialize if destroyed
    }

    // Bulk-load all persisted states into LCA cache
    if (this.loadAllStates) {
      const allStates = await this.loadAllStates();
      for (const state of allStates) {
        if (state.lca) {
          this._lcaCache.set(state.guid, {
            contents: state.lca.contents,
            meta: {
              hash: state.lca.hash,
              mtime: state.lca.mtime,
            },
            stateVector: state.lca.stateVector,
          });
        } else {
          this._lcaCache.set(state.guid, null);
        }
      }
    }

    this._initialized = true;
  }

  /**
   * Register a document and create its HSM in idle mode.
   * The HSM will persist across lock cycles until unregister() is called.
   *
   * @param guid - Document GUID
   * @param path - Virtual path within shared folder
   * @param remoteDoc - Remote YDoc, managed externally with provider attached
   */
  register(guid: string, path: string, remoteDoc: Y.Doc): Promise<void> {
    if (this.destroyed) return Promise.resolve();

    // Skip if already registered
    if (this.hsms.has(guid)) {
      return Promise.resolve();
    }

    // Skip if registration already in progress
    if (this.pendingRegistrations.has(guid)) {
      return this.pendingRegistrations.get(guid)!;
    }

    // Create and track the registration promise
    const registrationPromise = this.doRegister(guid, path, remoteDoc);
    this.pendingRegistrations.set(guid, registrationPromise);

    // Clean up when done
    registrationPromise.finally(() => {
      this.pendingRegistrations.delete(guid);
    });

    return registrationPromise;
  }

  private async doRegister(guid: string, path: string, remoteDoc: Y.Doc): Promise<void> {
    // Create HSM in idle mode
    const hsm = new MergeHSM({
      guid,
      path,
      vaultId: this.getVaultId(guid),
      remoteDoc,
      timeProvider: this.timeProvider,
      hashFn: this.hashFn,
      createPersistence: this.createPersistence,
      persistenceMetadata: this.getPersistenceMetadata?.(guid, path),
      userId: this.userId,
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

    // Load persisted state (LCA) and raw CRDT updates from IndexedDB
    const [persistedState, localUpdates] = await Promise.all([
      this.loadState ? this.loadState(guid) : Promise.resolve(null),
      this.loadUpdatesRaw ? this.loadUpdatesRaw(this.getVaultId(guid)) : Promise.resolve([]),
    ]);

    // Merge updates if we have any (for computing localStateVector)
    const mergedUpdates = localUpdates.length > 0
      ? Y.mergeUpdates(localUpdates)
      : new Uint8Array();

    hsm.send({
      type: 'PERSISTENCE_LOADED',
      updates: mergedUpdates,
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

    // Send mode determination to transition out of loading (flat state per v9 spec)
    hsm.send({ type: 'SET_MODE_IDLE' });

    // HSM is now in idle.* state - update sync status
    this.updateSyncStatus(guid, hsm.getSyncStatus());
  }

  /**
   * Wait for all pending registrations to complete.
   * Use this after calling register() without await to ensure HSMs are ready.
   */
  async whenRegistered(): Promise<void> {
    if (this.pendingRegistrations.size === 0) {
      return;
    }
    await Promise.all(this.pendingRegistrations.values());
  }

  /**
   * Get or create HSM for a document (synchronous).
   * Creates the HSM in loading state and kicks off async persistence loading.
   * Does NOT acquire lock - the HSM stays in idle mode after loading completes.
   *
   * Use this when you need the HSM reference immediately (e.g., in constructors).
   * The HSM will be in loading state until persistence loads, then idle.
   *
   * @param guid - Document GUID
   * @param path - Virtual path within shared folder
   * @param remoteDoc - Remote YDoc, managed externally with provider attached
   * @returns The HSM instance (may still be loading), or null if destroyed
   */
  getOrRegisterHSM(guid: string, path: string, remoteDoc: Y.Doc): MergeHSM | null {
    if (this.destroyed) return null;

    // Return existing HSM if already registered
    if (this.hsms.has(guid)) {
      return this.hsms.get(guid)!;
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
      persistenceMetadata: this.getPersistenceMetadata?.(guid, path),
      userId: this.userId,
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

    // Fire-and-forget async persistence loading
    (async () => {
      // Load persisted state (LCA) and raw CRDT updates from IndexedDB
      const [persistedState, localUpdates] = await Promise.all([
        this.loadState ? this.loadState(guid) : Promise.resolve(null),
        this.loadUpdatesRaw ? this.loadUpdatesRaw(this.getVaultId(guid)) : Promise.resolve([]),
      ]);

      // Merge updates if we have any (for computing localStateVector)
      const mergedUpdates = localUpdates.length > 0
        ? Y.mergeUpdates(localUpdates)
        : new Uint8Array();

      hsm.send({
        type: 'PERSISTENCE_LOADED',
        updates: mergedUpdates,
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
    })();

    return hsm;
  }

  /**
   * Get HSM for a document, acquiring lock to transition to active mode.
   * If not already registered, registers the document first.
   *
   * @param guid - Document GUID
   * @param path - Virtual path within shared folder
   * @param remoteDoc - Remote YDoc, managed externally with provider attached
   * @param editorContent - The current editor/disk content. Required in v6 to fix BUG-022.
   *   If not provided, defaults to empty string.
   */
  async getHSM(guid: string, path: string, remoteDoc: Y.Doc, editorContent: string = ''): Promise<MergeHSM> {
    if (this.destroyed) {
      throw new Error('MergeManager has been destroyed');
    }

    // Ensure HSM exists (register if needed)
    if (!this.hsms.has(guid)) {
      await this.register(guid, path, remoteDoc);
    }

    const hsm = this.hsms.get(guid)!;

    // If not already active, acquire lock with editorContent
    if (!this.activeDocs.has(guid)) {
      hsm.send({ type: 'ACQUIRE_LOCK', editorContent });
      this.activeDocs.add(guid);

      // If HSM is waiting for provider sync (empty IDB), send PROVIDER_SYNCED
      // to unblock. In production, ProviderIntegration (created by Document.acquireLock)
      // delivers this event. MergeManager.getHSM() is a simpler API that handles
      // the common case of an already-synced provider.
      if (hsm.matches('active.entering')) {
        hsm.send({ type: 'PROVIDER_SYNCED' });
      }
    }

    return hsm;
  }

  /**
   * Check if an HSM is currently in active mode (lock acquired).
   */
  isActive(guid: string): boolean {
    return this.activeDocs.has(guid);
  }

  /**
   * Mark a document as active (lock acquired).
   * Used by Document.acquireLock() after sending ACQUIRE_LOCK directly.
   */
  markActive(guid: string): void {
    this.activeDocs.add(guid);
  }

  /**
   * Check if a document is registered (HSM exists).
   */
  isRegistered(guid: string): boolean {
    return this.hsms.has(guid);
  }

  /**
   * Set which documents have open editors.
   * Called by LiveViews after scanning the workspace.
   *
   * - Documents in activeGuids: HSM receives SET_MODE_ACTIVE
   * - Documents NOT in activeGuids: HSM receives SET_MODE_IDLE
   *
   * For HSMs in `loading` state, sends mode determination events.
   * Also detects HSMs stuck in `active.*` mode without a corresponding
   * open editor and sends RELEASE_LOCK to recover them to idle.
   */
  setActiveDocuments(activeGuids: Set<string>): void {
    if (this.destroyed) return;

    for (const [guid, hsm] of this.hsms) {
      const statePath = hsm.state.statePath;

      if (statePath === 'loading') {
        if (activeGuids.has(guid)) {
          hsm.send({ type: 'SET_MODE_ACTIVE' });
        } else {
          hsm.send({ type: 'SET_MODE_IDLE' });
        }
      } else if (statePath.startsWith('active.') && !activeGuids.has(guid) && !this.activeDocs.has(guid)) {
        // HSM is in active mode but no editor is open and MergeManager doesn't
        // consider it active. This can happen when a stale ACQUIRE_LOCK arrives
        // (e.g., from a race between async acquireLock and sync releaseLock).
        // Send RELEASE_LOCK to recover the HSM to idle mode.
        hsm.send({ type: 'RELEASE_LOCK' });
      }
    }
  }

  /**
   * Release lock on an HSM, transitioning back to idle mode.
   * The HSM stays alive and continues processing events.
   * Waits for IndexedDB writes to complete before returning.
   */
  async unload(guid: string): Promise<void> {
    const hsm = this.hsms.get(guid);
    if (!hsm) return;

    // Only send RELEASE_LOCK if currently active
    if (this.activeDocs.has(guid)) {
      hsm.send({ type: 'RELEASE_LOCK' });
      this.activeDocs.delete(guid);
      // Wait for cleanup to complete (IndexedDB writes)
      await hsm.awaitCleanup();
    }

    // HSM stays alive in idle.* state
    // Sync status preserved
  }

  /**
   * Fully unregister a document, destroying its HSM.
   * Use this when removing a document from sync.
   * Waits for IndexedDB writes to complete before returning.
   */
  async unregister(guid: string): Promise<void> {
    const hsm = this.hsms.get(guid);
    if (!hsm) return;

    // Ensure released from active mode first
    if (this.activeDocs.has(guid)) {
      hsm.send({ type: 'RELEASE_LOCK' });
      this.activeDocs.delete(guid);
      // Wait for cleanup to complete (IndexedDB writes)
      await hsm.awaitCleanup();
    }

    // Now fully unload
    hsm.send({ type: 'UNLOAD' });
    // Wait for unload cleanup to complete
    await hsm.awaitCleanup();

    // Cleanup
    this.hsms.delete(guid);
    this._syncStatus.delete(guid);
  }

  /**
   * Handle a remote update for a document.
   * Forwards to the HSM which handles it appropriately in either idle or active mode.
   */
  handleRemoteUpdate(guid: string, update: Uint8Array): void {
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

  /**
   * Destroy all HSMs and clean up resources.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const hsm of this.hsms.values()) {
      hsm.send({ type: 'UNLOAD' });
      awaitOnReload(hsm.awaitCleanup());
    }

    this.hsms.clear();
    this.activeDocs.clear();
    this.pendingRegistrations.clear();
    this._syncStatus.clear();
  }

  // ===========================================================================
  // Internal Methods
  // ===========================================================================

  /**
   * Handle an effect emitted by an HSM.
   */
  private handleHSMEffect(guid: string, effect: MergeEffect): void {
    // Skip effects during/after destruction to avoid PostOffice teardown errors
    if (this.destroyed) return;

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
    // Skip updates during/after destruction to avoid PostOffice teardown errors
    if (this.destroyed) return;
    this._syncStatus.set(guid, status);
  }
}
