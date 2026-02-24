/**
 * Merge HSM Types
 *
 * Core type definitions for the hierarchical state machine that manages
 * document synchronization between disk, local CRDT, and remote CRDT.
 */

// =============================================================================
// View Reference Types
// =============================================================================

/**
 * Narrow interface for reading the editor view's dirty flag.
 * Used to determine if Obsidian's auto-save has flushed (dirty === false),
 * enabling safe LCA advancement during active.tracking.
 */
export interface EditorViewRef {
	readonly dirty: boolean;
}

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
// Fork and SyncGate Types
// =============================================================================

/**
 * Snapshot of localDoc state taken before a disk edit is ingested in idle mode.
 * Enables three-way reconciliation when the provider reconnects and syncs.
 */
export interface Fork {
	/** localDoc content before changes were ingested */
	base: string;
	/** Y.js state vector of localDoc at fork point */
	localStateVector: Uint8Array;
	/** Y.js state vector of remoteDoc at fork point */
	remoteStateVector: Uint8Array;
	/** What created this fork */
	origin: string;
	/** When the fork was created (ms since epoch) */
	created: number;
	/** OpCapture position at fork creation — boundary for sinceByOrigin() */
	captureMark: number;
}

/**
 * Controls whether CRDT ops flow between localDoc and remoteDoc.
 * Gates on: provider connection status, fork existence, and user local-only preference.
 */
export interface SyncGate {
	providerConnected: boolean;
	providerSynced: boolean;
	localOnly: boolean;
	pendingInbound: number;
	pendingOutbound: number;
}

// =============================================================================
// State Types
// =============================================================================

export type SyncStatusType = "synced" | "pending" | "conflict" | "error";

export interface SyncStatus {
	guid: string;
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
	 * Fork state for idle mode reconciliation.
	 * Present when a disk edit was ingested and awaits provider sync for reconciliation.
	 */
	fork?: Fork | null;

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
	| "unloaded"
	| "loading"
	| "idle.loading"
	| "idle.synced"
	| "idle.localAhead"
	| "idle.remoteAhead"
	| "idle.diskAhead"
	| "idle.diverged"
	| "idle.error"
	| "active.loading"
	| "active.entering"
	| "active.entering.awaitingPersistence"
	| "active.entering.awaitingRemote"
	| "active.entering.reconciling"
	| "active.tracking"
	| "active.merging.twoWay"
	| "active.merging.threeWay"
	| "active.conflict.bannerShown"
	| "active.conflict.resolving"
	| "unloading";

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
	type: "LOAD";
	guid: string;
}

export interface UnloadEvent {
	type: "UNLOAD";
}

export interface AcquireLockEvent {
	type: "ACQUIRE_LOCK";
	/**
	 * The current editor/disk content at the moment of opening.
	 * Since the editor content equals the disk content when a file is first opened
	 * (before CRDT loads), this provides accurate disk content for merge operations.
	 */
	editorContent: string;
	/**
	 * Live reference to the editor view's dirty flag.
	 * When present, enables LCA advancement during active.tracking
	 * when DISK_CHANGED fires and dirty === false (auto-save has flushed).
	 */
	editorViewRef?: EditorViewRef;
}

export interface ReleaseLockEvent {
	type: "RELEASE_LOCK";
}

export interface DiskChangedEvent {
	type: "DISK_CHANGED";
	contents: string;
	mtime: number;
	hash: string;
}

export interface RemoteUpdateEvent {
	type: "REMOTE_UPDATE";
	update: Uint8Array;
}

export interface SaveCompleteEvent {
	type: "SAVE_COMPLETE";
	mtime: number;
	hash: string;
}

export interface CM6ChangeEvent {
	type: "CM6_CHANGE";
	changes: PositionedChange[];
	docText: string;
	isFromYjs: boolean;
}

export interface ProviderSyncedEvent {
	type: "PROVIDER_SYNCED";
}

export interface ConnectedEvent {
	type: "CONNECTED";
}

