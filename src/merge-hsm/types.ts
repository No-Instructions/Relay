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

export interface PersistUpdatesEffect {
  type: 'PERSIST_UPDATES';
  guid: string;
  updates: Uint8Array;
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

export type MergeEffect =
  | DispatchCM6Effect
  | WriteDiskEffect
  | PersistStateEffect
  | PersistUpdatesEffect
  | SyncToRemoteEffect
  | StatusChangedEffect;

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

export interface StoredUpdates {
  guid: string;
  /** Merged update containing all local changes */
  update: Uint8Array;
  /** Computed state vector (avoids loading doc to check) */
  stateVector: Uint8Array;
  updatedAt: number;
}

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
 */
export interface IdleModeState {
  guid: string;
  path: string;
  /** Stored in IndexedDB, not loaded into memory */
  localUpdates: Uint8Array[];
  /** Computed from updates without loading doc */
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

export interface MergeHSMConfig {
  /** Document GUID */
  guid: string;

  /** Virtual path */
  path: string;

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
