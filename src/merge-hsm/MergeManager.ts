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
import { trackAsyncCleanup } from '../reloadUtils';
import { MergeHSM } from './MergeHSM';
import type {
  SyncMachine,
  SyncStatus,
  MergeEffect,
  PersistedMergeState,
  PersistedStateMeta,
  PersistedCanvasState,
  ManagedFile,
  ConflictProvider,
  CreatePersistence,
  PersistenceMetadata,
  LCAState,
  LCAMeta,
  Fork,
  FrontMatterPrimitives,
  MergeEvent,
  ResolveHunkEvent,
  StatePath,
} from './types';
import type { ConflictInfoSnapshot } from './conflict';
import type { TimeProvider } from '../TimeProvider';
import { DefaultTimeProvider } from '../TimeProvider';
import { ObservableMap } from '../observable/ObservableMap';
import { validateUpdate } from '../storage/yjs-validation';
import {
  classifyUpdate as classifyUpdateSV,
  type DecodedDeleteSet,
  decodeUpdateDeleteSet,
  deleteSetContains,
  mergeDecodedDeleteSets,
  snapshotsEqual,
  updateHasDeleteSet,
  type YjsSnapshot,
} from './snapshots';
import { curryLog } from '../debug';
import { trackPromise } from '../trackPromise';
import { ResidencyPool, WakePriority } from './ResidencyPool';
import type { HibernationState, WakeRequest } from './ResidencyPool';

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
  /** Create/return the remote YDoc. */
  ensureRemoteDoc(): import('yjs').Doc;
  // The ManagedFile lifecycle contract, implemented by Document: the
  // residency pool drives documents and managed files uniformly.
  /** Build the working form (idempotent). */
  wake(): void;
  /** Release the working form; false defers (in-flight invoke). */
  tryHibernate(): boolean;
  /** Apply remote update bytes through the file's own machine. */
  applyRemoteUpdate(update: Uint8Array): void;
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

  /** Shared folder GUID for metrics labels. */
  folderGuid?: string;

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
   * Factory to create persistence for localDoc.
   * Production: pass IndexeddbPersistence constructor wrapper.
   */
  createPersistence: CreatePersistence;

  /**
   * Callback to get persistence metadata for a document.
   * Metadata is set on the IndexedDB persistence for recovery/debugging.
   */
  getPersistenceMetadata?: (guid: string, path: string) => PersistenceMetadata;

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

/**
 * Restore a persisted LCA. Records written before snapshots were persisted
 * carry no usable baseline and restore as null; recovery re-derives it.
 */
function restorePersistedLCA(lca: PersistedMergeState['lca']): LCAState | null {
  if (!lca?.snapshot) return null;
  return {
    contents: lca.contents,
    meta: { hash: lca.hash, mtime: lca.mtime },
    snapshot: lca.snapshot,
  };
}

function restorePersistedLCAMeta(lca: LCAMeta | null): LCAState | null {
  if (!lca?.snapshot) return null;
  return {
    contents: null,
    meta: lca.meta,
    snapshot: lca.snapshot,
  };
}

/**
 * Restore a persisted fork. Records written before snapshots were persisted
 * restore as null: the disk-ingested content still sits in localDoc, so
 * classification falls back to ordinary divergence against the LCA.
 */
function restorePersistedFork(fork: PersistedMergeState['fork']): Fork | null {
  if (!fork?.localSnapshot || !fork.remoteSnapshot) return null;
  return {
    base: fork.base,
    localSnapshot: fork.localSnapshot,
    remoteSnapshot: fork.remoteSnapshot,
    origin: fork.origin,
    created: fork.created,
    captureMark: fork.captureMark,
  };
}

function lcaToMeta(lca: LCAState): LCAMeta {
  return {
    meta: lca.meta,
    snapshot: lca.snapshot,
  };
}

function headBytesEqual(
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
    headBytesEqual(a.localSnapshot, b.localSnapshot) &&
    headBytesEqual(a.remoteSnapshot, b.remoteSnapshot)
  );
}

// =============================================================================
// Hibernation Types
// =============================================================================

