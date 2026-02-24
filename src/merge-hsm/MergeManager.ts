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
  LCAState,
} from './types';
import type { TimeProvider } from '../TimeProvider';
import { DefaultTimeProvider } from '../TimeProvider';
import { ObservableMap } from '../observable/ObservableMap';
import { awaitOnReload } from '../reloadUtils';
import { validateUpdate } from '../storage/yjs-validation';

// =============================================================================
// Types
// =============================================================================

/**
 * Interface for documents managed by MergeManager.
 * Implemented by Document — MergeManager uses this to avoid
 * depending on the full Document class.
 */
export interface MergeManagerDocument {
  hsm: import('./MergeHSM').MergeHSM | null;
  /** Connect the WebSocket provider for idle-mode fork reconciliation. */
  connectForForkReconcile(): Promise<void>;
  /** Tear down the idle-mode provider integration (on hibernate). */
  destroyIdleProviderIntegration(): void;
  /** Whether a ProviderIntegration is currently active. */
  hasProviderIntegration(): boolean;
}

export interface MergeManagerConfig {
  /**
   * Function to generate vault ID for a document.
   * Convention: `${appId}-relay-doc-${guid}`
   */
  getVaultId: (guid: string) => string;

  /**
   * Callback to get a Document by GUID.
   * Required - Document owns HSM, MergeManager accesses via this callback.
   * Return undefined if document not found.
   */
  getDocument: (guid: string) => MergeManagerDocument | undefined;

  /** Time provider (for testing) */
  timeProvider?: TimeProvider;

  /** Hash function */
  hashFn?: (contents: string) => Promise<string>;

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

  /** Hibernation configuration */
  hibernation?: HibernationConfig;

  /** Push-based transition callback for recording bridge */
  onTransition?: (guid: string, path: string, info: { from: import('./types').StatePath; to: import('./types').StatePath; event: import('./types').MergeEvent; effects: import('./types').MergeEffect[] }) => void;
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
// Hibernation Types
// =============================================================================

/** Memory state for a document */
export type HibernationState = 'hibernated' | 'warm' | 'active';

/** Wake priority levels (lower number = higher priority) */
export enum WakePriority {
  /** P1: Editor opened — immediate, blocking */
  OPEN_DOC = 1,
  /** P2: External file change detected */
  DISK_EDIT = 2,
  /** P3: Inbound CBOR remote update */
  REMOTE_UPDATE = 3,
  /** P4: Background cache validation sweep */
  CACHE_VALIDATION = 4,
}

export interface WakeRequest {
  guid: string;
  priority: WakePriority;
  /** Raw update bytes to buffer (for P3 wake from remote update) */
  update?: Uint8Array;
  /** Signal that the document should connect its provider after waking (for fork reconciliation) */
  connect?: boolean;
}

export interface HibernationConfig {
  /** Timeout in ms before warm documents re-hibernate (default: 60000) */
  hibernateTimeoutMs?: number;
  /** Max concurrent warm documents (default: 5) */
  maxConcurrentWarm?: number;
}

// =============================================================================
// MergeManager Implementation
// =============================================================================

export class MergeManager {
  // Sync status for ALL registered documents - Observable per spec
  private readonly _syncStatus = new ObservableMap<string, SyncStatus>('MergeManager.syncStatus');

  // GUIDs with editor open (lock acquired)
  private activeDocs: Set<string> = new Set();

  // Track destroyed state to prevent operations after cleanup
  private destroyed = false;

  // Track initialized state - initialize() must be called before registering HSMs
  private _initialized = false;

  // LCA cache - bulk-loaded during initialize(), owned by MergeManager
  private _lcaCache = new Map<string, LCAState | null>();

  // Local state vector cache - bulk-loaded during initialize()
  // Used for idle mode sync status display without opening per-document IDBs
  private _localStateVectorCache = new Map<string, Uint8Array | null>();

  // =========================================================================
  // Hibernation State
  // =========================================================================

  /** Memory state per document: hibernated (no YDocs), warm (loaded), active (editor open) */
  private _hibernationState = new Map<string, HibernationState>();

  /** Buffered raw update bytes for hibernated documents. Compacted via Y.mergeUpdates. */
  private _hibernationBuffer = new Map<string, Uint8Array>();

  /** Hibernate timers: guid → timer ID. When timer fires, warm → hibernated. */
  private _hibernateTimers = new Map<string, number>();

