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
import { awaitOnReload } from '../reloadUtils';
import { MergeHSM } from './MergeHSM';
import type {
  SyncStatus,
  MergeEffect,
  PersistedMergeState,
  PersistedStateMeta,
  CreatePersistence,
  PersistenceMetadata,
  LCAState,
  LCAMeta,
  FrontMatterPrimitives,
  MergeEvent,
  StatePath,
} from './types';
import type { TimeProvider } from '../TimeProvider';
import { DefaultTimeProvider } from '../TimeProvider';
import { ObservableMap } from '../observable/ObservableMap';
import { validateUpdate } from '../storage/yjs-validation';
import {
  classifyUpdate as classifyUpdateSV,
  decodeSV,
  snapshotContainsUpdate,
  snapshotFromUpdate,
  svIsAhead,
  updateHasDeleteSet,
} from './state-vectors';
import { metrics, curryLog } from '../debug';
import { trackPromise } from '../trackPromise';

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
  /** Create/return the remote YDoc, seeding from localDoc if needed. */
  ensureRemoteDoc(): import('yjs').Doc;
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
   * Callback to bulk-load lightweight state metadata for cache initialization.
   * Called during initialize() to populate LCA metadata and state vector caches.
   * Production: pass a function that uses getAllStateMeta from MergeHSMDatabase.
   * Tests: can omit for default empty array.
   */
  loadAllStates?: () => Promise<PersistedStateMeta[]>;

  /**
   * Callback to load a single document's persisted state.
   * Called during createHSM to load fork and other per-document data
   * that is too heavy for the bulk cache.
   */
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
  onTransition?: MergeTransitionCallback;

  /**
   * Obsidian's frontmatter logic primitives. Omit to disable frontmatter
   * Y.Map mirroring entirely. Using Obsidian's own `parseYaml`,
   * `stringifyYaml`, and `getFrontMatterInfo` ensures the text we
   * reconstruct matches bit-for-bit what Obsidian produces, so our writes
   * never fight its own.
   */
  yaml?: FrontMatterPrimitives;
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

export interface MergeTransitionInfo {
  from: StatePath;
  to: StatePath;
  event: MergeEvent;
  effects: MergeEffect[];
}

export type MergeTransitionCallback = (
  guid: string,
  path: string,
  info: MergeTransitionInfo,
) => void;

function stateVectorsEqual(
  a: Uint8Array | null | undefined,
  b: Uint8Array | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.byteLength !== b.byteLength) return false;

  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }

  return true;
}

function syncStatusesEqual(a: SyncStatus | undefined, b: SyncStatus): boolean {
  return (
    !!a &&
    a.guid === b.guid &&
    a.status === b.status &&
    a.diskMtime === b.diskMtime &&
    stateVectorsEqual(a.localStateVector, b.localStateVector) &&
    stateVectorsEqual(a.remoteStateVector, b.remoteStateVector)
  );
}

// =============================================================================
// Hibernation Types
// =============================================================================

