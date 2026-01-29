/**
 * Merge HSM Types
 *
 * Core type definitions for the hierarchical state machine that manages
 * document synchronization between disk, local CRDT, and remote CRDT.
 */

// =============================================================================
// Metadata Types
// =============================================================================

export interface MergeMetadata {
  /** File contents hash (SHA-256) */
  hash: string;

  /** Modification time (ms since epoch) */
  mtime: number;
}

export interface LCAState {
  /** The contents at the sync point */
  contents: string;

  /** Metadata at sync point */
  meta: MergeMetadata;

  /** Yjs state vector at this point (base64 encoded for serialization) */
  stateVector: Uint8Array;
}

// =============================================================================
// State Types
// =============================================================================

export type SyncStatusType = 'synced' | 'pending' | 'conflict' | 'error';

export interface SyncStatus {
  guid: string;
  path: string;
  status: SyncStatusType;
  diskMtime: number;
  localStateVector: Uint8Array;
  remoteStateVector: Uint8Array;
}

export interface MergeState {
  /** Document GUID */
  guid: string;

  /** Virtual path within shared folder */
  path: string;

  /** Last Common Ancestor state */
  lca: LCAState | null;

  /** Current disk metadata */
  disk: MergeMetadata | null;

  /** Current local CRDT state vector */
  localStateVector: Uint8Array | null;

  /** Current remote CRDT state vector */
  remoteStateVector: Uint8Array | null;

  /** Current HSM state path (e.g., "idle.clean", "active.tracking") */
  statePath: StatePath;

  /** Error information if in error state */
  error?: Error;

  /**
   * Deferred conflict tracking.
   * When user dismisses a conflict, we store the hashes to avoid re-showing.
   */
  deferredConflict?: {
    diskHash: string;
    localHash: string;
  };
}

// =============================================================================
// State Path Types (Discriminated Union)
// =============================================================================

export type StatePath =
  | 'unloaded'
  | 'loading.loadingPersistence'
  | 'loading.loadingLCA'
  | 'idle.clean'
  | 'idle.localAhead'
  | 'idle.remoteAhead'
  | 'idle.diskAhead'
  | 'idle.diverged'
  | 'idle.error'
  | 'active.entering'
  | 'active.tracking'
  | 'active.merging'
  | 'active.conflict.blocked'
  | 'active.conflict.bannerShown'
  | 'active.conflict.resolving'
  | 'unloading';

// =============================================================================
// Event Types
// =============================================================================

export interface PositionedChange {
  from: number;
  to: number;
  insert: string;
}

// External Events
export interface LoadEvent {
  type: 'LOAD';
  guid: string;
  path: string;
}

export interface UnloadEvent {
  type: 'UNLOAD';
}

export interface AcquireLockEvent {
  type: 'ACQUIRE_LOCK';
}

export interface ReleaseLockEvent {
  type: 'RELEASE_LOCK';
}

export interface DiskChangedEvent {
  type: 'DISK_CHANGED';
  contents: string;
  mtime: number;
  hash: string;
}

export interface RemoteUpdateEvent {
  type: 'REMOTE_UPDATE';
  update: Uint8Array;
}

export interface SaveCompleteEvent {
  type: 'SAVE_COMPLETE';
  mtime: number;
  hash: string;
}

export interface CM6ChangeEvent {
  type: 'CM6_CHANGE';
  changes: PositionedChange[];
  docText: string;
  isFromYjs: boolean;
}

export interface ProviderSyncedEvent {
  type: 'PROVIDER_SYNCED';
}

export interface ConnectedEvent {
  type: 'CONNECTED';
}

export interface DisconnectedEvent {
  type: 'DISCONNECTED';
}

// User Events
export interface ResolveAcceptDiskEvent {
  type: 'RESOLVE_ACCEPT_DISK';
}

export interface ResolveAcceptLocalEvent {
  type: 'RESOLVE_ACCEPT_LOCAL';
}

export interface ResolveAcceptMergedEvent {
  type: 'RESOLVE_ACCEPT_MERGED';
  contents: string;
}

export interface DismissConflictEvent {
  type: 'DISMISS_CONFLICT';
}

export interface OpenDiffViewEvent {
  type: 'OPEN_DIFF_VIEW';
}

export interface CancelEvent {
  type: 'CANCEL';
}

// Internal Events
export interface PersistenceLoadedEvent {
  type: 'PERSISTENCE_LOADED';
  updates: Uint8Array;
  lca: LCAState | null;
}

export interface YDocsReadyEvent {
  type: 'YDOCS_READY';
}

export interface MergeSuccessEvent {
  type: 'MERGE_SUCCESS';
  newLCA: LCAState;
}