export interface DisconnectedEvent {
	type: "DISCONNECTED";
}

// Mode Determination Events (sent by MergeManager)
/**
 * MergeManager signals this HSM should be in active mode.
 * Transitions from `loading` → `active.loading`.
 */
export interface SetModeActiveEvent {
	type: "SET_MODE_ACTIVE";
}

/**
 * MergeManager signals this HSM should be in idle mode.
 * Transitions from `loading` → `idle.loading`.
 */
export interface SetModeIdleEvent {
	type: "SET_MODE_IDLE";
}

// User Events
export interface ResolveEvent {
	type: "RESOLVE";
	contents: string;
}

export interface DismissConflictEvent {
	type: "DISMISS_CONFLICT";
}

export interface OpenDiffViewEvent {
	type: "OPEN_DIFF_VIEW";
}

export interface CancelEvent {
	type: "CANCEL";
}

// Internal Events
export interface PersistenceLoadedEvent {
	type: "PERSISTENCE_LOADED";
	updates: Uint8Array;
	lca: LCAState | null;
	/** Pre-computed state vector from cache (avoids per-document IDB opens) */
	localStateVector?: Uint8Array | null;
}

export interface PersistenceSyncedEvent {
	type: "PERSISTENCE_SYNCED";
	hasContent: boolean;
}

export interface MergeSuccessEvent {
	type: "MERGE_SUCCESS";
	newLCA: LCAState;
}

export interface MergeConflictEvent {
	type: "MERGE_CONFLICT";
	base: string;
	ours: string;
	theirs: string;
	conflictRegions?: ConflictRegion[];
}

// Per-hunk conflict resolution event
export interface ResolveHunkEvent {
	type: "RESOLVE_HUNK";
	index: number;
	resolution: "local" | "remote" | "both";
}

export interface RemoteDocUpdatedEvent {
	type: "REMOTE_DOC_UPDATED";
}

export interface ErrorEvent {
	type: "ERROR";
	error: Error;
}

/** Completion event for idle merge operations */
export type IdleMergeCompleteEvent =
	| { type: "IDLE_MERGE_COMPLETE"; success: true; newLCA: LCAState; source: "remote" | "disk" | "threeWay" }
	| { type: "IDLE_MERGE_COMPLETE"; success: false; error?: Error; source: "remote" | "disk" | "threeWay" };

// Diagnostic Events (from Obsidian monkeypatches)
// These events are informational only - they don't trigger state transitions.
// They provide visibility into Obsidian's internal file handling for debugging.

/**
 * Fired when Obsidian's loadFileInternal is called.
 * This is the entry point for Obsidian's disk change handling.
 */
export interface ObsidianLoadFileInternalEvent {
	type: "OBSIDIAN_LOAD_FILE_INTERNAL";
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
	type: "OBSIDIAN_THREE_WAY_MERGE";
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
	type: "OBSIDIAN_FILE_OPENED";
	path: string;
}

/**
 * Fired when a MarkdownView unloads a Relay file (onUnloadFile monkeypatch).
 */
export interface ObsidianFileUnloadedEvent {
	type: "OBSIDIAN_FILE_UNLOADED";
	path: string;
}

/**
 * Fired when a CM6 ViewPlugin detects the editor switched to a different file.
 * Sent to the OLD document's HSM before teardown.
 */
export interface ObsidianViewReusedEvent {
	type: "OBSIDIAN_VIEW_REUSED";
	oldPath: string;
	newPath: string;
}

/**
 * Fired when Obsidian's saveFrontmatter hook triggers on a Relay file.
 * The metadata editor writes frontmatter into the CM6 buffer outside
 * the normal CM6_CHANGE path, which can cause editor↔localDoc drift.
 */
export interface ObsidianSaveFrontmatterEvent {
	type: "OBSIDIAN_SAVE_FRONTMATTER";
	path: string;
}

/**
 * Fired when the ViewHookPlugin save hook syncs metadata changes to the CRDT
 * via diffMatchPatch (preview mode only).
 */