  /** Wake queue: sorted by priority (lower = higher priority). */
  private _wakeQueue: WakeRequest[] = [];

  /** Currently waking documents (bounded concurrency). */
  private _wakingDocs = new Set<string>();

  /** Whether the wake queue processor is currently running. */
  private _isProcessingWakeQueue = false;

  // Hibernation configuration
  private _hibernateTimeoutMs: number;
  private _maxConcurrentWarm: number;

  // Configuration
  private _getVaultId: (guid: string) => string;
  private _getDocument: (guid: string) => MergeManagerDocument | undefined;
  private timeProvider: TimeProvider;
  private hashFn?: (contents: string) => Promise<string>;
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
  private _onTransition?: (guid: string, path: string, info: { from: import('./types').StatePath; to: import('./types').StatePath; event: import('./types').MergeEvent; effects: import('./types').MergeEffect[] }) => void;

  constructor(config: MergeManagerConfig) {
    this._getVaultId = config.getVaultId;
    this._getDocument = config.getDocument;
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.hashFn = config.hashFn;
    this.loadAllStates = config.loadAllStates;
    this.onEffect = config.onEffect;
    this.getDiskState = config.getDiskState;
    this._persistIndex = config.persistIndex;
    this.createPersistence = config.createPersistence;
    this.getPersistenceMetadata = config.getPersistenceMetadata;
    this.userId = config.userId;
    this._onTransition = config.onTransition;

    // Hibernation defaults
    this._hibernateTimeoutMs = config.hibernation?.hibernateTimeoutMs ?? 60_000;
    this._maxConcurrentWarm = config.hibernation?.maxConcurrentWarm ?? 5;
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

  /**
   * Get vault ID for a document.
   * Exposed for Document to use when creating HSM.
   */
  getVaultId(guid: string): string {
    return this._getVaultId(guid);
  }

  /**
   * Set the push-based transition callback (used by recording bridge).
   * Applies to HSMs created after this call.
   */
  setOnTransition(cb: (guid: string, path: string, info: { from: import('./types').StatePath; to: import('./types').StatePath; event: import('./types').MergeEvent; effects: import('./types').MergeEffect[] }) => void): void {
    this._onTransition = cb;
  }

  // ===========================================================================
  // HSM Factory API
  // ===========================================================================

  /**
   * Create a new HSM instance with shared configuration.
   * Document owns the HSM - this is just a factory that provides shared config.
   *
   * @param config HSM configuration
   * @returns The newly created MergeHSM
   */
  createHSM(config: {
    guid: string;
    getPath: () => string;
    remoteDoc: Y.Doc | null;
    getDiskContent: () => Promise<{ content: string; hash: string; mtime: number }>;
    getPersistenceMetadata?: () => PersistenceMetadata;
  }): MergeHSM {
    const { guid, getPath, remoteDoc, getDiskContent, getPersistenceMetadata } = config;

    // Get LCA and localStateVector from cache (bulk-loaded during initialize())
    const lca = this.getLCA(guid);
    const localStateVector = this.getLocalStateVector(guid);

    const hsm = new MergeHSM({
      guid,
      getPath,
      vaultId: this._getVaultId(guid),
      remoteDoc,
      timeProvider: this.timeProvider,
      hashFn: this.hashFn,
      createPersistence: this.createPersistence,
      persistenceMetadata: getPersistenceMetadata?.(),
      userId: this.userId,
      diskLoader: getDiskContent,
    });

    // Wire push-based transition callback for recording
    if (this._onTransition) {
      const onTransition = this._onTransition;
      hsm.setOnTransition((info) => {
        onTransition(guid, getPath(), info);
      });
    }

    // Send LOAD and PERSISTENCE_LOADED to initialize the HSM
    hsm.send({ type: 'LOAD', guid });
    hsm.send({
      type: 'PERSISTENCE_LOADED',
      updates: new Uint8Array(), // No updates needed - we pass state vector directly
      lca,
      localStateVector,
    });

    // Start in idle mode by default (caller can send SET_MODE_ACTIVE if needed)
    hsm.send({ type: 'SET_MODE_IDLE' });

    // Handle REQUEST_PROVIDER_SYNC by connecting the document's provider.
    // This creates a live WebSocket so fork-reconcile can sync with the server.
    hsm.subscribe((effect) => {
      if (effect.type === 'REQUEST_PROVIDER_SYNC') {
        const doc = this._getDocument(guid);
        if (doc && !doc.hasProviderIntegration()) {
          doc.connectForForkReconcile().catch(() => {
            // Connection failure — fork-reconcile will time out or retry
          });
        }
      }
    });

    return hsm;
  }

  /**
   * Notify MergeManager that an HSM was created for a document.
   * Updates hibernation tracking.
   */
  notifyHSMCreated(guid: string): void {
    if (this.destroyed) return;
    this._hibernationState.set(guid, 'warm');
    this.resetHibernateTimer(guid);
  }

  /**
   * Notify MergeManager that an HSM was destroyed for a document.
   * Cleans up hibernation tracking.
   */
  notifyHSMDestroyed(guid: string): void {
    if (this.destroyed) return;
    this._hibernationState.delete(guid);
    this._hibernationBuffer.delete(guid);
    this.clearHibernateTimer(guid);
    this._syncStatus.delete(guid);
    this.activeDocs.delete(guid);
  }

  // ===========================================================================
  // Hibernation API
  // ===========================================================================

  /**
   * Get the hibernation state for a document.
   * Returns 'hibernated' for unknown documents.
   */
  getHibernationState(guid: string): HibernationState {
    return this._hibernationState.get(guid) ?? 'hibernated';
  }

  /**
   * Get the buffered update bytes for a hibernated document.
   * Returns null if no updates are buffered.
   */
  getHibernationBuffer(guid: string): Uint8Array | null {
    return this._hibernationBuffer.get(guid) ?? null;
  }

  /**
   * Enqueue a wake request for a document.
   * The wake queue processor handles bounded concurrency and priority ordering.
   *
   * For P1 (OPEN_DOC), the caller should also call wake() directly for
   * synchronous/blocking wake (acquireLock needs the doc ready immediately).
   */
  enqueueWake(request: WakeRequest): void {
    if (this.destroyed) return;

    const currentState = this.getHibernationState(request.guid);

    // Buffer remote update bytes for hibernated documents
    if (request.update) {
      this.bufferUpdate(request.guid, request.update);
    }

    // Already active or warm — just reset the hibernate timer
    if (currentState === 'active' || currentState === 'warm') {
      this.resetHibernateTimer(request.guid);
      return;
    }

    // Already in the wake queue — update priority if higher
    const existingIdx = this._wakeQueue.findIndex(r => r.guid === request.guid);
    if (existingIdx >= 0) {
      if (request.priority < this._wakeQueue[existingIdx].priority) {
        this._wakeQueue[existingIdx].priority = request.priority;
        this.sortWakeQueue();
      }
      return;
    }

    // Already waking — nothing to do
    if (this._wakingDocs.has(request.guid)) {
      return;
    }

    this._wakeQueue.push(request);
    this.sortWakeQueue();
    this.processWakeQueue();
  }

  /**
   * Synchronously wake a hibernated document (for P1 open-doc priority).
   * Drains the hibernation buffer into the HSM immediately.
   * Does NOT connect a provider — the caller (Document.acquireLock) handles that.
   *
   * @param guid - Document GUID
   * @param remoteDoc - The lazily-created remote YDoc to attach
   */
  wake(guid: string, remoteDoc: Y.Doc): void {
    if (this.destroyed) return;

    const doc = this._getDocument(guid);
    const hsm = doc?.hsm;
    if (!hsm) return;

    // Recreate localDoc destroyed during hibernation
    hsm.ensureLocalDocForIdle();

    // Attach remoteDoc to HSM
    hsm.setRemoteDoc(remoteDoc);

    // Drain buffered updates into the HSM
    const buffered = this._hibernationBuffer.get(guid);
    if (buffered) {
      hsm.send({ type: 'REMOTE_UPDATE', update: buffered });
      this._hibernationBuffer.delete(guid);
    }

    // Remove from wake queue if present
    this._wakeQueue = this._wakeQueue.filter(r => r.guid !== guid);

    this._hibernationState.set(guid, 'warm');
    this.resetHibernateTimer(guid);
  }

  /**
   * Hibernate a warm document: detach remoteDoc, clear timer.
   * The HSM stays alive with cached state vectors — no YDocs in memory.
   */
  hibernate(guid: string): void {
    if (this.destroyed) return;

    const currentState = this.getHibernationState(guid);
    if (currentState === 'hibernated') return;
    if (currentState === 'active') return; // Never hibernate active docs

    const doc = this._getDocument(guid);

    // Tear down any idle-mode provider integration before destroying docs
    doc?.destroyIdleProviderIntegration();

    const hsm = doc?.hsm;
    if (hsm) {
      hsm.setRemoteDoc(null);
      // destroyLocalDoc() nulls out references synchronously, then does
      // async IDB cleanup on the captured refs. Fire-and-forget is safe
      // because wake → ensureLocalDocForIdle() creates fresh instances.
      hsm.destroyLocalDoc();
    }

    this.clearHibernateTimer(guid);
    this._hibernationState.set(guid, 'hibernated');
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
   * Get localStateVector from cache (synchronous).
   * Returns the cached state vector, or null if not found or not in cache.
   *
   * Used during HSM registration to avoid opening per-document IDBs.
   * The cache is populated during initialize() via bulk load.
   */
  getLocalStateVector(guid: string): Uint8Array | null {
    return this._localStateVectorCache.get(guid) ?? null;
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
    const doc = this._getDocument(guid);
    const hsm = doc?.hsm;
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

        // Also cache localStateVector for idle mode sync status
        this._localStateVectorCache.set(
          state.guid,
          state.localStateVector ?? null
        );
      }
    }

    this._initialized = true;
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
    this._hibernationState.set(guid, 'active');
    this.clearHibernateTimer(guid);
  }