/** Memory state for a document */
export { WakePriority, ResidencyPool } from './ResidencyPool';
export type { HibernationState, WakeRequest } from './ResidencyPool';
// Residency vocabulary stays importable from this module for existing callers.

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

  // Track destroyed state to prevent operations after cleanup
  private destroyed = false;
  private shuttingDown = false;

  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.residency.shutdown();
    // Tear down each HSM's localPersistence so its IDB connection closes.
    // Document.destroy → releaseLock only triggers a 'release' cleanup
    // (deactivateEditor) and never destroys localPersistence; an open
    // IDBDatabase is registered with Chrome's "Pending activities" tracker
    // and pins the entire module's V8 context (and the Document class
    // definition with it) until the connection closes.
    for (const guid of this._hsmUnsubs.keys()) {
      const hsm = this._getDocument?.(guid)?.hsm;
      if (!hsm) continue;
      trackAsyncCleanup(
        hsm.destroyLocalDoc().catch(() => {}),
        `mergeManager:beginShutdown:destroyLocalDoc:${guid}`,
      );
    }
  }

  // Track initialized state - initialize() must be called before registering HSMs
  private _initialized = false;
  private _initializePromise: Promise<void> | null = null;

  private _warn = curryLog("[MergeManager]", "warn");
  private _error = curryLog("[MergeManager]", "error");

  // LCA cache - bulk-loaded during initialize(), owned by MergeManager
  private _lcaCache = new Map<string, LCAMeta | null>();

  // Lightweight persisted state cache - used to cold-start clean documents
  // without opening each per-document Yjs IndexedDB.
  private _stateMetaCache = new Map<string, PersistedStateMeta>();

  // Local snapshot cache - bulk-loaded during initialize()
  // Used for delete-set-aware sync hints without opening per-document IDBs
  private _localSnapshotCache = new Map<string, Uint8Array | null>();


  // =========================================================================
  // Hibernation State
  // =========================================================================

  /** The folder's residency pool: hibernation, wake queue, LRU, leases. */
  private residency!: ResidencyPool;

  /** Full persisted-state loads requested by active entry. */
  private _activeStateLoads = new Set<string>();

  /**
   * Documents whose initial persisted-state read is still in flight. Their
   * idle mode determination is already queued behind that read, so the
   * workspace scan must not race it with one of its own.
   */
  private _pendingPersistenceLoads = new Set<string>();

  /**
   * Remote state we have actually incorporated locally, tracked as decoded
   * insert clocks for gap detection against later incremental updates.
   */
  private _appliedRemoteSV = new Map<string, Map<number, number>>();

  /**
   * Delete-set companion to _appliedRemoteSV, present once a full-state
   * download has seeded a complete baseline. Together the two are the
   * decoded halves of the applied-remote snapshot. Kept decoded and
   * advanced incrementally per applied update — never re-derived from
   * accumulated update bytes, which would cost O(total history) on every
   * folder event.
   */
  private _appliedRemoteDS = new Map<string, DecodedDeleteSet>();

  /**
   * The sync machine per guid — documents register their MergeHSM at
   * createHSM, canvases their CanvasHSM at managed-file registration.
   * Server-head routing addresses machines through this map without
   * knowing kinds; the machines' own bases answer every comparison, so
   * the merge layer holds no fleet head table.
   */
  private _syncMachines = new Map<string, SyncMachine>();

  /** Per-HSM manager subscription unsubscribers, keyed by guid. */
  private _hsmUnsubs = new Map<string, () => void>();

  /** Bulk-loaded metadata for managed-file records (kind-discriminated). */
  private _managedMetaCache = new Map<string, PersistedStateMeta>();

  /**
   * Per-guid conflict surfaces. Documents register at createHSM; other
   * types register when they can materialize conflicts. The public
   * conflict API is pure delegation — no file-type knowledge here.
   */
  private _conflictProviders = new Map<string, ConflictProvider>();

  // Hibernation configuration
  private _hibernateTimeoutMs: number;
  private _maxConcurrentWarm: number;

  // Configuration
  private _getVaultId: (guid: string) => string;
  private _getDocument: (guid: string) => MergeManagerDocument | undefined;
  private timeProvider: TimeProvider;
  private _folderGuid: string;
  private hashFn?: (contents: string) => Promise<string>;
  private loadAllStates?: () => Promise<PersistedStateMeta[]>;
  private onEffect?: (guid: string, effect: MergeEffect) => void;
  private getDiskState?: (path: string) => Promise<{
    contents: string;
    mtime: number;
    hash: string;
  } | null>;
  private loadState?: (guid: string) => Promise<PersistedMergeState | null>;
  private createPersistence: CreatePersistence;
  private getPersistenceMetadata?: (guid: string, path: string) => PersistenceMetadata;
  private _yaml: FrontMatterPrimitives | null = null;
  private _onTransition?: MergeTransitionCallback;
  private readonly _transitionListeners = new Set<MergeTransitionCallback>();

  constructor(config: MergeManagerConfig) {
    this._getVaultId = config.getVaultId;
    this._getDocument = config.getDocument;
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this._folderGuid = config.folderGuid ?? "unknown";
    this.hashFn = config.hashFn;
    this.loadAllStates = config.loadAllStates;
    this.onEffect = config.onEffect;
    this.getDiskState = config.getDiskState;
    this.loadState = config.loadState;
    this.createPersistence = config.createPersistence;
    this.getPersistenceMetadata = config.getPersistenceMetadata;
    this._yaml = config.yaml ?? null;
    this._onTransition = config.onTransition;

    // Hibernation defaults
    this._hibernateTimeoutMs = config.hibernation?.hibernateTimeoutMs ?? 60_000;
    this._maxConcurrentWarm = config.hibernation?.maxConcurrentWarm ?? 5;

    this.residency = new ResidencyPool({
      timeProvider: this.timeProvider,
      folderGuid: this._folderGuid,
      getDocument: (guid) => this._getDocument(guid),
      isDestroyed: () => this.destroyed,
      isShuttingDown: () => this.shuttingDown,
      hibernateTimeoutMs: this._hibernateTimeoutMs,
      maxConcurrentWarm: this._maxConcurrentWarm,
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Wake queue slot usage for the resource meter UI.
   */
  getWakeQueueStats(): { used: number; pending: number; total: number } {
    return this.residency.getWakeQueueStats();
  }

  getHibernationStateCounts(): Record<HibernationState, number> {
    return this.residency.getHibernationStateCounts();
  }

  shouldMaterializeOnStartup(
    guid: string,
    path: string,
    currentDisk?: { mtime: number; hash?: string } | null,
  ): boolean {
    return !this.canColdStartSynced(guid, path, currentDisk);
  }

  /**
   * Get sync status for all registered documents (ObservableMap per spec).
   */
  get syncStatus(): ObservableMap<string, SyncStatus> {
    return this._syncStatus;
  }

  private canColdStartSynced(
    guid: string,
    path: string,
    currentDisk?: { mtime: number; hash?: string } | null,
  ): boolean {
    const meta = this._stateMetaCache.get(guid);
    if (!meta) return false;
    if (meta.path !== path) return false;
    if (meta.lastStatePath !== 'idle.synced') return false;
    if (meta.hasFork || meta.deferredConflict) return false;
    if (!meta.lcaMeta || !meta.disk) return false;
    if (currentDisk) {
      if (currentDisk.mtime !== meta.disk.mtime) {
        if (currentDisk.hash === undefined) return false;
        if (currentDisk.hash !== meta.disk.hash) return false;
      }
    }
    if (meta.disk.hash !== meta.lcaMeta.meta.hash) return false;
    return this.persistedLocalHeadMatchesLCA(meta);
  }

  private persistedLocalHeadMatchesLCA(meta: PersistedStateMeta): boolean {
    const lca = restorePersistedLCAMeta(meta.lcaMeta);
    if (!lca) return false;

    if (meta.localSnapshot) {
      try {
        return snapshotsEqual(
          { snapshot: meta.localSnapshot },
          { snapshot: lca.snapshot },
        );
      } catch {
        return false;
      }
    }

    // A clean hibernated document may have compacted away its local head.
    // canColdStartSynced() already verified idle.synced, no fork/conflict,
    // and disk hash == LCA hash, so there is no local work to reconstruct.
    return true;
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
   * Prepare an idle conflict for API access without opening an editor view.
   * Hibernated conflicts keep HSM metadata but detach their Yjs docs; the
   * normal wake path recreates those docs and drains any buffered remote data.
   */
  private async prepareHeadlessConflictResolution(guid: string): Promise<MergeHSM> {
    if (this.destroyed) {
      throw new Error(`Cannot prepare headless conflict for ${guid}: merge manager destroyed`);
    }

    const doc = this._getDocument(guid);
    const hsm = doc?.hsm;
    if (!doc || !hsm) {
      throw new Error(`Cannot prepare headless conflict for ${guid}: document not found`);
    }

    if (!hsm.matches('idle.diverged') && !hsm.matches('idle.conflict')) {
      return hsm;
    }

    if (!hsm.getLocalDoc() || !hsm.getRemoteDoc()) {
      const remoteDoc = doc.ensureRemoteDoc();
      if (!remoteDoc) {
        throw new Error(`Cannot prepare headless conflict for ${hsm.path}: remoteDoc unavailable`);
      }
      this.wake(guid, remoteDoc);
    }

    await hsm.awaitPersistenceReady();

    if (!hsm.getLocalDoc() || !hsm.getRemoteDoc()) {
      throw new Error(`Cannot prepare headless conflict for ${hsm.path}: localDoc/remoteDoc not ready`);
    }

    return hsm;
  }

  /**
   * Register a guid's conflict surface. Returns the unsubscriber; the
   * registration also falls away with stopTracking/destroy.
   */
  registerConflictProvider(guid: string, provider: ConflictProvider): () => void {
    this._conflictProviders.set(guid, provider);
    return () => {
      if (this._conflictProviders.get(guid) === provider) {
        this._conflictProviders.delete(guid);
      }
    };
  }

  private conflictProviderFor(guid: string): ConflictProvider {
    const provider = this._conflictProviders.get(guid);
    if (!provider) {
      throw new Error(`No conflict provider registered for ${guid}`);
    }
    return provider;
  }

  /**
   * Re-attach a forked idle document to its own remote replica.
   *
   * A document that forked while resting holds no replica: the machine's
   * pointer was nulled at hibernation while the document's own YDoc stayed
   * live on a connected, synced provider. Reconciliation has nothing to merge
   * against until the two are re-joined. Waking rather than assigning also
   * drains anything buffered while detached and holds off re-hibernation, so
   * the attach cannot be undone before the reconcile reads it.
   *
   * Returns whether the machine now holds a replica.
   */
  prepareForkReconcile(guid: string): boolean {
    const doc = this._getDocument(guid);
    const hsm = doc?.hsm;
    if (!doc || !hsm) return false;
    if (!hsm.hasFork() || !hsm.matches('idle.localAhead')) return false;
    if (hsm.getRemoteDoc()) return true;
    const remoteDoc = doc.ensureRemoteDoc();
    if (!remoteDoc) return false;
    this.wake(guid, remoteDoc);
    return hsm.getRemoteDoc() !== null;
  }

  async getConflictInfo(guid: string): Promise<ConflictInfoSnapshot> {
    return (await this.conflictProviderFor(guid).getConflictInfo()) as ConflictInfoSnapshot;
  }

  async resolveConflict(guid: string, contents: string): Promise<StatePath> {
    return (await this.conflictProviderFor(guid).resolveConflict(contents)) as StatePath;
  }

  async resolveConflictHunk(
    guid: string,
    hunkId: string,
    resolution: ResolveHunkEvent['resolution'],
  ): Promise<StatePath> {
    return (await this.conflictProviderFor(guid).resolveConflictHunk(
      hunkId,
      resolution,
    )) as StatePath;
  }

  /** The MergeHSM-backed conflict dialect (text hunks). */
  private createDocumentConflictProvider(guid: string): ConflictProvider {
    return {
      getConflictInfo: async () => {
        const hsm = await this.prepareHeadlessConflictResolution(guid);
        return hsm.getConflictInfoSnapshot();
      },
      resolveConflict: async (contents: string) => {
        const hsm = await this.prepareHeadlessConflictResolution(guid);
        return hsm.resolveConflictContents(contents);
      },
      resolveConflictHunk: async (hunkId: string, resolution: unknown) => {
        const hsm = await this.prepareHeadlessConflictResolution(guid);
        return hsm.resolveConflictHunk(
          hunkId,
          resolution as ResolveHunkEvent['resolution'],
        );
      },
    };
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
    getCurrentDiskMetadata?: () => { mtime: number; hash?: string } | null;
    getPersistenceMetadata?: () => PersistenceMetadata;
    isFolderConnected?: () => boolean;
  }): MergeHSM {
    const {
      guid,
      getPath,
      remoteDoc,
      getDiskContent,
      getCurrentDiskMetadata,
      getPersistenceMetadata,
      isFolderConnected,
    } = config;

    const hsm = new MergeHSM({
      guid,
      getPath,
      vaultId: this._getVaultId(guid),
      remoteDoc,
      timeProvider: this.timeProvider,
      hashFn: this.hashFn,
      createPersistence: this.createPersistence,
      persistenceMetadata: getPersistenceMetadata?.(),
      diskLoader: getDiskContent,
      isFolderConnected,
      yaml: this._yaml ?? undefined,
    });

    hsm.setOnTransition((info) => {
      this.emitTransition(guid, getPath(), info);
    });

    // Wire effect handler before any events — effects can fire during send().
    const unsubscribeEffects = hsm.subscribe((effect) => {
      if (effect.type === 'REQUEST_HIBERNATE') {
        // Hibernate on next microtask so the current transition completes first
        void Promise.resolve().then(() => this.hibernate(guid));
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
          void Promise.resolve().then(connect);
        }
      }
      // Forward all effects to onEffect handler for IDB persistence etc.
      this.handleHSMEffect(guid, effect);
    });
    const unsubscribeDestroyed = hsm.onDestroyed(() => {
      // Intent edge: stop wake/hibernate now so a destroying HSM is never
      // re-woken or treated as active. Keep the effect subscription and caches
      // until the machine-driven teardown emits its final PERSIST_STATE, then
      // drop them at the terminal edge. The deferred unregister carries this
      // HSM's own teardown bundle: a new HSM registered for the same guid
      // before cleanup settles must keep its subscriptions and providers.
      this.stopTracking(guid);
      void hsm.awaitCleanupSettled().finally(() => this.unregisterHSM(guid, unsubs));
    });
    const unsubscribeConflicts = this.registerConflictProvider(
      guid,
      this.createDocumentConflictProvider(guid),
    );
    const unsubscribeMachine = this.registerSyncMachine(guid, hsm);
    const unsubs = () => {
      unsubscribeEffects();
      unsubscribeDestroyed();
      unsubscribeConflicts();
      unsubscribeMachine();
    };
    this._hsmUnsubs.set(guid, unsubs);

    // Enter loading state — HSM accumulates events until async load completes
    hsm.send({ type: 'LOAD', guid });

    const currentDiskMetadata = getCurrentDiskMetadata?.() ?? null;
    const persistedMeta = this._stateMetaCache.get(guid);
    if (persistedMeta && this.canColdStartSynced(guid, getPath(), currentDiskMetadata)) {
      hsm.send({
        type: 'PERSISTENCE_LOADED',
        lca: restorePersistedLCAMeta(persistedMeta.lcaMeta),
        disk: persistedMeta.disk,
        localSnapshot: persistedMeta.localSnapshot ?? null,
        deferredConflict: persistedMeta.deferredConflict,
        fork: null,
      });
      hsm.send({ type: 'SET_MODE_IDLE_COLD' });
      this.residency.markCold(guid);
      this.residency.updateMetrics();
      return hsm;
    }

    // Async-load full per-document state from IDB (includes lca.contents and fork)
    const loadStateFn = this.loadState ?? (() => Promise.resolve(null));
    this._pendingPersistenceLoads.add(guid);
    loadStateFn(guid).then((state) => {
      this._pendingPersistenceLoads.delete(guid);
      if (this.destroyed) return;
      // Build full LCA from IDB state (the source of truth for contents)
      const lca = restorePersistedLCA(state?.lca ?? null);
      hsm.send({
        type: 'PERSISTENCE_LOADED',
        lca,
        disk: state?.disk ?? null,
        // The session's own look at the file rides along with the persisted
        // record so the load-time guards cannot reach a verdict without it.
        // Sent separately it was silently discarded whenever mode
        // determination had already moved the HSM to a state that ignores it,
        // and the machine then settled as synced on a stale record.
        observedDisk: currentDiskMetadata,
        localSnapshot: state?.localSnapshot ?? null,
        deferredConflict: state?.deferredConflict,
        fork: restorePersistedFork(state?.fork ?? null),
      });
      hsm.send({ type: 'SET_MODE_IDLE' });
      this.residency.updateMetrics();
    }).catch((err) => {
      this._pendingPersistenceLoads.delete(guid);
      this._error(`Failed to load state for ${guid}: ${err}`);
      // On IDB failure, pass null LCA — metadata without contents would
      // produce wrong merge results. The HSM treats null as "no prior state".
      const lca: LCAState | null = null;
      hsm.send({
        type: 'PERSISTENCE_LOADED',
        lca,
        disk: null,
        localSnapshot: this._localSnapshotCache.get(guid) ?? null,
      });
      hsm.send({ type: 'SET_MODE_IDLE' });
      this.residency.updateMetrics();
    });

    return hsm;
  }

  /**
   * Notify MergeManager that an HSM was created for a document.
   * Updates hibernation tracking.
   */
  notifyHSMCreated(guid: string): void {
    if (this.destroyed) return;
    this.residency.notifyHSMCreated(guid);
  }

  /**
   * Intent edge of HSM destruction: drop all in-memory tracking synchronously
   * when destroy() begins, so wake/hibernate races and status reads resolve
   * immediately. The effect subscription is intentionally left in place — only
   * unregisterHSM (terminal edge) removes it, so the cleanup invoke's final
   * PERSIST_STATE is still forwarded.
   */
  private stopTracking(guid: string): void {
    if (this.destroyed) return;
    this.residency.forget(guid);
    this._appliedRemoteSV.delete(guid);
    this._appliedRemoteDS.delete(guid);
    this._syncStatus.delete(guid);
    this._stateMetaCache.delete(guid);
    this._lcaCache.delete(guid);
    this._localSnapshotCache.delete(guid);
    this._managedMetaCache.delete(guid);
    // Conflict providers and sync machines are removed only through their
    // identity-guarded unsubscribes: a raw delete here would take out what
    // a newer HSM registered for the same guid.
  }

  /**
   * Terminal edge of HSM destruction: drop the effect subscription. Runs after
   * awaitCleanupSettled so the cleanup invoke's final PERSIST_STATE is still
   * forwarded to handleHSMEffect. Re-clears the caches the final persist may
   * have repopulated; the deletes are idempotent with stopTracking.
   */
  private unregisterHSM(guid: string, expected?: () => void): void {
    if (this.destroyed) return;
    if (expected && this._hsmUnsubs.get(guid) !== expected) {
      // A newer HSM owns this guid: run only the retiring HSM's own
      // teardown bundle (its conflict unsubscribe is identity-guarded and
      // leaves the new provider in place) and keep the live registration.
      expected();
      return;
    }
    this._hsmUnsubs.get(guid)?.();
    this._hsmUnsubs.delete(guid);
    this.residency.forget(guid);
    this._appliedRemoteSV.delete(guid);
    this._appliedRemoteDS.delete(guid);
    this._syncStatus.delete(guid);
    this._stateMetaCache.delete(guid);
    this._lcaCache.delete(guid);
    this._localSnapshotCache.delete(guid);
    this._managedMetaCache.delete(guid);
    // Conflict providers are removed only through their identity-guarded
    // unsubscribe (part of the bundle above).
  }

  // ===========================================================================
  // Hibernation API
  // ===========================================================================

  /**
   * Get the hibernation state for a document.
   * Returns 'hibernated' for unknown documents.
   */
  getHibernationState(guid: string): HibernationState {
    return this.residency.getState(guid);
  }

  /**
   * Get the buffered update bytes for a hibernated document.
   * Returns null if no updates are buffered.
   */
  getHibernationBuffer(guid: string): Uint8Array | null {
    return this.residency.getBuffer(guid);
  }

  /**
   * Enqueue a wake request for a document.
   * The wake queue processor handles bounded concurrency and priority ordering.
   *
   * For P1 (OPEN_DOC), the caller should also call wake() directly for
   * synchronous/blocking wake (acquireLock needs the doc ready immediately).
   */
  // ===========================================================================
  // Managed files (non-document types on the shared substrate)
  // ===========================================================================

  /**
   * Register a non-document file with the hibernation substrate. Cold
   * registrations start hibernated; warm ones enter the pool and start
   * the hibernate countdown like any other warm file.
   */
  registerManagedFile(file: ManagedFile): void {
    if (this.destroyed) return;
    this.residency.registerManagedFile(file);
  }

  unregisterManagedFile(guid: string): void {
    if (!this.residency.unregisterManagedFile(guid)) return;
    this._managedMetaCache.delete(guid);
    // The sync-machine registration is removed only through its
    // identity-guarded unsubscriber (held by the registering host); a raw
    // delete here would take out a newer file's machine for the same guid.
    this.stopTracking(guid);
  }

  /**
   * A managed file materialized lazily (any content access wakes it).
   * Account the warm slot, deliver updates buffered while it hibernated,
   * and bound the pool. Without the drain, a pending wake request would
   * later be skipped as already-warm and the buffered bytes lost until an
   * unrelated event.
   */
  notifyManagedFileWarm(guid: string): void {
    this.residency.notifyManagedFileWarm(guid);
  }

  /**
   * Synchronously wake a managed file (the P1 analog of wake()): build
   * the working form and drain buffered remote updates.
   */
  wakeManagedFile(guid: string): void {
    this.residency.wakeManagedFile(guid);
  }

  /** Bulk-loaded record metadata for a managed file (cold-start input). */
  getManagedMeta(guid: string): PersistedStateMeta | undefined {
    return this._managedMetaCache.get(guid);
  }

  /**
   * Refresh the managed-file caches from a freshly persisted record,
   * projected into the same lightweight meta shape the cold-start bulk
   * load produces. Without this, server-head comparisons for a
   * re-hibernated file run against its startup-era snapshot forever.
   */
  refreshManagedRecord(state: PersistedCanvasState): void {
    if (this.destroyed) return;
    this._managedMetaCache.set(state.guid, {
      kind: 'canvas',
      guid: state.guid,
      path: state.path,
      folder: state.folder,
      lcaMeta: state.lca
        ? { meta: { hash: state.lca.hash, mtime: state.lca.mtime } }
        : null,
      disk: state.disk,
      localSnapshot: state.localSnapshot ?? null,
      lastStatePath: state.lastStatePath as PersistedStateMeta['lastStatePath'],
      hasFork: false,
      persistedAt: state.persistedAt,
    });
    this._localSnapshotCache.set(state.guid, state.localSnapshot ?? null);
  }

  enqueueWake(request: WakeRequest): void {
    this.residency.enqueueWake(request);
  }

  /**
   * Synchronously wake a hibernated document (for P1 open-doc priority).
   * Drains the hibernation buffer into the HSM immediately.
   * Does NOT connect a provider — the caller (Document.acquireLock) handles that.
   *
   * With `{ lease: true }` the wake also takes a warm lease and returns its
   * release handle: until released, hibernate() and LRU eviction defer, so a
   * background operation's localDoc cannot be destroyed mid-pipeline.
   */
  wake(guid: string, remoteDoc: Y.Doc): void;
  wake(guid: string, remoteDoc: Y.Doc, options: { lease: true }): () => void;
  wake(
    guid: string,
    remoteDoc: Y.Doc,
    options?: { lease: true },
  ): (() => void) | void {
    if (options?.lease) {
      return this.residency.wake(guid, remoteDoc, options);
    }
    this.residency.wake(guid, remoteDoc);
  }

  /**
   * Hibernate a warm document: detach remoteDoc, clear timer.
   * The HSM stays alive with cached state vectors — no YDocs in memory.
   */
  hibernate(guid: string): void {
    this.residency.hibernate(guid);
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

    if (this._initializePromise) {
      return this._initializePromise;
    }

    this._initializePromise = this.initializeCaches().catch((err) => {
      this._initializePromise = null;
      throw err;
    });
    return this._initializePromise;
  }

  private async initializeCaches(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    // Bulk-load lightweight metadata into caches (no lca.contents or fork)
    if (this.loadAllStates) {
      const allMeta = await this.loadAllStates();
      if (this.destroyed) {
        return;
      }
      for (const state of allMeta) {
        // Managed-file records (kind-discriminated) feed the managed meta
        // cache and the local-head cache — server-head comparisons work
        // for hibernated files — but never the document caches.
        if (state.kind === 'canvas') {
          this._managedMetaCache.set(state.guid, state);
          this._localSnapshotCache.set(state.guid, state.localSnapshot ?? null);
          continue;
        }
        this._stateMetaCache.set(state.guid, state);
        this._lcaCache.set(state.guid, state.lcaMeta);
        this._localSnapshotCache.set(state.guid, state.localSnapshot ?? null);
      }
    }

    if (!this.destroyed) {
      this._initialized = true;
    }
  }

  /**
   * Check if an HSM is currently in active mode (lock acquired).
   */
  isActive(guid: string): boolean {
    return this.residency.isActive(guid);
  }

  /**
   * Mark a document as active (lock acquired).
   * Used by Document.acquireLock() after sending ACQUIRE_LOCK directly.
   */
  markActive(guid: string): void {
    this.residency.markActive(guid);
    this.loadFullStateForActiveEntry(guid);
  }

  private loadFullStateForActiveEntry(guid: string): void {
    const hsm = this._getDocument(guid)?.hsm;
    if (!hsm?.needsFullStateForActiveEntry()) return;
    const loadStateFn = this.loadState;
    if (!loadStateFn || this._activeStateLoads.has(guid)) return;

    this._activeStateLoads.add(guid);
    loadStateFn(guid).then((state) => {
      this._activeStateLoads.delete(guid);
      if (this.destroyed || !this.residency.isActive(guid) || this._getDocument(guid)?.hsm !== hsm) return;

      hsm.send({
        type: 'PERSISTENCE_LOADED',
        lca: restorePersistedLCA(state?.lca ?? null),
        disk: state?.disk ?? null,
        localSnapshot: state?.localSnapshot ?? null,
        deferredConflict: state?.deferredConflict,
        fork: restorePersistedFork(state?.fork ?? null),
      });
    }).catch((err) => {
      this._activeStateLoads.delete(guid);
      this._error(`Failed to load full active state for ${guid}: ${err}`);
    });
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
        } else if (!this._pendingPersistenceLoads.has(guid)) {
          // A document whose state read is still in flight already has an
          // idle mode determination queued behind it, sent the moment the
          // record arrives. Sending one now only decides the mode earlier,
          // out of order with the record — so leave it in `loading` and let
          // the load path settle it with the record in hand.
          hsm.send({ type: 'SET_MODE_IDLE' });
        }
      } else if (statePath.startsWith('active.') && !activeGuids.has(guid) && !this.residency.isActive(guid)) {
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
    if (this.residency.isActive(guid)) {
      hsm.send({ type: 'RELEASE_LOCK' });
      // The editor session ends at RELEASE_LOCK: drop the guid from the
      // active set immediately so deferred disconnects and folder-reconnect
      // checks do not observe a live session for the entire cleanup drain.
      this.residency.releaseActive(guid);
      // Wait for cleanup to complete (IndexedDB writes)
      try {
        await trackPromise(`awaitCleanup:${guid}`, hsm.awaitCleanup());
      } catch (error) {
        if (hsm.isDestroyed()) return;
        throw error;
      }
    }

    if (this.destroyed || hsm.isDestroyed() || doc?.hsm !== hsm) return;

    // HSM stays alive in idle.* state; sync status preserved. Cached —
    // the hibernate countdown will eventually move it to hibernated.
    this.residency.markCached(guid);
  }

  /**
   * Handle a remote update for a document.
   * If hibernated, buffers the update and enqueues a P3 wake.
   * If warm/active, forwards directly to the HSM.
   */
  handleRemoteUpdate(guid: string, update: Uint8Array): void {
    const managed = this.residency.getManagedFile(guid);
    if (managed) {
      const managedUpdateError = validateUpdate(update);
      if (managedUpdateError) {
        this._error(`Dropping invalid remote update for ${guid} (${update.byteLength} bytes): ${managedUpdateError}`);
        return;
      }
      if (!managed.isWarm()) {
        this.enqueueWake({
          guid,
          priority: WakePriority.REMOTE_UPDATE,
          update,
        });
        return;
      }
      managed.applyRemoteUpdate(update);
      this.residency.touchWarm(guid);
      return;
    }

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
    if (this.residency.isLoaded(state) && state !== 'active') {
      this.residency.touchWarm(guid);
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
      if (structClassification === 'apply') {
        return 'apply';
      }

      // Struct-stale: novel tombstones are the only thing left that could
      // make this update applicable. With a delete-set baseline the check
      // is exact and O(update); without one, delete-bearing updates remain
      // conservatively applicable because SVs do not encode delete sets.
      const appliedDS = this._appliedRemoteDS.get(guid);
      if (appliedDS) {
        return deleteSetContains(appliedDS, decodeUpdateDeleteSet(update))
          ? 'stale'
          : 'apply';
      }
      if (!updateHasDeleteSet(update)) {
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

      const appliedDS = this._appliedRemoteDS.get(guid);
      if (appliedDS) {
        this._appliedRemoteDS.set(
          guid,
          mergeDecodedDeleteSets(appliedDS, decodeUpdateDeleteSet(update)),
        );
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
      const ds = decodeUpdateDeleteSet(update);
      this._appliedRemoteSV.set(guid, sv);
      this._appliedRemoteDS.set(guid, ds);
    } catch {
      // Parse failure — remove the applied baseline so next event falls back
      // to HTTP keyframe fetch.
      this._appliedRemoteSV.delete(guid);
      this._appliedRemoteDS.delete(guid);
    }
  }

  /**
   * Register a guid's sync machine for server-head routing. Returns the
   * identity-guarded unsubscriber: a newer machine registered for the same
   * guid is never removed by a retiring one's teardown.
   */
  registerSyncMachine(guid: string, machine: SyncMachine): () => void {
    this._syncMachines.set(guid, machine);
    return () => {
      if (this._syncMachines.get(guid) === machine) {
        this._syncMachines.delete(guid);
      }
    };
  }

  /**
   * Route a batch of server heads to their machines. A warm machine gets
   * the signal directly and compares against its own basis; a cold machine
   * is consulted through compareServerHead first — a head it is already
   * current with causes no signal and no wake. Otherwise the signal is
   * delivered (the machine acts from its shell or pockets the head), and a
   * machine left holding pocketed work is woken through the hibernation
   * substrate to act on it.
   */
  serverHeadsReceived(
    heads: Iterable<{ guid: string; snapshot: Uint8Array }>,
  ): void {
    if (this.destroyed) return;
    for (const { guid, snapshot } of heads) {
      const machine = this._syncMachines.get(guid);
      if (!machine) continue;

      let head: YjsSnapshot;
      try {
        // Re-encoding gives map entries the same stable order as local
        // snapshots, so exact matches take the byte-equality fast path.
        head = { snapshot: Y.encodeSnapshot(Y.decodeSnapshot(snapshot)) };
      } catch {
        continue;
      }

      const warm = this.residency.isLoaded(this.getHibernationState(guid));
      if (!warm && machine.compareServerHead(head) === "current") {
        // Provably current: no signal and no wake, but the machine keeps
        // the head so later sweeps skip this file instead of re-proving.
        machine.noteServerHead(head);
        continue;
      }

      machine.send({ type: "SERVER_AHEAD", head });

      // A machine that could not act pocketed the head; wake it so the
      // pocket drains. One that acted from its shell needs no wake.
      if (!warm && machine.getWorkState().workPending) {
        this.enqueueWake({ guid, priority: WakePriority.REMOTE_UPDATE });
      }
    }
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

    this.residency.destroy();

    // Unsubscribe from all HSM effect subscriptions
    for (const unsub of this._hsmUnsubs.values()) {
      unsub();
    }
    this._hsmUnsubs.clear();

    this._syncStatus.clear();
    this._stateMetaCache.clear();
    this._lcaCache.clear();
    this._localSnapshotCache.clear();
    this._appliedRemoteSV.clear();
    this._appliedRemoteDS.clear();
    this._syncMachines.clear();
    this._activeStateLoads.clear();
    this._pendingPersistenceLoads.clear();
    this._managedMetaCache.clear();
    this._conflictProviders.clear();
    // Per-document teardown suppresses metric refreshes after beginShutdown;
    // publish the cleared state once after every tracked collection is empty.
    this.residency.updateMetrics(true);

    // These callbacks close over SharedFolder and related plugin services.
    // Clear them so a retained MergeManager shell does not pin the folder graph.
    this._getVaultId = null as unknown as typeof this._getVaultId;
    this._getDocument = null as unknown as typeof this._getDocument;
    this.timeProvider = null as unknown as typeof this.timeProvider;
    this.hashFn = undefined;
    this.loadAllStates = undefined;
    this.onEffect = undefined;
    this.getDiskState = undefined;
    this.loadState = undefined;
    this.createPersistence = null as unknown as typeof this.createPersistence;
    this.getPersistenceMetadata = undefined;
    this._yaml = null;
    this._onTransition = undefined;
    this._transitionListeners.clear();
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

    // Shutdown drives every HSM through its terminal states, emitting a
    // status change per document. Nothing consumes sync status while the
    // plugin is unloading, and forwarding thousands of these to logging and
    // observers stalls unload for seconds in large folders. Cleanup effects
    // (PERSIST_STATE, SYNC_TO_REMOTE, WRITE_DISK) still flow.
    if (this.shuttingDown && effect.type === 'STATUS_CHANGED') return;

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

      case 'PERSIST_STATE': {
        const restoredLCA = restorePersistedLCA(effect.state.lca);
        this._stateMetaCache.set(guid, {
          guid,
          path: effect.state.path,
          folder: effect.state.folder,
          lcaMeta: restoredLCA ? lcaToMeta(restoredLCA) : null,
          disk: effect.state.disk,
          localSnapshot: effect.state.localSnapshot ?? null,
          lastStatePath: effect.state.lastStatePath,
          deferredConflict: effect.state.deferredConflict,
          hasFork: !!effect.state.fork,
          persistedAt: effect.state.persistedAt,
        });

        // Update LCA metadata cache (no contents — kept lightweight)
        if (restoredLCA) {
          this._lcaCache.set(guid, lcaToMeta(restoredLCA));
        } else {
          this._lcaCache.set(guid, null);
        }

        this._localSnapshotCache.set(guid, effect.state.localSnapshot ?? null);

        // Integration layer handles actual IDB persistence via onEffect above
        break;
      }

    }
  }

  /**
   * Update sync status.
   * ObservableMap automatically notifies subscribers when set() is called.
   * Public so Document can update sync status when its HSM state changes.
   */
  updateSyncStatus(guid: string, status: SyncStatus): void {
    // Skip updates during/after destruction to avoid PostOffice teardown
    // errors, and during shutdown where per-document teardown transitions
    // would churn the observable map with updates nothing consumes.
    if (this.destroyed || this.shuttingDown) return;
    if (syncStatusesEqual(this._syncStatus.get(guid), status)) return;
    this._syncStatus.set(guid, status);
  }
}