export interface ObsidianMetadataSyncEvent {
	type: "OBSIDIAN_METADATA_SYNC";
	path: string;
	mode: string;
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
	| ResolveEvent
	| DismissConflictEvent
	| OpenDiffViewEvent
	| CancelEvent
	| ResolveHunkEvent
	// Internal
	| PersistenceLoadedEvent
	| PersistenceSyncedEvent
	| MergeSuccessEvent
	| MergeConflictEvent
	| RemoteDocUpdatedEvent
	| ErrorEvent
	| IdleMergeCompleteEvent
	// Diagnostic (from Obsidian monkeypatches)
	| ObsidianLoadFileInternalEvent
	| ObsidianThreeWayMergeEvent
	| ObsidianFileOpenedEvent
	| ObsidianFileUnloadedEvent
	| ObsidianViewReusedEvent
	| ObsidianSaveFrontmatterEvent
	| ObsidianMetadataSyncEvent;

// =============================================================================
// Effect Types
// =============================================================================

export interface DispatchCM6Effect {
	type: "DISPATCH_CM6";
	changes: PositionedChange[];
}

export interface WriteDiskEffect {
	type: "WRITE_DISK";
	guid: string;
	contents: string;
}

export interface PersistStateEffect {
	type: "PERSIST_STATE";
	guid: string;
	state: PersistedMergeState;
}

export interface SyncToRemoteEffect {
	type: "SYNC_TO_REMOTE";
	update: Uint8Array;
}

export interface StatusChangedEffect {
	type: "STATUS_CHANGED";
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
	/** Content from ours (editor/CRDT) version */
	oursContent: string;
	/** Content from theirs (disk/remote) version */
	theirsContent: string;
}

/**
 * Effect to show inline conflict decorations in the editor.
 */
export interface ShowConflictDecorationsEffect {
	type: "SHOW_CONFLICT_DECORATIONS";
	conflictRegions: ConflictRegion[];
	positions: PositionedConflict[];
}

/**
 * Effect to hide a specific conflict decoration after resolution.
 */
export interface HideConflictDecorationEffect {
	type: "HIDE_CONFLICT_DECORATION";
	index: number;
}

/**
 * Request provider sync for fork reconciliation.
 * Emitted when a fork is created and needs remote state to reconcile.
 */
export interface RequestProviderSyncEffect {
	type: "REQUEST_PROVIDER_SYNC";
	guid: string;
}

export type MergeEffect =
	| DispatchCM6Effect
	| WriteDiskEffect
	| PersistStateEffect
	| SyncToRemoteEffect
	| StatusChangedEffect
	| ShowConflictDecorationsEffect
	| HideConflictDecorationEffect
	| RequestProviderSyncEffect;

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
	fork?: Fork | null;
	persistedAt: number;
}

// Yjs updates are stored in y-indexeddb per-document databases,
// NOT in MergeHSMDatabase. Persistence writes to IDB automatically
// via the _storeUpdate handler on localDoc.

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
 * localDoc stays alive with persistence writing to IDB automatically.
 */
export interface IdleModeState {
	guid: string;
	path: string;
	/**
	 * Database name for y-indexeddb access.
	 * Convention: `${appId}-relay-doc-${guid}`
	 */
	yIndexedDbName: string;
	/** Computed from updates via Y.mergeUpdates + Y.encodeStateVectorFromUpdate */
	localStateVector: Uint8Array;
	/** LCA for comparison */
	lca: LCAState;
	/** Sync status for UI */
	syncStatus: "synced" | "pending" | "conflict";
}

// =============================================================================
// Configuration Types
// =============================================================================

// Re-export TimeProvider from existing module for consistency
import type { TimeProvider } from "../TimeProvider";
export type { TimeProvider };

// Import Y.Doc type for remoteDoc
import type * as Y from "yjs";
import type { OpCapture } from "./undo";