/** Memory state for a document */
export type HibernationState = 'hibernated' | 'working' | 'cached' | 'active';

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

  private _warn = curryLog("[MergeManager]", "warn");
  private _error = curryLog("[MergeManager]", "error");

  // LCA cache - bulk-loaded during initialize(), owned by MergeManager
  private _lcaCache = new Map<string, LCAMeta | null>();

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

  /**
   * LRU cache of warm document GUIDs. Insertion order = access order
   * (least recently used first). Capacity bounded by _maxConcurrentWarm.
   * When full, the oldest entry is evicted (hibernated) to make room.
   */
  private _warmLRU = new Map<string, number>();

  /** Whether the wake queue processor is currently running. */
  private _isProcessingWakeQueue = false;

  /**
   * Remote state we have actually incorporated locally, tracked as an SV for
   * gap detection against later incremental updates.
   */
  private _appliedRemoteSV = new Map<string, Map<number, number>>();

  /**
   * Remote state we have actually incorporated locally, tracked as a merged
   * full update when available. Used for delete-set-aware stale detection.
   */
  private _appliedRemoteUpdate = new Map<string, Uint8Array>();

  /**
   * Server-advertised head SV from the folder subdoc index. This is metadata
   * about what the server has, not proof of what we have applied locally.
   */
  private _serverAdvertisedSV = new Map<string, Map<number, number>>();

  /** Per-HSM effect subscription unsubscribers, keyed by guid. */
  private _hsmUnsubs = new Map<string, () => void>();

  // Hibernation configuration
  private _hibernateTimeoutMs: number;
  private _maxConcurrentWarm: number;

  // Configuration
  private _getVaultId: (guid: string) => string;
  private _getDocument: (guid: string) => MergeManagerDocument | undefined;
  private timeProvider: TimeProvider;
  private hashFn?: (contents: string) => Promise<string>;
  private loadAllStates?: () => Promise<PersistedStateMeta[]>;
  private onEffect?: (guid: string, effect: MergeEffect) => void;
  private getDiskState?: (path: string) => Promise<{
    contents: string;
    mtime: number;
    hash: string;
  } | null>;
  private _persistIndex?: (status: Map<string, SyncStatus>) => Promise<void>;
  private loadState?: (guid: string) => Promise<PersistedMergeState | null>;
  private createPersistence?: CreatePersistence;
  private getPersistenceMetadata?: (guid: string, path: string) => PersistenceMetadata;
  private userId?: string;
  private _yaml: FrontMatterPrimitives | null = null;
  private _onTransition?: MergeTransitionCallback;
  private readonly _transitionListeners = new Set<MergeTransitionCallback>();

  constructor(config: MergeManagerConfig) {
    this._getVaultId = config.getVaultId;
    this._getDocument = config.getDocument;
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.hashFn = config.hashFn;
    this.loadAllStates = config.loadAllStates;
    this.onEffect = config.onEffect;
    this.getDiskState = config.getDiskState;
    this._persistIndex = config.persistIndex;
    this.loadState = config.loadState;
    this.createPersistence = config.createPersistence;
    this.getPersistenceMetadata = config.getPersistenceMetadata;
    this.userId = config.userId;
    this._yaml = config.yaml ?? null;
    this._onTransition = config.onTransition;

    // Hibernation defaults
    this._hibernateTimeoutMs = config.hibernation?.hibernateTimeoutMs ?? 60_000;
    this._maxConcurrentWarm = config.hibernation?.maxConcurrentWarm ?? 5;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Wake queue slot usage for the resource meter UI.
   */
  getWakeQueueStats(): { used: number; pending: number; total: number } {
    let warmCount = 0;
    for (const [, state] of this._hibernationState) {
      if (state === 'working') warmCount++;
    }
    return {
      used: warmCount + this._wakingDocs.size,
      pending: this._wakeQueue.length,
      total: this._maxConcurrentWarm,
    };
  }

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
   * Set local-only mode on multiple HSMs.
   * When enabled, ops accumulate instead of syncing between localDoc and remoteDoc.
   * When disabled, accumulated ops are flushed.
   */
  setLocalOnly(guids: string[], localOnly: boolean): void {
    for (const guid of guids) {
      const doc = this._getDocument(guid);
      const hsm = doc?.hsm;
      if (hsm) {
        hsm.setLocalOnly(localOnly);
      }
    }
  }

  /**
   * Set the push-based transition callback (used by recording bridge).
   * Applies to every HSM wired through this manager.
   */
  setOnTransition(cb: MergeTransitionCallback): void {
    this._onTransition = cb;
  }

  subscribeToTransitions(listener: MergeTransitionCallback): () => void {
    this._transitionListeners.add(listener);
    return () => {
      this._transitionListeners.delete(listener);
    };
  }

  private emitTransition(
    guid: string,
    path: string,
    info: MergeTransitionInfo,
  ): void {
    this._onTransition?.(guid, path, info);
    for (const listener of Array.from(this._transitionListeners)) {
      try {
        listener(guid, path, info);
      } catch (error) {
        this._error(`transition listener error for ${guid}: ${error}`);
      }
    }
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
    isFolderConnected?: () => boolean;
  }): MergeHSM {
    const {
      guid,
      getPath,
      remoteDoc,
      getDiskContent,
      getPersistenceMetadata,
      isFolderConnected,
    } = config;

    // Get lightweight metadata from cache (bulk-loaded during initialize())
    const lcaMeta = this.getLCAMeta(guid);
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
      isFolderConnected,
      yaml: this._yaml ?? undefined,
    });

    hsm.setOnTransition((info) => {
      this.emitTransition(guid, getPath(), info);
    });

    // Wire effect handler before any events — effects can fire during send().
    const unsub = hsm.subscribe((effect) => {
      if (effect.type === 'REQUEST_HIBERNATE') {
        // Hibernate on next microtask so the current transition completes first
        Promise.resolve().then(() => this.hibernate(guid));
        return;
      }
      if (effect.type === 'REQUEST_PROVIDER_SYNC') {
        const connect = () => {
          const doc = this._getDocument(guid);
          if (!doc) return;
          doc.connectForForkReconcile().catch((err) => {
            this._error(`connectForForkReconcile failed: ${err}`);
          });
        };
        // The document may not be registered in SharedFolder.files yet when
        // this fires synchronously during createHSM. Defer to next microtask
        // so the caller can finish registration first.
        if (this._getDocument(guid)) {
          connect();
        } else {
          Promise.resolve().then(connect);
        }
      }
      // Forward all effects to onEffect handler for IDB persistence etc.
      this.handleHSMEffect(guid, effect);
    });
    this._hsmUnsubs.set(guid, unsub);

    // Enter loading state — HSM accumulates events until async load completes
    hsm.send({ type: 'LOAD', guid });

    // Async-load full per-document state from IDB (includes lca.contents and fork)
    const loadStateFn = this.loadState ?? (() => Promise.resolve(null));
    loadStateFn(guid).then((state) => {
      if (this.destroyed) return;
      // Build full LCA from IDB state (the source of truth for contents)
      const lca: LCAState | null = state?.lca
        ? { contents: state.lca.contents, meta: { hash: state.lca.hash, mtime: state.lca.mtime }, stateVector: state.lca.stateVector }
        : null;
      hsm.send({
        type: 'PERSISTENCE_LOADED',
        updates: new Uint8Array(),
        lca,
        localStateVector,
        fork: state?.fork ?? null,
      });
      hsm.send({ type: 'SET_MODE_IDLE' });
    }).catch((err) => {
      this._error(`Failed to load state for ${guid}: ${err}`);
      // On IDB failure, pass null LCA — metadata without contents would
      // produce wrong merge results. The HSM treats null as "no prior state".
      const lca: LCAState | null = null;
      hsm.send({
        type: 'PERSISTENCE_LOADED',
        updates: new Uint8Array(),
        lca,
        localStateVector,
      });
      hsm.send({ type: 'SET_MODE_IDLE' });
    });

    return hsm;
  }

  /**
   * Notify MergeManager that an HSM was created for a document.
   * Updates hibernation tracking.
   */
  notifyHSMCreated(guid: string): void {
    if (this.destroyed) return;
    this._hibernationState.set(guid, 'cached');
    this.resetHibernateTimer(guid);
  }

  /**
   * Notify MergeManager that an HSM was destroyed for a document.
   * Cleans up hibernation tracking.
   */
  notifyHSMDestroyed(guid: string): void {
    if (this.destroyed) return;
    this._hsmUnsubs.get(guid)?.();
    this._hsmUnsubs.delete(guid);
    this._hibernationState.delete(guid);
    this._hibernationBuffer.delete(guid);
    this._appliedRemoteSV.delete(guid);
    this._appliedRemoteUpdate.delete(guid);
    this._serverAdvertisedSV.delete(guid);
    this.clearHibernateTimer(guid);
    this.removeFromWarmLRU(guid);
    this._syncStatus.delete(guid);
    this.activeDocs.delete(guid);
    this._lcaCache.delete(guid);
    this._localStateVectorCache.delete(guid);
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

  private isLoaded(state: HibernationState): boolean {
    return state === 'working' || state === 'cached' || state === 'active';
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
    if (this.isLoaded(currentState)) {
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
    this._updateWakeQueueMetrics();
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

    this._hibernationState.set(guid, 'cached');
    this.resetHibernateTimer(guid);
    this._updateWakeQueueMetrics();
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
      // If an async invoke (idle-merge, fork-reconcile) is running, defer
      // hibernation so the work can finish rather than aborting mid-merge.
      if (hsm.getActiveInvoke()) {
        this.resetHibernateTimer(guid);
        return;
      }
      hsm.setRemoteDoc(null);
      // destroyLocalDoc() nulls out references synchronously, then does
      // async IDB cleanup on the captured refs. Fire-and-forget is safe
      // because wake → ensureLocalDocForIdle() creates fresh instances,
      // but the IDB cleanup must complete before plugin reload.
      awaitOnReload(hsm.destroyLocalDoc());
    }

    this.clearHibernateTimer(guid);
    this.removeFromWarmLRU(guid);
    this._hibernationState.set(guid, 'hibernated');
    this._updateWakeQueueMetrics();
    this.processWakeQueue();
  }

  // ===========================================================================
  // LCA Cache (Gap 7: MergeManager owns reads AND writes)
  // ===========================================================================

  /**
   * Get LCA metadata from cache (synchronous, no contents string).
   * The cache is populated during initialize() via bulk load.
   */
  getLCAMeta(guid: string): LCAMeta | null {
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
    // Update cache with metadata only (no contents string)
    this._lcaCache.set(guid, lca
      ? { meta: lca.meta, stateVector: lca.stateVector }
      : null
    );

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
        fork: hsm.state.fork,
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

    // Bulk-load lightweight metadata into caches (no lca.contents or fork)
    if (this.loadAllStates) {
      const allMeta = await this.loadAllStates();
      for (const state of allMeta) {
        this._lcaCache.set(state.guid, state.lcaMeta);

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
    this.removeFromWarmLRU(guid);
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
    if (this.destroyed) return;
    const doc = this._getDocument(guid);
    const hsm = doc?.hsm;
    if (!hsm) return;

    // Only send RELEASE_LOCK if currently active
    if (this.activeDocs.has(guid)) {
      hsm.send({ type: 'RELEASE_LOCK' });
      this.activeDocs.delete(guid);
      // Wait for cleanup to complete (IndexedDB writes)
      await trackPromise(`awaitCleanup:${guid}`, hsm.awaitCleanup());
    }

    if (this.destroyed) return;

    // HSM stays alive in idle.* state
    // Sync status preserved
    // Transition to cached — hibernate timer will eventually move to hibernated
    this._hibernationState.set(guid, 'cached');
    this.touchWarmLRU(guid);
    this.resetHibernateTimer(guid);
    this._updateWakeQueueMetrics();
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
      this._error(`Dropping invalid remote update for ${guid} (${update.byteLength} bytes): ${updateError}`);
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

    // Touch LRU and reset hibernate timer if warm
    if (this.isLoaded(state) && state !== 'active') {
      this.touchWarmLRU(guid);
      this.resetHibernateTimer(guid);
    }
  }

  // ===========================================================================
  // Gap Detection API (remote update optimization)
  // ===========================================================================

  /**
   * Classify an incremental remote update relative to the remote state we have
   * already applied locally.
   * - 'apply': contiguous, safe to deliver and advance the applied baseline
   * - 'stale': all ops already covered by the applied baseline, safe to drop
   * - 'gap': no applied baseline exists, or the update depends on missing ops
   */
  classifyUpdate(guid: string, update: Uint8Array): 'apply' | 'stale' | 'gap' {
    try {
      const appliedSV = this._appliedRemoteSV.get(guid);
      const structClassification = classifyUpdateSV(update, appliedSV);
      if (structClassification === 'gap') {
        return 'gap';
      }

      const appliedUpdate = this._appliedRemoteUpdate.get(guid);
      if (appliedUpdate) {
        const appliedSnapshot = snapshotFromUpdate(appliedUpdate);
        return snapshotContainsUpdate(appliedSnapshot, update) ? 'stale' : 'apply';
      }

      // When only an applied SV is available, we can still drop clearly stale
      // struct-only updates. Delete-bearing updates remain conservatively
      // applicable because SVs do not encode delete sets.
      if (structClassification === 'stale' && !updateHasDeleteSet(update)) {
        return 'stale';
      }

      return 'apply';
    } catch {
      return 'gap';
    }
  }


  /**
   * After successfully applying an incremental update, merge its per-client
   * clocks into the applied remote SV (taking the max for each client).
   */
  advanceAppliedRemoteUpdate(guid: string, update: Uint8Array): void {
    let applied = this._appliedRemoteSV.get(guid);
    if (!applied) {
      applied = new Map();
      this._appliedRemoteSV.set(guid, applied);
    }

    try {
      const updateSVBytes = Y.encodeStateVectorFromUpdate(update);
      const updateSV = Y.decodeStateVector(updateSVBytes);

      for (const [clientId, clock] of updateSV) {
        const existing = applied.get(clientId) ?? 0;
        applied.set(clientId, Math.max(existing, clock));
      }

      const appliedUpdate = this._appliedRemoteUpdate.get(guid);
      if (appliedUpdate) {
        this._appliedRemoteUpdate.set(guid, Y.mergeUpdates([appliedUpdate, update]));
      }
    } catch {
      // Parse failure — leave applied baseline unchanged
    }
  }

  /**
   * After an HTTP full-sync, replace the applied remote baseline for this
   * document. The full-state update represents complete remote state, so we
   * replace rather than merge.
   */
  seedAppliedRemoteUpdate(guid: string, update: Uint8Array): void {
    try {
      const svBytes = Y.encodeStateVectorFromUpdate(update);
      const sv = Y.decodeStateVector(svBytes);
      this._appliedRemoteSV.set(guid, sv);
      this._appliedRemoteUpdate.set(guid, update);
    } catch {
      // Parse failure — remove the applied baseline so next event falls back
      // to HTTP keyframe fetch.
      this._appliedRemoteSV.delete(guid);
      this._appliedRemoteUpdate.delete(guid);
    }
  }

  /**
   * Record the server-advertised head SV directly from raw state vector bytes.
   * This is reconnect metadata only. It must not be used to decide whether an
   * incremental payload is stale because SVs do not encode delete sets and do
   * not prove local application.
   */
  seedServerAdvertisedSVFromBytes(guid: string, svBytes: Uint8Array): void {
    try {
      const sv = Y.decodeStateVector(svBytes);
      this._serverAdvertisedSV.set(guid, sv);
    } catch {
      this._serverAdvertisedSV.delete(guid);
    }
  }

  /**
   * Return true when the folder subdoc index says the server has operations
   * newer than the local state we know about. This is only a transport hint:
   * state vectors do not encode delete sets, so callers should use it to
   * decide whether to connect a provider, not to declare convergence.
   */
  isServerAdvertisedRemoteAhead(guid: string): boolean {
    const advertisedSV = this._serverAdvertisedSV.get(guid);
    if (!advertisedSV) return false;

    const localSVBytes = this.getKnownLocalStateVector(guid);
    if (!localSVBytes) {
      return advertisedSV.size > 0;
    }

    try {
      return svIsAhead(advertisedSV, decodeSV(localSVBytes));
    } catch {
      return true;
    }
  }

  private getKnownLocalStateVector(guid: string): Uint8Array | null {
    const hsm = this._getDocument(guid)?.hsm;
    const hsmStateVector = hsm?.state.localStateVector;
    if (hsmStateVector) return hsmStateVector;

    const cachedStateVector = this._localStateVectorCache.get(guid);
    if (cachedStateVector) return cachedStateVector;

    return this._lcaCache.get(guid)?.stateVector ?? null;
  }

  /**
   * Clear the server-advertised reconnect metadata for all documents. The
   * applied remote baseline is preserved across reconnects because it reflects
   * what this vault has already incorporated locally.
   */
  clearServerAdvertisedSVs(): void {
    this._serverAdvertisedSV.clear();
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

    // Unsubscribe from all HSM effect subscriptions
    for (const unsub of this._hsmUnsubs.values()) {
      unsub();
    }
    this._hsmUnsubs.clear();

    this.activeDocs.clear();
    this._syncStatus.clear();
    this._hibernationState.clear();
    this._hibernationBuffer.clear();
    this._appliedRemoteSV.clear();
    this._appliedRemoteUpdate.clear();
    this._serverAdvertisedSV.clear();
    this._wakeQueue.length = 0;
    this._wakingDocs.clear();
    this._warmLRU.clear();

    // These callbacks close over SharedFolder and related plugin services.
    // Clear them so a retained MergeManager shell does not pin the folder graph.
    this._getVaultId = null as any;
    this._getDocument = null as any;
    this.timeProvider = null as any;
    this.hashFn = undefined;
    this.loadAllStates = undefined;
    this.onEffect = undefined;
    this.getDiskState = undefined;
    this._persistIndex = undefined;
    this.loadState = undefined;
    this.createPersistence = undefined;
    this.getPersistenceMetadata = undefined;
    this.userId = undefined;
    this._yaml = null;
    this._onTransition = undefined;
    this._transitionListeners.clear();
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
      // Only hibernate if still loaded but not active
      const s = this.getHibernationState(guid);
      if (s === 'working' || s === 'cached') {
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
   * Touch a document in the warm LRU cache (move to most-recent position).
   * Resets the hibernate timer since the doc is actively receiving updates.
   */
  private touchWarmLRU(guid: string): void {
    if (this.destroyed || !this.timeProvider) {
      return;
    }
    this._warmLRU.delete(guid);
    this._warmLRU.set(guid, this.timeProvider.now());
  }

  /**
   * Remove a document from the warm LRU cache.
   */
  private removeFromWarmLRU(guid: string): void {
    this._warmLRU.delete(guid);
  }

  /**
   * Evict the least recently used warm doc to free a slot.
   * Skips docs with active async invokes (they shouldn't be interrupted).
   * Returns true if a slot was freed.
   */
  private evictLRU(): boolean {
    for (const [guid] of this._warmLRU) {
      const doc = this._getDocument(guid);
      const hsm = doc?.hsm;
      // Skip docs with in-flight async work
      if (hsm?.getActiveInvoke()) continue;
      // Skip active docs (shouldn't be in LRU, but guard anyway)
      if (this.getHibernationState(guid) === 'active') continue;
      this.hibernate(guid);
      return true;
    }
    return false;
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
          if (state === 'working') warmCount++;
        }

        // Check concurrency limit (warm + currently waking)
        if (warmCount + this._wakingDocs.size >= this._maxConcurrentWarm) {
          // Try to evict the least recently used warm doc to free a slot
          if (!this.evictLRU()) {
            break; // All warm docs have active invokes — can't evict
          }
          continue; // Slot freed — re-check counts on next iteration
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
        // When buffered remote updates exist, attach a remoteDoc so the
        // HSM can read remote content during three-way merge. Without this,
        // the REMOTE_UPDATE action drops the data and conflicts show empty "theirs".
        const buffered = this._hibernationBuffer.get(request.guid);
        if (buffered) {
          const remoteDoc = doc.ensureRemoteDoc();
          hsm.setRemoteDoc(remoteDoc);
          hsm.send({ type: 'REMOTE_UPDATE', update: buffered });
          this._hibernationBuffer.delete(request.guid);
        }

        this._hibernationState.set(request.guid, 'working');
        this.touchWarmLRU(request.guid);
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
    this._updateWakeQueueMetrics();
  }

  private _updateWakeQueueMetrics(): void {
    const stats = this.getWakeQueueStats();
    metrics.setWakeQueueSlots(stats.used, stats.pending, stats.total);
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
      Promise.resolve(this.onEffect(guid, effect)).catch((err) => {
        this._error(`onEffect error for ${guid}: ${err}`);
      });
    }

    // Handle specific effects
    switch (effect.type) {
      case 'STATUS_CHANGED':
        this.updateSyncStatus(guid, effect.status);
        break;

      case 'PERSIST_STATE':
        // Update LCA metadata cache (no contents — kept lightweight)
        if (effect.state.lca) {
          this._lcaCache.set(guid, {
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
    if (syncStatusesEqual(this._syncStatus.get(guid), status)) return;
    this._syncStatus.set(guid, status);
  }
}