export interface MergeConflictEvent {
  type: 'MERGE_CONFLICT';
  base: string;
  local: string;
  remote: string;
  conflictRegions?: ConflictRegion[];
}

// Per-hunk conflict resolution event
export interface ResolveHunkEvent {
  type: 'RESOLVE_HUNK';
  index: number;
  resolution: 'local' | 'remote' | 'both';
}

export interface RemoteDocUpdatedEvent {
  type: 'REMOTE_DOC_UPDATED';
}

export interface ErrorEvent {
  type: 'ERROR';
  error: Error;
}

export type MergeEvent =
  // External
  | LoadEvent
  | UnloadEvent
  | AcquireLockEvent
  | ReleaseLockEvent
  | DiskChangedEvent
  | RemoteUpdateEvent
  | SaveCompleteEvent
  | CM6ChangeEvent
  | ProviderSyncedEvent
  | ConnectedEvent
  | DisconnectedEvent
  // User
  | ResolveAcceptDiskEvent
  | ResolveAcceptLocalEvent
  | ResolveAcceptMergedEvent
  | DismissConflictEvent
  | OpenDiffViewEvent
  | CancelEvent
  | ResolveHunkEvent
  // Internal
  | PersistenceLoadedEvent
  | YDocsReadyEvent
  | MergeSuccessEvent
  | MergeConflictEvent
  | RemoteDocUpdatedEvent
  | ErrorEvent;

// =============================================================================
// Effect Types
// =============================================================================

export interface DispatchCM6Effect {
  type: 'DISPATCH_CM6';
  changes: PositionedChange[];
}

export interface WriteDiskEffect {
  type: 'WRITE_DISK';
  path: string;
  contents: string;
}

export interface PersistStateEffect {
  type: 'PERSIST_STATE';
  guid: string;
  state: PersistedMergeState;
}

/**
 * Persist Yjs updates to y-indexeddb.
 * Integration layer should use appendUpdateRaw() from y-indexeddb.
 */
export interface PersistUpdatesEffect {
  type: 'PERSIST_UPDATES';
  /** Database name for y-indexeddb: `${appId}-relay-doc-${guid}` */
  dbName: string;
  /** The Yjs update to persist */
  update: Uint8Array;
}

export interface SyncToRemoteEffect {
  type: 'SYNC_TO_REMOTE';
  update: Uint8Array;
}

export interface StatusChangedEffect {
  type: 'STATUS_CHANGED';
  guid: string;
  status: SyncStatus;
}

/**
 * Positioned conflict region with character offsets for CM6 decorations.
 */
export interface PositionedConflict {
  /** Index in the conflict regions array */
  index: number;
  /** Character position where conflict starts in editor */
  localStart: number;
  /** Character position where conflict ends in editor */
  localEnd: number;
  /** Content from local version */
  localContent: string;
  /** Content from remote/disk version */
  remoteContent: string;
}

/**
 * Effect to show inline conflict decorations in the editor.
 */
export interface ShowConflictDecorationsEffect {
  type: 'SHOW_CONFLICT_DECORATIONS';
  conflictRegions: ConflictRegion[];
  positions: PositionedConflict[];
}

/**
 * Effect to hide a specific conflict decoration after resolution.
 */
export interface HideConflictDecorationEffect {
  type: 'HIDE_CONFLICT_DECORATION';
  index: number;
}

export type MergeEffect =
  | DispatchCM6Effect
  | WriteDiskEffect
  | PersistStateEffect
  | PersistUpdatesEffect
  | SyncToRemoteEffect
  | StatusChangedEffect
  | ShowConflictDecorationsEffect
  | HideConflictDecorationEffect;

// =============================================================================
// Persistence Types
// =============================================================================

export interface PersistedMergeState {
  guid: string;
  path: string;
  lca: {
    contents: string;
    hash: string;
    mtime: number;
    stateVector: Uint8Array;
  } | null;
  disk: MergeMetadata | null;
  localStateVector: Uint8Array | null;
  lastStatePath: StatePath;
  deferredConflict?: {
    diskHash: string;
    localHash: string;
  };
  persistedAt: number;
}

// NOTE: StoredUpdates has been removed.
// Yjs updates are stored in y-indexeddb per-document databases,
// NOT in MergeHSMDatabase. This ensures compatibility with existing documents.
//
// To work with Yjs updates without loading a YDoc, use the doc-less
// operations from y-indexeddb:
//   - loadUpdatesRaw(dbName)
//   - appendUpdateRaw(dbName, update)
//   - getMergedStateWithoutDoc(dbName)