/**
 * Minimal interface for IndexedDB-backed YDoc persistence.
 * Allows injection for testing (mock) vs production (IndexeddbPersistence).
 */
export interface IYDocPersistence {
	/** Whether persistence has finished loading stored updates */
	synced: boolean;
	once(event: "synced", cb: () => void): void;
	destroy(): void | Promise<void>;
	/** Promise that resolves when persistence is synced */
	whenSynced: Promise<unknown>;
	/** Set metadata key-value pair on the persistence store */
	set?(key: string, value: string): void;
	/** Check if database contains meaningful user data (stored updates) */
	hasUserData(): boolean;
	/**
	 * Get the origin of this document (local = created here, remote = downloaded).
	 * Used to determine if a document needs initial upload vs is already enrolled.
	 */
	getOrigin?(): Promise<"local" | "remote" | undefined>;
	/**
	 * Set the origin of this document.
	 */
	setOrigin?(origin: "local" | "remote"): Promise<void>;
	/**
	 * Initialize document with content if not already initialized.
	 * Checks origin in one IDB session, calls contentLoader only if needed.
	 * @returns true if initialization happened, false if already initialized
	 */
	initializeWithContent?(
		contentLoader: () => Promise<{
			content: string;
			hash: string;
			mtime: number;
		}>,
		fieldName?: string,
	): Promise<boolean>;
	/**
	 * Initialize document from remote CRDT state if not already initialized.
	 * Used for downloaded documents where remoteDoc already has server content.
	 * @returns true if initialization happened, false if already initialized
	 */
	initializeFromRemote?(update: Uint8Array, origin?: unknown): Promise<boolean>;
	/**
	 * OpCapture instance managed by this persistence layer.
	 * Initialized during the persistence sync lifecycle when captureOpts
	 * is passed to the constructor.
	 */
	opCapture?: OpCapture | null;
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
 * OpCapture configuration passed to persistence constructor.
 * When provided, persistence initializes OpCapture during its sync
 * lifecycle (after fetchUpdates, before 'synced' fires).
 */
export interface CaptureOpts {
	scope: string;
	trackedOrigins: Set<any>;
	captureTimeout?: number;
}

/**
 * Factory that creates a persistence instance for a YDoc.
 * Production: creates IndexeddbPersistence(vaultId, doc, userId, captureOpts).
 * Testing: can return a mock that fires 'synced' synchronously.
 */
export type CreatePersistence = (
	vaultId: string,
	doc: Y.Doc,
	userId?: string,
	captureOpts?: CaptureOpts | null,
) => IYDocPersistence;

/**
 * Content loaded from disk for lazy enrollment.
 * Returned by diskLoader when HSM needs to initialize a document.
 */
export interface DiskContent {
	/** File text contents */
	content: string;
	/** Content hash (SHA-256) */
	hash: string;
	/** Modification time (ms since epoch) */
	mtime: number;
}

/**
 * Function to lazily load disk content for enrollment.
 * Called only when HSM determines initialization is needed (not already enrolled).
 */
export type DiskLoader = () => Promise<DiskContent>;

export interface MergeHSMConfig {
	/** Document GUID */
	guid: string;

	/** Callback to look up the current path by guid. */
	getPath: () => string;

	/**
	 * Vault ID for y-indexeddb persistence.
	 * Convention: `${appId}-relay-doc-${guid}`
	 */
	vaultId: string;

	/**
	 * Remote YDoc - passed in, managed externally.
	 * Provider is attached by integration layer.
	 * HSM observes for remote updates.
	 * Can be null for hibernated documents (no YDoc in memory).
	 * When null, idle mode operations use doc-less Yjs APIs.
	 * Must be provided (via setRemoteDoc) before entering active mode.
	 */
	remoteDoc: Y.Doc | null;

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

	/**
	 * User ID for PermanentUserData tracking.
	 * If provided, sets up user mapping on localDoc to track which user made changes.
	 */
	userId?: string;