  /**
   * Check if a document is registered (HSM exists).
   * Uses getDocument callback - Document owns HSM.
   */
  isRegistered(guid: string): boolean {
    const doc = this._getDocument(guid);
    return doc?.hsm != null;
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
   *
   * @param activeGuids - GUIDs of documents with open editors
   * @param allGuids - All document GUIDs to iterate (required since Document owns HSM)
   */
  setActiveDocuments(activeGuids: Set<string>, allGuids: string[]): void {
    if (this.destroyed) return;

    for (const guid of allGuids) {
      const doc = this._getDocument(guid);
      const hsm = doc?.hsm;
      if (!hsm) continue;

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
    const doc = this._getDocument(guid);
    const hsm = doc?.hsm;
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
    // Transition to warm — hibernate timer will eventually move to hibernated
    this._hibernationState.set(guid, 'warm');
    this.resetHibernateTimer(guid);
  }

  /**
   * Handle a remote update for a document.
   * If hibernated, buffers the update and enqueues a P3 wake.
   * If warm/active, forwards directly to the HSM.
   */
  handleRemoteUpdate(guid: string, update: Uint8Array): void {
    const doc = this._getDocument(guid);
    const hsm = doc?.hsm;
    if (!hsm) return; // Document not found or no HSM - ignore

    const updateError = validateUpdate(update);
    if (updateError) {
      console.error(`[MergeManager] Dropping invalid remote update for ${guid} (${update.byteLength} bytes):`, updateError);
      return;
    }

    const state = this.getHibernationState(guid);

    if (state === 'hibernated') {
      // Buffer update bytes (no YDoc needed) and enqueue wake
      this.enqueueWake({
        guid,
        priority: WakePriority.REMOTE_UPDATE,
        update,
      });
      return;
    }

    // Warm or active: forward to HSM directly
    hsm.send({ type: 'REMOTE_UPDATE', update });

    // Reset hibernate timer if warm
    if (state === 'warm') {
      this.resetHibernateTimer(guid);
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
   * Get HSM without acquiring lock (for inspection/testing).
   * Returns undefined if document is not registered.
   */
  getIdleHSM(guid: string): MergeHSM | undefined {
    const doc = this._getDocument(guid);
    return doc?.hsm ?? undefined;
  }

  /**
   * Destroy MergeManager and clean up resources.
   * Note: Document owns HSMs, so they are not destroyed here.
   * Document.destroy() handles HSM cleanup.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // Clear all hibernate timers
    for (const [guid] of this._hibernateTimers) {
      this.clearHibernateTimer(guid);
    }

    this.activeDocs.clear();
    this._syncStatus.clear();
    this._hibernationState.clear();
    this._hibernationBuffer.clear();
    this._wakeQueue.length = 0;
    this._wakingDocs.clear();
  }

  // ===========================================================================
  // Hibernation Internals
  // ===========================================================================

  /**
   * Buffer a raw update for a hibernated document.
   * Uses Y.mergeUpdates to compact multiple updates into one blob.
   */
  private bufferUpdate(guid: string, update: Uint8Array): void {
    const existing = this._hibernationBuffer.get(guid);
    if (existing) {
      this._hibernationBuffer.set(guid, Y.mergeUpdates([existing, update]));
    } else {
      this._hibernationBuffer.set(guid, update);
    }
  }

  /**
   * Reset (or start) the hibernate timer for a warm document.
   * When the timer fires, the document transitions warm → hibernated.
   */
  private resetHibernateTimer(guid: string): void {
    this.clearHibernateTimer(guid);
    const timerId = this.timeProvider.setTimeout(() => {
      this._hibernateTimers.delete(guid);
      // Only hibernate if still warm (not active)
      if (this.getHibernationState(guid) === 'warm') {
        this.hibernate(guid);
      }
    }, this._hibernateTimeoutMs);
    this._hibernateTimers.set(guid, timerId);
  }

  /**
   * Clear the hibernate timer for a document.
   */
  private clearHibernateTimer(guid: string): void {
    const timerId = this._hibernateTimers.get(guid);
    if (timerId !== undefined) {
      this.timeProvider.clearTimeout(timerId);
      this._hibernateTimers.delete(guid);
    }
  }

  /**
   * Sort the wake queue by priority (lower number = higher priority).
   */
  private sortWakeQueue(): void {
    this._wakeQueue.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Process the wake queue with bounded concurrency.
   * Wakes documents in priority order, up to maxConcurrentWarm.
   */
  private processWakeQueue(): void {
    if (this._isProcessingWakeQueue || this.destroyed) return;
    this._isProcessingWakeQueue = true;

    try {
      while (this._wakeQueue.length > 0 && this._wakingDocs.size < this._maxConcurrentWarm) {
        // Count currently warm (non-active) documents
        let warmCount = 0;
        for (const [, state] of this._hibernationState) {
          if (state === 'warm') warmCount++;
        }

        // Check concurrency limit (warm + currently waking)
        if (warmCount + this._wakingDocs.size >= this._maxConcurrentWarm) {
          break;
        }

        const request = this._wakeQueue.shift()!;
        const currentState = this.getHibernationState(request.guid);

        // Skip if already warm/active
        if (currentState !== 'hibernated') continue;

        const doc = this._getDocument(request.guid);
        const hsm = doc?.hsm;
        if (!hsm) continue;

        this._wakingDocs.add(request.guid);

        // Recreate localDoc destroyed during hibernation
        hsm.ensureLocalDocForIdle();

        // Background wake: drain buffer and mark warm.
        const buffered = this._hibernationBuffer.get(request.guid);
        if (buffered) {
          hsm.send({ type: 'REMOTE_UPDATE', update: buffered });
          this._hibernationBuffer.delete(request.guid);
        }

        this._hibernationState.set(request.guid, 'warm');
        this.resetHibernateTimer(request.guid);
        this._wakingDocs.delete(request.guid);

        // Connect provider if requested (for fork reconciliation)
        if (request.connect) {
          doc.connectForForkReconcile?.().catch(() => {});
        }
      }
    } finally {
      this._isProcessingWakeQueue = false;
    }
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
        // Update LCA cache from HSM's persisted state
        if (effect.state.lca) {
          this._lcaCache.set(guid, {
            contents: effect.state.lca.contents,
            meta: {
              hash: effect.state.lca.hash,
              mtime: effect.state.lca.mtime,
            },
            stateVector: effect.state.lca.stateVector,
          });
        } else {
          this._lcaCache.set(guid, null);
        }

        // Update localStateVector cache
        this._localStateVectorCache.set(guid, effect.state.localStateVector ?? null);

        // Integration layer handles actual IDB persistence via onEffect above
        break;

    }
  }

  /**
   * Update sync status.
   * ObservableMap automatically notifies subscribers when set() is called.
   * Public so Document can update sync status when its HSM state changes.
   */
  updateSyncStatus(guid: string, status: SyncStatus): void {
    // Skip updates during/after destruction to avoid PostOffice teardown errors
    if (this.destroyed) return;
    this._syncStatus.set(guid, status);
  }
}