/**
 * Folder-level sync status index.
 * Stored in IndexedDB 'index' store.
 */
export interface MergeIndex {
  folderGuid: string;
  documents: Map<string, SyncStatus>;
  updatedAt: number;
}

/**
 * Lightweight idle mode state.
 * No YDocs in memory, just state vectors and updates.
 *
 * NOTE: Yjs updates (localUpdates) are stored in y-indexeddb per-document
 * databases, NOT in MergeHSMDatabase. Access via:
 *   - loadUpdatesRaw(dbName) - load raw updates
 *   - getMergedStateWithoutDoc(dbName) - get merged update + state vector
 */
export interface IdleModeState {
  guid: string;
  path: string;
  /**
   * Database name for y-indexeddb access.
   * Convention: `${appId}-relay-doc-${guid}`
   */
  yIndexedDbName: string;
  /** Computed from updates without loading doc (via getMergedStateWithoutDoc) */
  localStateVector: Uint8Array;
  /** LCA for comparison */
  lca: LCAState;
  /** Sync status for UI */
  syncStatus: 'synced' | 'pending' | 'conflict';
}

// =============================================================================
// Configuration Types
// =============================================================================

// Re-export TimeProvider from existing module for consistency
import type { TimeProvider } from '../TimeProvider';
export type { TimeProvider };

// Import Y.Doc type for remoteDoc
import type * as Y from 'yjs';

/**
 * Minimal interface for IndexedDB-backed YDoc persistence.
 * Allows injection for testing (mock) vs production (IndexeddbPersistence).
 */
export interface IYDocPersistence {
  once(event: 'synced', cb: () => void): void;
  destroy(): void | Promise<void>;
  /** Set metadata key-value pair on the persistence store */
  set?(key: string, value: string): void;
}

/**
 * Metadata to store on the persistence for recovery/debugging.
 */
export interface PersistenceMetadata {
  path: string;
  relay: string;
  appId: string;
  s3rn: string;
}

/**
 * Factory that creates a persistence instance for a YDoc.
 * Production: creates IndexeddbPersistence(vaultId, doc).
 * Testing: can return a mock that fires 'synced' synchronously.
 */
export type CreatePersistence = (vaultId: string, doc: Y.Doc) => IYDocPersistence;

export interface MergeHSMConfig {
  /** Document GUID */
  guid: string;

  /** Virtual path */
  path: string;

  /**
   * Vault ID for y-indexeddb persistence.
   * Convention: `${appId}-relay-doc-${guid}`
   */
  vaultId: string;

  /**
   * Remote YDoc - passed in, managed externally.
   * Provider is attached by integration layer.
   * HSM observes for remote updates.
   */
  remoteDoc: Y.Doc;

  /** Time provider (for testing) */
  timeProvider?: TimeProvider;

  /** Hash function (default: SHA-256 via SubtleCrypto) */
  hashFn?: (contents: string) => Promise<string>;

  /**
   * Factory to create persistence for localDoc.
   * Defaults to IndexeddbPersistence from y-indexeddb.
   * Override in tests with a mock.
   */
  createPersistence?: CreatePersistence;

  /**
   * Metadata to store on the persistence for recovery/debugging.
   * Set after persistence syncs.
   */
  persistenceMetadata?: PersistenceMetadata;
}

// =============================================================================
// Merge Result Types
// =============================================================================

export interface MergeSuccess {
  success: true;
  merged: string;
  patches: PositionedChange[];
}

export interface MergeFailure {
  success: false;
  base: string;
  local: string;
  remote: string;
  conflictRegions: ConflictRegion[];
}

export interface ConflictRegion {
  baseStart: number;
  baseEnd: number;
  localContent: string;
  remoteContent: string;
}

export type MergeResult = MergeSuccess | MergeFailure;

// =============================================================================
// Serialization Helpers (for future recording support)
// =============================================================================

/**
 * Serializable snapshot of HSM state.
 * All Uint8Array fields are base64 encoded.
 */
export interface SerializableSnapshot {
  timestamp: number;
  state: {
    guid: string;
    path: string;
    statePath: StatePath;
    lca: {
      contents: string;
      hash: string;
      mtime: number;
      stateVector: string; // base64
    } | null;
    disk: MergeMetadata | null;
    localStateVector: string | null; // base64
    remoteStateVector: string | null; // base64
    error?: string;
    deferredConflict?: {
      diskHash: string;
      localHash: string;
    };
  };
  localDocText: string | null;
  remoteDocText: string | null;
}

/**
 * Serializable event (Uint8Array as base64).
 */
export interface SerializableEvent {
  type: MergeEvent['type'];
  [key: string]: unknown;
}