	/**
	 * Function to lazily load disk content for local enrollment.
	 * Called by initializeWithContent() only when the document isn't already enrolled.
	 * This avoids disk reads when re-opening already-enrolled files.
	 */
	diskLoader: DiskLoader;

	/**
	 * Query whether the provider is connected and synced.
	 * Used by fork-reconcile to determine if it can proceed with reconciliation.
	 * If not provided, defaults to checking internal _syncGate state.
	 */
	isProviderSynced?: () => boolean;
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
	ours: string;
	theirs: string;
	conflictRegions: ConflictRegion[];
}

export interface ConflictRegion {
	baseStart: number;
	baseEnd: number;
	oursContent: string;
	theirsContent: string;
}

export type MergeResult = MergeSuccess | MergeFailure;

// =============================================================================
// Declarative State Machine Types
// =============================================================================

/** A single transition candidate: guard → actions → target */
export type TransitionCandidate = {
	target: StatePath;
	/** Name in the guards table */
	guard?: string;
	/** Names in the actions table */
	actions?: string[];
	/** True = fire exit/entry on self-transition (default: false = internal) */
	reenter?: boolean;
};

/** Event handler: simple target, single candidate, or ordered array (first passing guard wins) */
export type EventHandler = StatePath | TransitionCandidate | TransitionCandidate[];

/** Async service declaration — spawned on state entry, cancelled on state exit */
export type InvokeDef = {
	/** Name in the invokeSources table */
	src: string;
	/** Transition on successful completion */
	onDone: EventHandler;
	/** Transition on error (default: stay in state) */
	onError?: EventHandler;
};

/** Eventless transition — evaluated immediately on state entry after entry actions */
export type AlwaysCandidate = {
	target: StatePath;
	guard?: string;
	actions?: string[];
};

/** A single state node in the machine definition */
export type StateNode = {
	/** Actions on entering this state */
	entry?: string[];
	/** Actions on exiting this state */
	exit?: string[];
	/** Event → transition mapping */
	on?: Record<string, EventHandler>;
	/** Async service (spawned on entry, cancelled on exit) */
	invoke?: InvokeDef;
	/** Eventless transitions (evaluated on entry after entry actions) */
	always?: AlwaysCandidate[];
};

/** The complete machine definition: partial mapping from state path to state node */
export type MachineDefinition = Partial<Record<StatePath, StateNode>>;

// Forward-reference MergeHSM to avoid circular imports — the interpreter
// receives the HSM instance opaquely and passes it to guard/action/invoke functions.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface MachineHSM {
	/** Current state path */
	readonly statePath: StatePath;
	/** Transition to a new state (updates _statePath, emits STATUS_CHANGED) */
	setStatePath(target: StatePath): void;
	/** Send an event to the HSM (re-enters handleEvent loop) */
	send(event: MergeEvent): void;
	/** Get the currently active invoke (for cancellation) */
	getActiveInvoke(): ActiveInvoke | null;
	/** Set the active invoke (for the interpreter to track) */
	setActiveInvoke(invoke: ActiveInvoke | null): void;
}

/** Tracking structure for a running invoke */
export interface ActiveInvoke {
	id: string;
	controller: AbortController;
	/** Promise that resolves when the invoke completes (for awaitAsync compatibility) */
	promise?: Promise<void>;
}

/** Guard function: returns true if the transition should proceed */
export type GuardFn = (hsm: MachineHSM, event: MergeEvent) => boolean;

/** Action function: performs a side effect on the HSM */
export type ActionFn = (hsm: MachineHSM, event: MergeEvent) => void;

/** Invoke source function: async work spawned on state entry */
export type InvokeSourceFn = (hsm: MachineHSM, signal: AbortSignal) => Promise<unknown>;

/** Configuration for the interpreter — lookup tables for named references */
export interface InterpreterConfig {
	guards: Record<string, GuardFn>;
	actions: Record<string, ActionFn>;
	invokeSources: Record<string, InvokeSourceFn>;
}

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
	type: MergeEvent["type"];
	[key: string]: unknown;
}
