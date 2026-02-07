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

  /** Current HSM state path (e.g., "idle.synced", "active.tracking") */
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

  /**
   * Network connectivity status.
   * Does not block state transitions; affects sync behavior only.
   */
  isOnline: boolean;

  /**
   * Editor content received from ACQUIRE_LOCK.
   * Available during active.entering while YDocs are loading.
   * Cleared after successful entry to active.tracking.
   */
  pendingEditorContent?: string;

  /**
   * Last known editor text from CM6_CHANGE events.
   * Updated whenever the editor content changes.
   * Used for drift detection and merge operations.
   */
  lastKnownEditorText?: string;
}

// =============================================================================
// State Path Types (Discriminated Union)
// =============================================================================

export type StatePath =
  | 'unloaded'
  | 'loading'
  | 'idle.loading'
  | 'idle.synced'
  | 'idle.localAhead'
  | 'idle.remoteAhead'
  | 'idle.diskAhead'
  | 'idle.diverged'
  | 'idle.error'
  | 'active.loading'
  | 'active.entering'
  | 'active.entering.awaitingPersistence'
  | 'active.entering.awaitingRemote'
  | 'active.entering.reconciling'
  | 'active.tracking'
  | 'active.merging.twoWay'
  | 'active.merging.threeWay'
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
  /**
   * The current editor/disk content at the moment of opening.
   * Since the editor content equals the disk content when a file is first opened
   * (before CRDT loads), this provides accurate disk content for merge operations.
   * v6: Required parameter to fix BUG-022 (data loss on RESOLVE_ACCEPT_DISK).
   */
  editorContent: string;
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

// Mode Determination Events (sent by MergeManager)
/**
 * MergeManager signals this HSM should be in active mode.
 * Transitions from `loading` → `active.loading`.
 */
export interface SetModeActiveEvent {
  type: 'SET_MODE_ACTIVE';
}

/**
 * MergeManager signals this HSM should be in idle mode.
 * Transitions from `loading` → `idle.loading`.
 */
export interface SetModeIdleEvent {
  type: 'SET_MODE_IDLE';
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

export interface PersistenceSyncedEvent {
  type: 'PERSISTENCE_SYNCED';
  hasContent: boolean;
}

/**
 * Initialize a document with content and LCA.
 * Creates localDoc, inserts content, sets LCA, syncs to remote, transitions to ready.
 * Used for newly created documents.
 */
export interface InitializeWithContentEvent {
  type: 'INITIALIZE_WITH_CONTENT';
  content: string;
  hash: string;
  mtime: number;
}

/**
 * Initialize LCA for a document that already has content in the CRDT.
 * Sets the LCA, transitions to ready.
 * Used when downloading a document that already exists in the remote CRDT.
 */
export interface InitializeLCAEvent {
  type: 'INITIALIZE_LCA';
  content: string;
  hash: string;
  mtime: number;
}

/**
 * Initialize localDoc from remoteDoc's CRDT state.
 * Creates localDoc, applies remoteDoc's state (shared history), attaches IDB persistence, sets LCA.
 * Used when downloading a document — remoteDoc already has server content,
 * and we need to replicate it into localDoc without creating independent CRDT operations.
 */
export interface InitializeFromRemoteEvent {
  type: 'INITIALIZE_FROM_REMOTE';
  content: string;
  hash: string;
  mtime: number;
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

// Diagnostic Events (from Obsidian monkeypatches)
// These events are informational only - they don't trigger state transitions.
// They provide visibility into Obsidian's internal file handling for debugging.

/**
 * Fired when Obsidian's loadFileInternal is called.
 * This is the entry point for Obsidian's disk change handling.
 */
export interface ObsidianLoadFileInternalEvent {
  type: 'OBSIDIAN_LOAD_FILE_INTERNAL';
  /** True if this is the initial file load (not a reload) */
  isInitialLoad: boolean;
  /** True if the editor has unsaved changes */
  dirty: boolean;
  /** True if disk content differs from lastSavedData */
  contentChanged: boolean;
  /** True if three-way merge will be triggered (dirty && contentChanged && isPlaintext) */
  willMerge: boolean;
}

/**
 * Fired when Obsidian's three-way merge is triggered.
 * This happens when: dirty && contentChanged && isPlaintext.
 * The merge rebases editor changes onto the new disk content.
 */
export interface ObsidianThreeWayMergeEvent {
  type: 'OBSIDIAN_THREE_WAY_MERGE';
  /** Length of the LCA (lastSavedData) */
  lcaLength: number;
  /** Length of the current editor content */
  editorLength: number;
  /** Length of the new disk content */
  diskLength: number;
}

/**
 * Fired when Obsidian's workspace 'file-open' event fires for a Relay file.
 */
export interface ObsidianFileOpenedEvent {
  type: 'OBSIDIAN_FILE_OPENED';
  path: string;
}

/**
 * Fired when a MarkdownView unloads a Relay file (onUnloadFile monkeypatch).
 */
export interface ObsidianFileUnloadedEvent {
  type: 'OBSIDIAN_FILE_UNLOADED';
  path: string;
}

/**
 * Fired when a CM6 ViewPlugin detects the editor switched to a different file.
 * Sent to the OLD document's HSM before teardown.
 */
export interface ObsidianViewReusedEvent {
  type: 'OBSIDIAN_VIEW_REUSED';
  oldPath: string;
  newPath: string;
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
  // Mode Determination (from MergeManager)
  | SetModeActiveEvent
  | SetModeIdleEvent
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
  | PersistenceSyncedEvent
  | InitializeWithContentEvent
  | InitializeLCAEvent
  | InitializeFromRemoteEvent
  | MergeSuccessEvent
  | MergeConflictEvent
  | RemoteDocUpdatedEvent
  | ErrorEvent
  // Diagnostic (from Obsidian monkeypatches)
  | ObsidianLoadFileInternalEvent
  | ObsidianThreeWayMergeEvent
  | ObsidianFileOpenedEvent
  | ObsidianFileUnloadedEvent
  | ObsidianViewReusedEvent;

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
  /** Whether persistence has finished loading stored updates */
  synced: boolean;
  once(event: 'synced', cb: () => void): void;
  destroy(): void | Promise<void>;
  /** Promise that resolves when persistence is synced */
  whenSynced: Promise<unknown>;
  /** Set metadata key-value pair on the persistence store */
  set?(key: string, value: string): void;
  /** Check if database contains meaningful user data (stored updates) */
  hasUserData(): boolean;
  /**
   * Initialize persistence with text content.
   * Used for initial document enrollment.
   * @throws Error if database already has content
   */
  initializeWithContent(content: string, fieldName?: string): Promise<void>;
  /**
   * Get the origin of this document (local = created here, remote = downloaded).
   * Used to determine if a document needs initial upload vs is already enrolled.
   */
  getOrigin?(): Promise<'local' | 'remote' | undefined>;
  /**
   * Mark the origin of this document.
   */
  markOrigin?(origin: 'local' | 'remote'): Promise<void>;
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
 * Production: creates IndexeddbPersistence(vaultId, doc, userId).
 * Testing: can return a mock that fires 'synced' synchronously.
 */
export type CreatePersistence = (vaultId: string, doc: Y.Doc, userId?: string) => IYDocPersistence;

/**
 * Function to load raw Yjs updates from IndexedDB without creating a YDoc.
 * Used for lightweight idle mode operations (BUG-021).
 * Production: loadUpdatesRaw from y-indexeddb.
 * Testing: can return an empty array or mock data.
 */
export type LoadUpdatesRaw = (vaultId: string) => Promise<Uint8Array[]>;

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
   * Function to load raw updates from IndexedDB (for idle mode auto-merge).
   * Defaults to loadUpdatesRaw from y-indexeddb.
   * Override in tests with a mock that returns empty array.
   */
  loadUpdatesRaw?: LoadUpdatesRaw;

  /**
   * Metadata to store on the persistence for recovery/debugging.
   * Set after persistence syncs.
   */
  persistenceMetadata?: PersistenceMetadata;

  /**
   * User ID for PermanentUserData tracking.
   * If provided, sets up user mapping on localDoc to track which user made changes.
   */
  userId?: string;
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
