/**
 * MergeHSM - Hierarchical State Machine for Document Synchronization
 *
 * Manages the sync between disk, local CRDT (Yjs), and remote CRDT.
 * Pure state machine: events in → state transitions → effects out.
 *
 * Architecture:
 * - Two-YDoc architecture: localDoc (persisted) + remoteDoc (ephemeral)
 * - In active mode: editor ↔ localDoc ↔ remoteDoc ↔ server
 * - In idle mode: lightweight, no YDocs in memory
 *
 * CRITICAL INVARIANTS (DO NOT VIOLATE):
 *
 * 1. ONE-TIME CONTENT INSERTION: Disk content must only be inserted into the
 *    CRDT exactly ONCE during initial enrollment. See docs/how-we-bootstrap-collaboration.md.
 *    After enrollment, content flows through CRDT operations, never by reinsertion.
 *
 * 2. NO FULL CRDT REPLACE: Never use the pattern `delete(0, length) + insert(0, newContent)`
 *    on any Y.Text. This destroys the operational history and causes content duplication
 *    when merged with other clients. Always use diff-based updates (diff-match-patch).
 *
 * 3. NEVER WRITE DISK WHEN EDITOR OPEN: In active mode, the editor owns the file.
 *    Disk writes can only happen when transitioning to idle or during conflict resolution.
 */

import * as Y from "yjs";
import { diff3Merge } from "node-diff3";
import { diff_match_patch } from "diff-match-patch";
import type {
	MergeState,
	MergeEvent,
	MergeEffect,
	StatePath,
	LCAState,
	MergeMetadata,
	PositionedChange,
	MergeHSMConfig,
	MergeResult,
	SyncStatus,
	SyncStatusType,
	PersistedMergeState,
	IYDocPersistence,
	CreatePersistence,
	PersistenceMetadata,
	ConflictRegion,
	PositionedConflict,
	ResolveHunkEvent,
	LoadUpdatesRaw,
	DiskLoader,
} from "./types";
import type { TimeProvider } from "../TimeProvider";
import { DefaultTimeProvider } from "../TimeProvider";
import { curryLog } from "../debug";
import type { TestableHSM } from "./testing/createTestHSM";

// =============================================================================
// Simple Observable for HSM
// =============================================================================

type Subscriber<T> = (value: T) => void;
type Unsubscriber = () => void;

/**
 * Simple Observable interface matching the spec.
 */
export interface IObservable<T> {
	subscribe(run: Subscriber<T>): Unsubscriber;
}

/**
 * Simple Observable implementation for the HSM.
 * Does not use PostOffice - notifications are synchronous.
 */
class SimpleObservable<T> implements IObservable<T> {
	private listeners: Set<Subscriber<T>> = new Set();

	subscribe(run: Subscriber<T>): Unsubscriber {
		this.listeners.add(run);
		return () => {
			this.listeners.delete(run);
		};
	}

	emit(value: T): void {
		for (const listener of this.listeners) {
			listener(value);
		}
	}

	get listenerCount(): number {
		return this.listeners.size;
	}
}

// =============================================================================
// Transition Validation Table
// =============================================================================

const TRANSITIONS: Partial<Record<StatePath, StatePath[]>> = {
	'unloaded': ['loading'],
	'loading': ['active.loading', 'active.entering.awaitingPersistence', 'idle.loading', 'unloading'],
	'idle.loading': ['idle.synced', 'idle.localAhead', 'idle.remoteAhead', 'idle.diskAhead', 'idle.diverged'],
	'idle.synced': ['idle.remoteAhead', 'idle.diskAhead', 'idle.diverged', 'idle.error',
		'active.entering.awaitingPersistence', 'unloading', 'loading'],
	'idle.localAhead': ['idle.synced', 'idle.diverged', 'idle.error',
		'active.entering.awaitingPersistence', 'unloading', 'loading'],
	'idle.remoteAhead': ['idle.synced', 'idle.remoteAhead', 'idle.diverged', 'idle.error',
		'active.entering.awaitingPersistence', 'unloading', 'loading'],
	'idle.diskAhead': ['idle.synced', 'idle.diskAhead', 'idle.diverged', 'idle.error',
		'active.entering.awaitingPersistence', 'unloading', 'loading'],
	'idle.diverged': ['idle.synced', 'idle.error',
		'active.entering.awaitingPersistence', 'active.conflict.bannerShown', 'unloading', 'loading'],
	'idle.error': ['idle.synced', 'active.entering.awaitingPersistence', 'unloading', 'loading'],
	'active.loading': ['active.entering.awaitingPersistence', 'unloading'],
	'active.entering.awaitingPersistence': ['active.entering.reconciling', 'active.entering.awaitingRemote', 'unloading'],
	'active.entering.awaitingRemote': ['active.entering.reconciling', 'unloading'],
	'active.entering.reconciling': ['active.tracking', 'active.merging.twoWay', 'active.merging.threeWay', 'unloading'],
	'active.tracking': ['active.conflict.bannerShown', 'unloading'],
	'active.merging.twoWay': ['active.tracking', 'active.conflict.bannerShown', 'unloading'],
	'active.merging.threeWay': ['active.tracking', 'active.conflict.bannerShown', 'unloading'],
	'active.conflict.bannerShown': ['active.conflict.resolving', 'active.tracking', 'unloading'],
	'active.conflict.resolving': ['active.conflict.bannerShown', 'active.tracking', 'unloading'],
	'unloading': ['idle.synced', 'idle.localAhead', 'idle.remoteAhead', 'idle.diskAhead',
		'idle.diverged', 'idle.loading', 'unloaded'],
};

// =============================================================================
// MergeHSM Class
// =============================================================================

export class MergeHSM implements TestableHSM {
	// Current state path
	private _statePath: StatePath = "unloaded";

	private _guid: string;
	private _path: string;
	private _lca: LCAState | null = null;
	private _disk: MergeMetadata | null = null;
	private _localStateVector: Uint8Array | null = null;
	private _remoteStateVector: Uint8Array | null = null;
	private _error: Error | undefined;
	private _deferredConflict:
		| { diskHash: string; localHash: string }
		| undefined;

	// YDocs
	private localDoc: Y.Doc | null = null; // Only populated in active mode
	private remoteDoc: Y.Doc; // Always available, passed in via config, managed externally

	// Persisted client ID for localDoc across lock cycles.
	// Reusing the same client ID prevents content duplication when IDB is empty
	// (the same content enrolled with different client IDs appears as duplicates).
	private _localDocClientID: number | null = null;

	// Pending disk contents for merge (legacy, used for idle mode)
	private pendingDiskContents: string | null = null;

	// Editor content from ACQUIRE_LOCK event, used for merge during reconciliation
	private pendingEditorContent: string | null = null;

	// Conflict data (enhanced for inline resolution)
	private conflictData: {
		base: string;
		local: string;
		remote: string;
		conflictRegions: ConflictRegion[];
		resolvedIndices: Set<number>;
		positionedConflicts: PositionedConflict[];
	} | null = null;

	// Track previous sync status for change detection
	private lastSyncStatus: SyncStatusType = "synced";

	// Pending updates for idle mode auto-merge (received via REMOTE_UPDATE)
	private pendingIdleUpdates: Uint8Array | null = null;

	// Initial updates from PERSISTENCE_LOADED (applied when YDocs are created)
	private initialPersistenceUpdates: Uint8Array | null = null;

	// Persistence for localDoc (only in active mode)
	private localPersistence: IYDocPersistence | null = null;

	// Last known editor text (for drift detection)
	private lastKnownEditorText: string | null = null;

	// Y.Text observer for converting remote deltas to positioned changes
	private localTextObserver:
		| ((event: Y.YTextEvent, tr: Y.Transaction) => void)
		| null = null;

	// Observables (per spec)
	private readonly _effects = new SimpleObservable<MergeEffect>();
	private readonly _stateChanges = new SimpleObservable<MergeState>();

	// Legacy listeners (for backward compatibility with test harness)
	private stateChangeListeners: Array<
		(from: StatePath, to: StatePath, event: MergeEvent) => void
	> = [];

	// Configuration
	private timeProvider: TimeProvider;
	private hashFn: (contents: string) => Promise<string>;
	private vaultId: string;
	private _createPersistence: CreatePersistence;
	private _loadUpdatesRaw: LoadUpdatesRaw;
	private _persistenceMetadata?: PersistenceMetadata;
	private _diskLoader: DiskLoader;

	// Whether PROVIDER_SYNCED has been received during the current lock cycle
	private _providerSynced = false;

	// Async operation tracking with cancellation support
	private _asyncOps = new Map<string, { controller: AbortController; promise: Promise<void> }>();

	// Network connectivity status (does not block state transitions)
	private _isOnline: boolean = false;

	// User ID for PermanentUserData tracking
	private _userId?: string;

	// CRDT operation logging
	private crdtLog = curryLog("[MergeHSM:CRDT]", "debug");
	private _remoteDocLogHandler:
		| ((update: Uint8Array, origin: unknown) => void)
		| null = null;

	// Event accumulation queue for loading state (Gap 11)
	// Events like REMOTE_UPDATE and DISK_CHANGED are accumulated during loading
	// and replayed after mode transition (to idle.* or active.*)
	private _accumulatedEvents: Array<
		| { type: "REMOTE_UPDATE"; update: Uint8Array }
		| { type: "DISK_CHANGED"; contents: string; mtime: number; hash: string }
	> = [];

	// Mode decision during loading state (null = not decided, 'idle' or 'active')
	private _modeDecision: "idle" | "active" | null = null;

	// Track if entering active mode from diverged state for conflict handling
	private _enteringFromDiverged: boolean = false;

	constructor(config: MergeHSMConfig) {
		this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
		this.hashFn = config.hashFn ?? defaultHashFn;
		this._guid = config.guid;
		this._path = config.path;
		this.vaultId = config.vaultId;
		this.remoteDoc = config.remoteDoc;
		this._createPersistence =
			config.createPersistence ?? defaultCreatePersistence;
		this._loadUpdatesRaw = config.loadUpdatesRaw ?? defaultLoadUpdatesRaw;
		this._persistenceMetadata = config.persistenceMetadata;
		this._userId = config.userId;
		this._diskLoader = config.diskLoader;
	}

	// ===========================================================================
	// Public API
	// ===========================================================================

	get path(): string {
		return this._path;
	}

	get guid(): string {
		return this._guid;
	}

	get state(): MergeState {
		return {
			guid: this._guid,
			path: this._path,
			lca: this._lca,
			disk: this._disk,
			localStateVector: this._localStateVector,
			remoteStateVector: this._remoteStateVector,
			statePath: this._statePath,
			error: this._error,
			deferredConflict: this._deferredConflict,
			isOnline: this._isOnline,
			pendingEditorContent: this.pendingEditorContent ?? undefined,
			lastKnownEditorText: this.lastKnownEditorText ?? undefined,
		};
	}

	send(event: MergeEvent): void {
		const fromState = this._statePath;
		this.handleEvent(event);
		const toState = this._statePath;

		// Always notify state change, even if state path unchanged.
		// This ensures subscribers (like MergeManager.syncStatus) are updated
		// when properties like diskMtime change without a state transition.
		// Subscribers should be idempotent.
		this.notifyStateChange(fromState, toState, event);
	}

	matches(statePath: string): boolean {
		return (
			this._statePath === statePath ||
			this._statePath.startsWith(statePath + ".")
		);
	}

	/**
	 * Check if the HSM is in active mode (editor open, lock acquired).
	 */
	isActive(): boolean {
		return this._statePath.startsWith("active.");
	}

	/**
	 * Check if the HSM is in idle mode (no editor, lightweight state).
	 */
	isIdle(): boolean {
		return this._statePath.startsWith("idle.");
	}

	/**
	 * Check if the network is currently connected.
	 * Does not affect state transitions; local edits always work offline.
	 */
	get isOnline(): boolean {
		return this._isOnline;
	}

	getLocalDoc(): Y.Doc | null {
		return this.localDoc;
	}

	/**
	 * Get the length of the local document content.
	 * If localDoc is loaded in memory, returns immediately.
	 * If in idle mode (localDoc unloaded), loads from IndexedDB.
	 */
	async getLocalDocLength(): Promise<number> {
		// Fast path: localDoc is in memory
		if (this.localDoc) {
			return this.localDoc.getText("contents").toString().length;
		}

		// Slow path: load from IndexedDB
		const updates = await this._loadUpdatesRaw(this.vaultId);
		if (updates.length === 0) {
			return 0;
		}

		const merged = Y.mergeUpdates(updates);
		const tempDoc = new Y.Doc();
		try {
			Y.applyUpdate(tempDoc, merged, this);
			return tempDoc.getText("contents").toString().length;
		} finally {
			tempDoc.destroy();
		}
	}

	getConflictData(): {
		base: string;
		local: string;
		remote: string;
		conflictRegions?: ConflictRegion[];
		resolvedIndices?: Set<number>;
		positionedConflicts?: PositionedConflict[];
	} | null {
		return this.conflictData;
	}

	getRemoteDoc(): Y.Doc {
		// Per spec: "Access remoteDoc (always available - managed externally)"
		return this.remoteDoc;
	}

	/**
	 * Wait for any in-progress cleanup to complete.
	 * Returns immediately if no cleanup is in progress.
	 * Used by MergeManager to ensure state transitions complete before returning.
	 */
	async awaitCleanup(): Promise<void> {
		await this.awaitAsync('cleanup');
	}

	/**
	 * Wait for any pending idle auto-merge operation to complete.
	 * Returns immediately if no auto-merge is in progress.
	 */
	async awaitIdleAutoMerge(): Promise<void> {
		await this.awaitAsync('idle-merge');
	}

	/**
	 * Wait for the HSM to reach a state matching the given predicate.
	 * Returns immediately if already in a matching state.
	 *
	 * @param predicate - Function that returns true when the desired state is reached
	 */
	async awaitState(predicate: (statePath: string) => boolean): Promise<void> {
		if (predicate(this._statePath)) {
			return;
		}

		return new Promise<void>((resolve) => {
			const unsubscribe = this.stateChanges.subscribe((state) => {
				if (predicate(state.statePath)) {
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Wait for the HSM to reach an idle state.
	 * Returns immediately if already in idle state.
	 * Used to ensure HSM is ready before acquiring lock.
	 */
	async awaitIdle(): Promise<void> {
		return this.awaitState((s) => s.startsWith("idle."));
	}

	/**
	 * Wait for the HSM to reach active.tracking state.
	 * Returns immediately if already in active.tracking.
	 * Used after sending ACQUIRE_LOCK to wait for lock acquisition to complete.
	 * Safe to call from loading state (BUG-032).
	 */
	async awaitActive(): Promise<void> {
		// Resolve for post-entering active states only. The entering substates
		// (awaitingPersistence, awaitingRemote, reconciling) must complete before
		// acquireLock() returns, so that ProviderIntegration and other setup can
		// safely use localDoc.
		return this.awaitState(
			(s) =>
				s.startsWith("active.") &&
				!s.startsWith("active.entering.") &&
				s !== "active.entering" &&
				s !== "active.loading",
		);
	}

	/**
	 * Initialize localDoc from remoteDoc's CRDT state for downloaded documents.
	 * Creates localDoc with shared CRDT history (no independent operations),
	 * attaches IDB persistence, and sets LCA.
	 *
	 * @param content - Text content for LCA
	 * @param hash - Hash of the content
	 * @param mtime - Modification time from disk
	 * @returns true if initialization happened, false if already initialized
	 */
	async initializeFromRemote(
		content: string,
		hash: string,
		mtime: number,
	): Promise<boolean> {
		await this.ensurePersistence();

		// Get remote CRDT state to apply
		const remoteState = Y.encodeStateAsUpdate(this.remoteDoc);

		// Use persistence's initializeFromRemote which checks origin in same IDB session
		const didInitialize = await this.localPersistence!.initializeFromRemote!(remoteState);

		if (didInitialize) {
			// Initialization happened - set LCA to match content
			const stateVector = Y.encodeStateVector(this.localDoc!);
			this._lca = {
				contents: content,
				meta: { hash, mtime },
				stateVector,
			};
			this._localStateVector = stateVector;
			this.emitPersistState();
		}

		return didInitialize;
	}

	/**
	 * Get the current sync status for this document.
	 */
	getSyncStatus(): SyncStatus {
		return {
			guid: this._guid,
			path: this._path,
			status: this.computeSyncStatusType(),
			diskMtime: this._disk?.mtime ?? 0,
			localStateVector: this._localStateVector ?? new Uint8Array([0]),
			remoteStateVector: this._remoteStateVector ?? new Uint8Array([0]),
		};
	}

	/**
	 * Ensure localDoc and localPersistence exist, awaiting persistence sync.
	 */
	private async ensurePersistence(): Promise<void> {
		if (!this.localDoc) {
			this.localDoc = new Y.Doc();
			if (this._localDocClientID !== null) {
				this.localDoc.clientID = this._localDocClientID;
			}
		}
		if (!this.localPersistence) {
			this.localPersistence = this._createPersistence(
				this.vaultId,
				this.localDoc,
				this._userId,
			);
		}
		await this.localPersistence.whenSynced;
	}

	/**
	 * Initialize document with content if not already initialized.
	 * Lazily loads disk content via diskLoader only when initialization is needed.
	 * Sets LCA after initialization for merge tracking.
	 *
	 * @returns true if initialization happened, false if already initialized
	 */
	async initializeWithContent(): Promise<boolean> {
		await this.ensurePersistence();

		// Cache diskLoader result so we don't read disk twice
		let cachedDiskContent: {
			content: string;
			hash: string;
			mtime: number;
		} | null = null;
		const cachingLoader = async () => {
			if (!cachedDiskContent) {
				cachedDiskContent = await this._diskLoader();
			}
			return cachedDiskContent;
		};

		// Use persistence's initializeWithContent which checks origin in same IDB session
		const didEnroll = await this.localPersistence!.initializeWithContent!(cachingLoader);

		if (didEnroll && cachedDiskContent) {
			// Enrollment happened - set LCA to match initial content
			const { content, hash, mtime } = cachedDiskContent;
			const stateVector = Y.encodeStateVector(this.localDoc!);
			this._lca = {
				contents: content,
				meta: { hash, mtime },
				stateVector,
			};
			this._localStateVector = stateVector;
		}

		return didEnroll;
	}

	/**
	 * Check for drift between editor and localDoc, correcting if needed.
	 * Returns true if drift was detected and corrected.
	 */
	checkAndCorrectDrift(): boolean {
		if (this._statePath !== "active.tracking") {
			return false;
		}

		if (!this.localDoc || this.lastKnownEditorText === null) {
			return false;
		}

		const editorText = this.lastKnownEditorText;
		const yjsText = this.localDoc.getText("contents").toString();

		if (editorText === yjsText) {
			return false; // No drift
		}

		// Drift detected - localDoc (Yjs) wins
		const changes = this.computeDiffChanges(editorText, yjsText);

		if (changes.length > 0) {
			this.emitEffect({
				type: "DISPATCH_CM6",
				changes,
			});
		}

		// Update our tracking to reflect the corrected state
		this.lastKnownEditorText = yjsText;

		return true;
	}

	/**
	 * Observable of effects emitted by the HSM (per spec).
	 */
	get effects(): IObservable<MergeEffect> {
		return this._effects;
	}

	/**
	 * Observable of state changes (per spec).
	 */
	get stateChanges(): IObservable<MergeState> {
		return this._stateChanges;
	}

	/**
	 * Subscribe to effects (convenience method, equivalent to effects.subscribe).
	 */
	subscribe(listener: (effect: MergeEffect) => void): () => void {
		return this._effects.subscribe(listener);
	}

	/**
	 * Subscribe to state changes with detailed transition info (for test harness).
	 */
	onStateChange(
		listener: (from: StatePath, to: StatePath, event: MergeEvent) => void,
	): () => void {
		this.stateChangeListeners.push(listener);
		return () => {
			const index = this.stateChangeListeners.indexOf(listener);
			if (index >= 0) {
				this.stateChangeListeners.splice(index, 1);
			}
		};
	}

	// ===========================================================================
	// Event Handler
	// ===========================================================================

	private handleEvent(event: MergeEvent): void {
		switch (event.type) {
			// External Events
			case "LOAD":
				this.handleLoad(event);
				break;

			case "UNLOAD":
				this.handleUnload();
				break;

			case "ACQUIRE_LOCK":
				this.handleAcquireLock(event);
				break;

			case "RELEASE_LOCK":
				this.handleReleaseLock();
				break;

			case "DISK_CHANGED":
				this.handleDiskChanged(event);
				break;

			case "REMOTE_UPDATE":
				this.handleRemoteUpdate(event);
				break;

			case "SAVE_COMPLETE":
				this.handleSaveComplete(event);
				break;

			case "CM6_CHANGE":
				this.handleCM6Change(event);
				break;

			case "PROVIDER_SYNCED":
				this.handleProviderSynced();
				break;

			case "CONNECTED":
				this.handleConnected();
				break;

			case "DISCONNECTED":
				this.handleDisconnected();
				break;

			// User Events
			case "RESOLVE_ACCEPT_DISK":
			case "RESOLVE_ACCEPT_LOCAL":
			case "RESOLVE_ACCEPT_MERGED":
				this.handleResolve(event);
				break;

			case "DISMISS_CONFLICT":
				this.handleDismissConflict();
				break;

			case "OPEN_DIFF_VIEW":
				this.handleOpenDiffView();
				break;

			case "CANCEL":
				this.handleCancel();
				break;

			case "RESOLVE_HUNK":
				this.handleResolveHunk(event);
				break;

			// Internal Events
			case "PERSISTENCE_LOADED":
				this.handlePersistenceLoaded(event);
				break;

			case "PERSISTENCE_SYNCED":
				this.handlePersistenceSynced(event);
				break;

			case "MERGE_SUCCESS":
				this.handleMergeSuccess(event);
				break;

			case "MERGE_CONFLICT":
				this.handleMergeConflict(event);
				break;

			case "REMOTE_DOC_UPDATED":
				this.handleRemoteDocUpdated();
				break;

			case "ERROR":
				this.handleError(event);
				break;

			// Mode Determination Events (from MergeManager)
			case "SET_MODE_ACTIVE":
				this.handleSetModeActive();
				break;

			case "SET_MODE_IDLE":
				this.handleSetModeIdle();
				break;

			// Diagnostic events (from Obsidian monkeypatches)
			// These are informational only - no state change, just logged/recorded for debugging
			case "OBSIDIAN_LOAD_FILE_INTERNAL":
			case "OBSIDIAN_THREE_WAY_MERGE":
			case "OBSIDIAN_FILE_OPENED":
			case "OBSIDIAN_FILE_UNLOADED":
			case "OBSIDIAN_VIEW_REUSED":
				// No-op: these events are captured by the recording/debugger infrastructure
				// but don't trigger any state transitions or actions
				break;
		}
	}

	// ===========================================================================
	// Mode Determination (from MergeManager)
	// ===========================================================================

	/**
	 * Handle SET_MODE_ACTIVE event from MergeManager.
	 * Signals that this HSM should be in active mode (editor is open).
	 * Transitions to active.loading to wait for ACQUIRE_LOCK with editor content.
	 */
	private handleSetModeActive(): void {
		// Only valid in loading state
		if (this._statePath !== "loading") {
			return;
		}

		this.transitionTo("active.loading");
	}

	/**
	 * Handle SET_MODE_IDLE event from MergeManager.
	 * Signals that this HSM should be in idle mode (no editor open).
	 * Transitions to idle.loading, then determines appropriate idle substate.
	 */
	private handleSetModeIdle(): void {
		// Only valid in loading state
		if (this._statePath !== "loading") {
			return;
		}
		this._modeDecision = "idle";

		this.transitionTo("idle.loading");

		// Now determine the appropriate idle substate
		this.handleIdleLoading();
	}

	/**
	 * Handle transition from idle.loading to appropriate idle substate.
	 * Reads LCA (from persistence/cache) and determines sync state.
	 *
	 * Spec flow: loading → SET_MODE_IDLE → idle.loading → idle.synced/diverged/etc.
	 */
	private handleIdleLoading(): void {
		// Only valid in idle.loading state
		if (this._statePath !== "idle.loading") {
			return;
		}

		// Clean up YDocs if they were created during initialization
		// (they'll be recreated when lock is acquired)
		// Fire-and-forget - don't block idle transition
		if (this.localDoc) {
			this.cleanupYDocs().catch((err) => {
				console.error("[MergeHSM] Error cleaning up YDocs:", err);
			});
		}

		// LCA is already loaded from persistence (during PERSISTENCE_LOADED)
		// In the future (Gap 7), this will read from MergeManager's LCA cache instead
		// For now, we use the already-loaded _lca value

		// Determine and transition to the appropriate idle substate
		this.determineAndTransitionToIdleState();
	}

	// ===========================================================================
	// Loading & Unloading
	// ===========================================================================

	private handleLoad(event: { guid: string; path: string }): void {
		this._guid = event.guid;
		this._path = event.path;
		this._modeDecision = null; // Reset mode decision for fresh load
		this._accumulatedEvents = []; // Clear accumulated events for fresh load
		this._disk = null; // Clear disk state for fresh load
		this._remoteStateVector = null; // Clear remote state for fresh load

		// Register CRDT update observer on remoteDoc (lives from LOAD to UNLOAD)
		this._remoteDocLogHandler = this.makeCRDTUpdateLogger(
			"remoteDoc",
			this.remoteDoc,
		);
		this.remoteDoc.on("update", this._remoteDocLogHandler);

		this.transitionTo("loading");
	}

	private handlePersistenceLoaded(event: {
		updates: Uint8Array;
		lca: LCAState | null;
	}): void {
		// Only set LCA from persistence if we don't already have one.
		// initializeFromRemote() may have set the LCA before this event arrives.
		if (!this._lca && event.lca) {
			this._lca = event.lca;
		}

		// Compute state vector for idle mode comparisons
		if (event.updates.length > 0) {
			this._localStateVector = Y.encodeStateVectorFromUpdate(event.updates);
			// Store updates for when YDocs are created (fixes state vector mismatch on lock cycles)
			this.initialPersistenceUpdates = event.updates;
		}

		// Stay in loading - wait for mode determination via SET_MODE_ACTIVE/IDLE
		// Documents without LCA proceed normally; they'll use 2-way merge or idle.diverged
	}

	private determineAndTransitionToIdleState(): void {
		const lca = this._lca;
		const disk = this._disk;
		const localSV = this._localStateVector;
		const remoteSV = this._remoteStateVector;

		// No LCA means we haven't established a sync point yet
		if (!lca) {
			if (localSV && localSV.length > 1) {
				this.transitionTo("idle.localAhead");
				return;
			}
			this.transitionTo("idle.synced");
			return;
		}

		// Check for divergence scenarios
		const localChanged = this.hasLocalChangedSinceLCA();
		const diskChanged = this.hasDiskChangedSinceLCA();
		const remoteChanged = this.hasRemoteChangedSinceLCA();

		if (localChanged && diskChanged) {
			this.transitionTo("idle.diverged");
		} else if (localChanged && remoteChanged) {
			this.transitionTo("idle.diverged");
		} else if (diskChanged && remoteChanged) {
			this.transitionTo("idle.diverged");
		} else if (localChanged) {
			this.transitionTo("idle.localAhead");
		} else if (diskChanged) {
			this.transitionTo("idle.diskAhead");
		} else if (remoteChanged) {
			this.transitionTo("idle.remoteAhead");
		} else {
			this.transitionTo("idle.synced");
		}

		// Replay accumulated events after transition to idle state
		this.replayAccumulatedEvents();
	}

	/**
	 * Replay events accumulated during loading state.
	 * Called after mode transition to process REMOTE_UPDATE and DISK_CHANGED events.
	 *
	 * Gap 11: Events are accumulated during loading states and replayed after
	 * the HSM transitions to idle.* or active.* mode.
	 */
	private replayAccumulatedEvents(): void {
		if (this._accumulatedEvents.length === 0) {
			return;
		}

		// Take a copy and clear before processing (avoid re-entrancy issues)
		const events = [...this._accumulatedEvents];
		this._accumulatedEvents = [];

		for (const event of events) {
			// Re-send the event - since we're now in idle/active mode, it will be processed normally
			this.send(event as MergeEvent);
		}
	}

	private hasLocalChangedSinceLCA(): boolean {
		if (!this._lca) return false;
		const lcaSV = this._lca.stateVector;
		const localSV = this._localStateVector;

		if (!localSV) return false;

		// Check if local has operations not in LCA
		return stateVectorIsAhead(localSV, lcaSV);
	}

	private hasDiskChangedSinceLCA(): boolean {
		if (!this._lca || !this._disk) return false;
		return this._lca.meta.hash !== this._disk.hash;
	}

	private hasRemoteChangedSinceLCA(): boolean {
		if (!this._lca) return false;
		const lcaSV = this._lca.stateVector;
		const remoteSV = this._remoteStateVector;

		if (!remoteSV) return false;

		// Check if remote has operations not in LCA
		return stateVectorIsAhead(remoteSV, lcaSV);
	}

	// ===========================================================================
	// Idle Mode Auto-Merge
	// ===========================================================================

	private attemptIdleAutoMerge(): void {
		// Guard: don't start a new merge if one is already in progress
		if (this._asyncOps.has('idle-merge')) return;

		const state = this._statePath;

		if (state === "idle.remoteAhead") {
			if (!this.hasDiskChangedSinceLCA()) {
				if (!this.pendingIdleUpdates) {
					// Remote state vector advanced but no actual updates to merge
					// (server echoes were skipped by the content-match check in handleRemoteUpdate).
					// Disk already has correct content — update LCA state vector and sync.
					if (this._lca && this._remoteStateVector) {
						this._lca.stateVector = this._remoteStateVector;
						this._localStateVector = this._remoteStateVector;
						this.emitPersistState();
					}
					this.transitionTo("idle.synced");
					return;
				}
				this.performIdleRemoteAutoMerge();
			}
		} else if (state === "idle.diskAhead") {
			if (!this.hasRemoteChangedSinceLCA()) {
				this.performIdleDiskAutoMerge();
			}
		} else if (state === "idle.diverged") {
			if (!this._lca) return;
			this.spawnAsync('idle-merge', async (signal) => {
				await this.performIdleThreeWayMerge();
				if (!signal.aborted && this._statePath !== "idle.diverged") {
					this.attemptIdleAutoMerge();
				}
			});
		}
	}

	private performIdleRemoteAutoMerge(): void {
		if (!this.pendingIdleUpdates || !this._lca) return;

		this.spawnAsync('idle-merge', async (signal) => {
			const localUpdates = await this._loadUpdatesRaw(this.vaultId);

			// Guard against race or cancellation
			if (signal.aborted) return;
			if (this._statePath !== "idle.remoteAhead") return;
			if (!this.pendingIdleUpdates) return;

			// Step 1: Merge local updates into a single update (no Y.Doc needed)
			const localMerged =
				localUpdates.length > 0
					? Y.mergeUpdates(localUpdates)
					: new Uint8Array();

			// Step 2: Get local state vector before merge (no Y.Doc needed)
			const localStateVector =
				localMerged.length > 0
					? Y.encodeStateVectorFromUpdate(localMerged)
					: new Uint8Array([0]);

			// Step 3: Merge local + remote updates (no Y.Doc needed)
			const updatesToMerge =
				localMerged.length > 0
					? [localMerged, this.pendingIdleUpdates!]
					: [this.pendingIdleUpdates!];
			const merged = Y.mergeUpdates(updatesToMerge);

			// Step 4: Check if merge actually added anything (no Y.Doc needed)
			const mergedStateVector = Y.encodeStateVectorFromUpdate(merged);
			if (stateVectorsEqual(localStateVector, mergedStateVector)) {
				// Remote had nothing new - skip hydration and disk write
				this.pendingIdleUpdates = null;
				this.transitionTo("idle.synced");
				return;
			}

			// Check if local and remote have identical CONTENT before merging.
			// Different state vectors with identical content means the same text was inserted
			// by different clients. Merging in this case duplicates content because Yjs
			// preserves both sets of operations.
			let localContent = "";
			let remoteContent = "";
			if (localMerged.length > 0) {
				const localDoc = new Y.Doc();
				try {
					Y.applyUpdate(localDoc, localMerged, this);
					localContent = localDoc.getText("contents").toString();
				} finally {
					localDoc.destroy();
				}
			}
			const remoteDoc = new Y.Doc();
			try {
				Y.applyUpdate(remoteDoc, this.pendingIdleUpdates!, this);
				remoteContent = remoteDoc.getText("contents").toString();
			} finally {
				remoteDoc.destroy();
			}

			if (localContent === remoteContent) {
				this.pendingIdleUpdates = null;
				this.transitionTo("idle.synced");
				return;
			}

			// Step 5: Hydrate to extract text content
			const tempDoc = new Y.Doc();
			try {
				Y.applyUpdate(tempDoc, merged, this);
				const mergedContent = tempDoc.getText("contents").toString();
				const stateVector = Y.encodeStateVector(tempDoc);

				this.emitEffect({
					type: "WRITE_DISK",
					path: this._path,
					contents: mergedContent,
				});

				const fullState = Y.encodeStateAsUpdate(tempDoc);
				this.emitEffect({
					type: "PERSIST_UPDATES",
					dbName: this.vaultId,
					update: fullState,
				});

				this.pendingIdleUpdates = fullState;
				this.transitionTo("idle.synced");

				this._localStateVector = stateVector;
				this._remoteStateVector = stateVector;

				const hash = await this.hashFn(mergedContent);
				if (!signal.aborted) {
					this._lca = {
						contents: mergedContent,
						meta: { hash, mtime: this.timeProvider.now() },
						stateVector,
					};
					this.emitPersistState();
				}
			} finally {
				tempDoc.destroy();
			}

			// Re-check for updates that arrived during the merge
			if (!signal.aborted) {
				this.attemptIdleAutoMerge();
			}
		});
	}

	private performIdleDiskAutoMerge(): void {
		if (!this.pendingDiskContents || !this._lca) return;

		this.spawnAsync('idle-merge', async (signal) => {
			const localUpdates = await this._loadUpdatesRaw(this.vaultId);

			// Guard against race or cancellation
			if (signal.aborted) return;
			if (this._statePath !== "idle.diskAhead") return;
			if (!this.pendingDiskContents) return;

			const diskContent = this.pendingDiskContents;
			const diskHash = this._disk?.hash;
			const diskMtime = this._disk?.mtime ?? this.timeProvider.now();

			const tempDoc = new Y.Doc();
			try {
				// Step 1: Apply existing local updates to get the current CRDT state
				if (localUpdates.length > 0) {
					const localMerged = Y.mergeUpdates(localUpdates);
					Y.applyUpdate(tempDoc, localMerged, this);
				}

				// Step 2: Capture state vector BEFORE modifying (for diff encoding)
				const previousStateVector = Y.encodeStateVector(tempDoc);

				// Step 3: Apply disk content using diff-based updates
				// INVARIANT: Never use delete-all/insert-all pattern - it creates
				// CRDT operations that cause duplication when merged with other clients
				const ytext = tempDoc.getText("contents");
				const currentContent = ytext.toString();
				if (currentContent !== diskContent) {
					const dmp = new diff_match_patch();
					const diffs = dmp.diff_main(currentContent, diskContent);
					dmp.diff_cleanupSemantic(diffs);
					tempDoc.transact(() => {
						let cursor = 0;
						for (const [operation, text] of diffs) {
							switch (operation) {
								case 1:
									ytext.insert(cursor, text);
									cursor += text.length;
									break;
								case 0:
									cursor += text.length;
									break;
								case -1:
									ytext.delete(cursor, text.length);
									break;
							}
						}
					}, this);
				}

				// Step 4: Encode only the DIFF (changes from previous state to new state)
				const diffUpdate = Y.encodeStateAsUpdate(
					tempDoc,
					previousStateVector,
				);
				const newStateVector = Y.encodeStateVector(tempDoc);

				this.emitEffect({ type: "SYNC_TO_REMOTE", update: diffUpdate });
				this.emitEffect({
					type: "PERSIST_UPDATES",
					dbName: this.vaultId,
					update: diffUpdate,
				});

				this.pendingDiskContents = null;
				this.transitionTo("idle.synced");

				this._localStateVector = newStateVector;
				this._remoteStateVector = newStateVector;

				const hash = diskHash ?? (await this.hashFn(diskContent));
				if (!signal.aborted) {
					this._lca = {
						contents: diskContent,
						meta: { hash, mtime: diskMtime },
						stateVector: newStateVector,
					};
					this.emitPersistState();
				}
			} finally {
				tempDoc.destroy();
			}

			// Re-check for updates that arrived during the merge
			if (!signal.aborted) {
				this.attemptIdleAutoMerge();
			}
		});
	}

	private async performIdleThreeWayMerge(): Promise<void> {
		if (!this._lca) return;

		const lcaContent = this._lca.contents;

		// BUG-021 FIX: Load local updates from IndexedDB and merge with remote.
		// Previously, we applied pendingIdleUpdates to an empty Y.Doc which caused
		// data loss when the remote CRDT was empty/uninitialized.
		const localUpdates = await this._loadUpdatesRaw(this.vaultId);

		// Compute the merged CRDT content (local + remote updates)
		let crdtContent = lcaContent;
		const updatesToMerge: Uint8Array[] = [];

		// Include local updates from IndexedDB
		if (localUpdates.length > 0) {
			updatesToMerge.push(Y.mergeUpdates(localUpdates));
		}

		// Include pending remote updates
		if (this.pendingIdleUpdates) {
			updatesToMerge.push(this.pendingIdleUpdates);
		}

		// Extract content from merged CRDT updates
		if (updatesToMerge.length > 0) {
			const merged = Y.mergeUpdates(updatesToMerge);
			const tempDoc = new Y.Doc();
			try {
				Y.applyUpdate(tempDoc, merged, this);
				crdtContent = tempDoc.getText("contents").toString();
			} finally {
				tempDoc.destroy();
			}
		}

		const diskContent = this.pendingDiskContents ?? lcaContent;

		// 3-way merge: lca (base), disk (local changes), crdt (remote changes)
		const mergeResult = performThreeWayMerge(
			lcaContent,
			diskContent,
			crdtContent,
		);

		if (mergeResult.success) {
			this.emitEffect({
				type: "WRITE_DISK",
				path: this._path,
				contents: mergeResult.merged,
			});

			const tempDoc = new Y.Doc();
			try {
				tempDoc.getText("contents").insert(0, mergeResult.merged);
				const stateVector = Y.encodeStateVector(tempDoc);

				// Update local and remote state vectors (now in sync after merge)
				this._localStateVector = stateVector;
				this._remoteStateVector = stateVector;

				this._lca = {
					contents: mergeResult.merged,
					meta: {
						// Merged content is new, compute hash
						hash: await this.hashFn(mergeResult.merged),
						mtime: this.timeProvider.now(),
					},
					stateVector,
				};
			} finally {
				tempDoc.destroy();
			}

			const syncDoc = new Y.Doc();
			try {
				syncDoc.getText("contents").insert(0, mergeResult.merged);
				const update = Y.encodeStateAsUpdate(syncDoc);
				this.emitEffect({ type: "SYNC_TO_REMOTE", update });
				this.emitEffect({
					type: "PERSIST_UPDATES",
					dbName: this.vaultId,
					update,
				});
			} finally {
				syncDoc.destroy();
			}

			this.pendingIdleUpdates = null;
			this.pendingDiskContents = null;

			this.transitionTo("idle.synced");
			this.emitPersistState();
		}
		// Note: If merge fails (conflict), we stay in idle.diverged.
		// The finally block in attemptIdleAutoMerge checks state and
		// only retries if we transitioned out of diverged (i.e., merge succeeded).
	}

	private handleUnload(): void {
		// Remove remoteDoc CRDT logging observer
		if (this._remoteDocLogHandler) {
			this.remoteDoc.off("update", this._remoteDocLogHandler);
			this._remoteDocLogHandler = null;
		}

		this.transitionTo("unloading");

		this.spawnAsync('cleanup', async () => {
			try {
				await this.cleanupYDocs();
				this.transitionTo("unloaded");
			} catch (err) {
				console.error("[MergeHSM] Error during unload cleanup:", err);
				this.transitionTo("unloaded");
			}
		});
	}

	// ===========================================================================
	// Lock Management (Idle ↔ Active)
	// ===========================================================================

	private handleAcquireLock(event?: { editorContent: string }): void {
		if (
			this._statePath === "loading" ||
			this._statePath === "active.loading" ||
			this._statePath.startsWith("idle.")
		) {
			if (event?.editorContent !== undefined) {
				this.pendingEditorContent = event.editorContent;
				this.lastKnownEditorText = event.editorContent;
			}

			if (this._statePath.startsWith("idle.")) {
				this._enteringFromDiverged = this._statePath === "idle.diverged";
			}

			this._providerSynced = false;
			// createYDocs() is called by onEnterState()
			this.transitionTo("active.entering.awaitingPersistence");
		}
	}

	/**
	 * Perform two-way merge when no LCA is available.
	 * Per spec: always shows diff UI for user resolution.
	 * Edits in differ write immediately to CRDT/disk.
	 */
	private performTwoWayMerge(localText: string, diskText: string): void {
		// Populate conflictData for the diff UI
		this.conflictData = {
			base: "", // No baseline available
			local: localText,
			remote: diskText,
			conflictRegions: [], // No regions - entire content is in conflict
			resolvedIndices: new Set(),
			positionedConflicts: [],
		};

		// Two-way merge always shows diff UI - send MERGE_CONFLICT to transition
		this.send({
			type: "MERGE_CONFLICT",
			base: "",
			local: localText,
			remote: diskText,
			conflictRegions: [],
		});
	}

	/**
	 * Perform three-way merge when LCA is available.
	 * Per spec: attempts auto-resolve, shows conflict UI only if truly unresolvable.
	 */
	private performThreeWayMergeFromState(): void {
		const localText = this.localDoc?.getText("contents").toString() ?? "";
		const diskText =
			this.lastKnownEditorText ?? this.pendingEditorContent ?? "";
		const baseText = this._lca?.contents ?? "";

		// BUG-043 fix: If local and disk have identical content, skip merge entirely.
		// This can happen when reopening from idle.diverged after an edit+save session
		// where IDB and disk both have the updated content. In this case, no merge is
		// needed - just transition to tracking. This prevents potential duplication
		// from diff3 merge when both sides made identical changes relative to LCA.
		if (localText === diskText) {
			this.pendingEditorContent = null;
			this.send({
				type: "MERGE_SUCCESS",
				newLCA: this._lca ?? {
					contents: "",
					meta: { hash: "", mtime: 0 },
					stateVector: new Uint8Array([0]),
				},
			});
			this.mergeRemoteToLocal();
			return;
		}

		// BUG-046 fix: If local CRDT is empty but disk has content, the CRDT was never
		// initialized (fresh IndexedDB). Don't treat empty as "user deleted everything"
		// in the three-way merge. Instead, initialize CRDT directly from disk content.
		// Editor already shows disk content, so no CM6 dispatch needed.
		if (localText === "" && diskText !== "") {
			this.applyContentToLocalDoc(diskText);
			this.pendingEditorContent = null;
			this.send({
				type: "MERGE_SUCCESS",
				newLCA: this._lca ?? {
					contents: "",
					meta: { hash: "", mtime: 0 },
					stateVector: new Uint8Array([0]),
				},
			});
			this.mergeRemoteToLocal();
			return;
		}

		const mergeResult = performThreeWayMerge(baseText, localText, diskText);

		if (mergeResult.success) {
			// Merge succeeded - apply to localDoc and dispatch to editor
			this.applyContentToLocalDoc(mergeResult.merged);

			// BUG-042 fix: Only dispatch patches to editor if editor content differs from merged result.
			// The patches are computed from localText→merged, but the editor has diskText.
			// If diskText === merged (common case when local === base), skip dispatch to avoid duplication.
			if (mergeResult.patches.length > 0 && diskText !== mergeResult.merged) {
				// Editor content differs from merge result - compute patches from disk→merged
				const editorPatches = computeDiffMatchPatchChanges(
					diskText,
					mergeResult.merged,
				);
				if (editorPatches.length > 0) {
					this.emitEffect({ type: "DISPATCH_CM6", changes: editorPatches });
				}
			}

			// Per spec: LCA is never touched during active.* states.
			// Send MERGE_SUCCESS to transition to tracking. LCA will be
			// established when file transitions to idle mode.
			// Note: newLCA is required by the event type but ignored by handler.
			this.send({
				type: "MERGE_SUCCESS",
				newLCA: this._lca ?? {
					contents: "",
					meta: { hash: "", mtime: 0 },
					stateVector: new Uint8Array([0]),
				},
			});

			// Clear pending editor content
			this.pendingEditorContent = null;
			// Merge any remote content that accumulated during active.entering
			this.mergeRemoteToLocal();
		} else {
			// Merge has conflicts - populate conflictData for banner/diff view
			this.conflictData = {
				base: baseText,
				local: localText,
				remote: diskText,
				conflictRegions: mergeResult.conflictRegions ?? [],
				resolvedIndices: new Set(),
				positionedConflicts: this.calculateConflictPositions(
					mergeResult.conflictRegions ?? [],
					localText,
				),
			};

			// Send MERGE_CONFLICT to transition to conflict state
			this.send({
				type: "MERGE_CONFLICT",
				base: baseText,
				local: localText,
				remote: diskText,
				conflictRegions: mergeResult.conflictRegions,
			});
		}
	}

	private handleReleaseLock(): void {
		if (this._statePath.startsWith("active.")) {
			const wasInConflict = this._statePath.includes("conflict");

			this.transitionTo("unloading");

			this.spawnAsync('cleanup', async () => {
				try {
					await this.cleanupYDocs();
					if (wasInConflict) {
						this.transitionTo("idle.diverged");
					} else {
						this.determineAndTransitionToIdleState();
					}
				} catch (err) {
					console.error("[MergeHSM] Error during release lock cleanup:", err);
					this.determineAndTransitionToIdleState();
				}
			});
		}
	}

	// ===========================================================================
	// YDoc Management
	// ===========================================================================

	private describeOrigin(origin: unknown): string {
		if (origin === this) return "HSM";
		if (origin === this.remoteDoc) return "remoteDoc";
		if (origin === this.localPersistence) return "persistence";
		if (origin === null || origin === undefined) return "null";
		if (typeof origin === "string") return `"${origin}"`;
		return (
			(origin as { constructor?: { name?: string } })?.constructor?.name ??
			typeof origin
		);
	}

	private makeCRDTUpdateLogger(docName: string, doc: Y.Doc) {
		return (update: Uint8Array, origin: unknown) => {
			const sv = Y.decodeStateVector(Y.encodeStateVector(doc));
			const clientEntries = [...sv.entries()].map(
				([id, clock]) => `${id}:${clock}`,
			);
			const text = doc.getText("contents").toString();
			this.crdtLog(
				`${docName} update | origin=${this.describeOrigin(origin)} | clients=[${clientEntries.join(",")}] | len=${text.length} | bytes=${update.length} | state=${this._statePath}`,
			);
		};
	}

	private setupCRDTLogging(): void {
		this.localDoc!.on(
			"update",
			this.makeCRDTUpdateLogger("localDoc", this.localDoc!),
		);
		this.remoteDoc!.on(
			"update",
			this.makeCRDTUpdateLogger("remoteDoc", this.remoteDoc!),
		);
	}

	private createYDocs(): void {
		// Reuse localDoc if it already exists (e.g., from initializeFromRemote() enrollment)
		if (!this.localDoc) {
			this.localDoc = new Y.Doc();

			// Reuse the client ID from a previous session if available.
			// This prevents content duplication when IDB is empty on reopen:
			// without this fix, a new client ID would be used to insert the same
			// content, causing duplication when merged with remoteDoc's history.
			if (this._localDocClientID !== null) {
				const freshClientID = this.localDoc.clientID;
				this.localDoc.clientID = this._localDocClientID;
				this.crdtLog(
					`createYDocs | reusing clientID=${this._localDocClientID} (fresh would have been ${freshClientID})`,
				);
			} else {
				this.crdtLog(`createYDocs | new clientID=${this.localDoc.clientID}`);
			}
		}

		// Register CRDT update observers for debugging
		this.setupCRDTLogging();

		// Attach persistence to localDoc — it loads stored updates
		// asynchronously and fires 'synced' when done.
		// Reuse persistence if it already exists (e.g., from initializeFromRemote() enrollment)
		// PermanentUserData is set up later in handleLocalPersistenceSynced()
		// AFTER the DB is open and IDB is loaded. This is critical because PUD
		// advances the client's Yjs clock. If PUD runs before IDB is loaded,
		// subsequent content operations reference post-PUD clock positions.
		// The _storeUpdate handler can't capture PUD operations (DB not open
		// yet), and on reload the content operations become orphaned — they
		// reference clock positions that don't exist, causing silent data loss.
		if (!this.localPersistence) {
			this.localPersistence = this._createPersistence(
				this.vaultId,
				this.localDoc,
				this._userId,
			);
		}

		// Check if persistence already synced (race condition fix).
		// If synced is already true, the 'synced' event won't fire again,
		// so we must call the handler immediately.
		if (this.localPersistence.synced) {
			this.handleLocalPersistenceSynced();
		} else {
			this.localPersistence.once("synced", () => {
				this.handleLocalPersistenceSynced();
			});
		}
	}

	/**
	 * Handle local persistence synced event.
	 * Called either immediately if persistence was already synced,
	 * or via the 'synced' event callback.
	 */
	private handleLocalPersistenceSynced(): void {
		// Set persistence metadata for recovery/debugging
		if (this._persistenceMetadata && this.localPersistence?.set) {
			this.localPersistence.set("path", this._persistenceMetadata.path);
			this.localPersistence.set("relay", this._persistenceMetadata.relay);
			this.localPersistence.set("appId", this._persistenceMetadata.appId);
			this.localPersistence.set("s3rn", this._persistenceMetadata.s3rn);
		}

		// Determine if IDB had stored CRDT state by checking database size directly.
		// This is checked BEFORE applying pendingIdleUpdates so it reflects
		// only what the persistence database loaded.
		//
		// NOTE: We intentionally do NOT check for LCA existence here.
		// Per System Invariant #3: "When IDB is empty (no persisted CRDT), the HSM
		// must consult the server before making a merge decision."
		// Even if LCA exists (from a previous session), if IDB is empty we must
		// wait for PROVIDER_SYNCED to get the server's CRDT state before proceeding.
		// Otherwise we'd go straight to reconciling with empty localDoc, trigger
		// a merge that re-inserts disk content with a new client ID, and cause
		// content duplication when synced with remoteDoc's existing history.
		if (!this.localPersistence) {
			throw new Error(
				"[MergeHSM] localPersistence is null in handleLocalPersistenceSynced",
			);
		}
		// Check if IDB has stored content. PermanentUserData setup is handled
		// automatically by persistence when it syncs (if userId was provided).
		const hasContent = this.localPersistence.hasUserData();
		const localText = this.localDoc?.getText("contents").toString() ?? "";

		this.crdtLog(
			`persistence synced | hasContent=${hasContent} | ` +
				`localDocLen=${localText.length} | clientID=${this.localDoc?.clientID} | ` +
				`savedClientID=${this._localDocClientID}`,
		);

		// BUG-048 fix: Only apply pendingIdleUpdates when localDoc is empty.
		// If localDoc has content from IndexedDB, we must NOT blindly apply pendingIdleUpdates
		// even if the content matches - the CRDT histories may differ (same text inserted by
		// different clients), and applying would duplicate content.
		//
		// Instead, let mergeRemoteToLocal() in handleYDocsReady() handle the merge properly.
		// It compares content and returns early if they match, without risking duplication.
		if (
			this.pendingIdleUpdates &&
			this.pendingIdleUpdates.length > 0 &&
			this.localDoc
		) {
			const localText = this.localDoc.getText("contents").toString();

			// Only apply if localDoc is empty - safe to apply remote content
			if (localText === "") {
				Y.applyUpdate(this.localDoc, this.pendingIdleUpdates, this.remoteDoc);
			}
			// If localDoc has content, DO NOT apply - let mergeRemoteToLocal() handle it
			this.pendingIdleUpdates = null;
		}

		// Clear initialPersistenceUpdates - no longer needed (state vector already computed)
		this.initialPersistenceUpdates = null;

		// Update state vector to reflect what's in localDoc
		if (this.localDoc) {
			this._localStateVector = Y.encodeStateVector(this.localDoc);

			// Record the client ID for reuse across lock cycles.
			// This prevents content duplication when IDB comes back empty on reopen.
			if (this._localDocClientID === null) {
				this._localDocClientID = this.localDoc.clientID;
			}
		}

		// Set up observer for remote updates (converts deltas to positioned changes)
		this.setupLocalDocObserver();

		// Signal persistence sync complete with IDB content status
		this.send({ type: "PERSISTENCE_SYNCED", hasContent });
	}

	/**
	 * Handle PERSISTENCE_SYNCED event.
	 * Drives the entering substate machine based on whether IDB had content.
	 */
	private handlePersistenceSynced(event: { hasContent: boolean }): void {
		if (!this.matches("active.entering")) return;

		if (event.hasContent) {
			// IDB had content → go straight to reconciliation
			this.transitionTo("active.entering.reconciling");
			this.performReconciliation();
		} else {
			// IDB was empty → check if provider already synced
			if (this._providerSynced) {
				// Provider already synced (before or during persistence load)
				this.applyRemoteToLocalIfNeeded();
				this.transitionTo("active.entering.reconciling");
				this.performReconciliation();
			} else {
				// Wait for PROVIDER_SYNCED
				this.transitionTo("active.entering.awaitingRemote");
			}
		}
	}

	/**
	 * When IDB was empty and the server has content, apply server CRDT to localDoc.
	 * This ensures localDoc has the latest remote state before reconciliation.
	 */
	private applyRemoteToLocalIfNeeded(): void {
		if (!this.localDoc) return;

		const localText = this.localDoc.getText("contents").toString();
		const remoteText = this.remoteDoc.getText("contents").toString();

		// Only apply if localDoc is empty and remoteDoc has content
		if (localText === "" && remoteText !== "") {
			const update = Y.encodeStateAsUpdate(
				this.remoteDoc,
				Y.encodeStateVector(this.localDoc),
			);
			Y.applyUpdate(this.localDoc, update, this.remoteDoc);
		}
	}

	/**
	 * Perform reconciliation: compare localDoc vs disk content and decide
	 * tracking/twoWay/threeWay. Called when all data sources have been consulted.
	 */
	private performReconciliation(): void {
		if (!this.matches("active.entering.reconciling")) return;

		const localText = this.localDoc?.getText("contents").toString() ?? "";
		const diskText =
			this.lastKnownEditorText ?? this.pendingEditorContent ?? "";
		const isRecoveryMode = this._lca === null;

		// Clear the flag
		this._enteringFromDiverged = false;

		if (localText === diskText) {
			// Content matches — proceed to tracking.
			this.pendingEditorContent = null;
			this.transitionTo("active.tracking");
			// Merge any remote content that accumulated during active.entering
			this.mergeRemoteToLocal();
			// Replay any events accumulated during loading states
			this.replayAccumulatedEvents();
			return;
		}

		// Content differs — transition to appropriate merging state per spec
		if (isRecoveryMode) {
			this.transitionTo("active.merging.twoWay");
			this.replayAccumulatedEvents();
			this.performTwoWayMerge(localText, diskText);
		} else {
			this.transitionTo("active.merging.threeWay");
			this.replayAccumulatedEvents();
			this.performThreeWayMergeFromState();
		}
	}

	/**
	 * Set up Y.Text observer on localDoc to convert Yjs deltas to PositionedChange[].
	 * When updates are applied with origin='remote', the observer fires with event.delta
	 * which we convert directly to positioned changes for CM6.
	 */
	private setupLocalDocObserver(): void {
		if (!this.localDoc) return;

		const ytext = this.localDoc.getText("contents");
		this.localTextObserver = (event: Y.YTextEvent, tr: Y.Transaction) => {
			// Skip changes originated by this HSM (CM6 edits, conflict resolution, etc.).
			// Remote-originated changes use remoteDoc as origin, so they pass through.
			if (tr.origin === this) return;

			// Only dispatch in tracking state
			if (this._statePath !== "active.tracking") return;

			// Convert delta to positioned changes
			const changes = this.deltaToPositionedChanges(event.delta);
			if (changes.length > 0) {
				this.emitEffect({ type: "DISPATCH_CM6", changes });
			}
		};
		ytext.observe(this.localTextObserver);
	}

	/**
	 * Convert a Yjs delta to PositionedChange[].
	 * Same logic as the legacy path in LiveEditPlugin.
	 */
	private deltaToPositionedChanges(
		delta: Array<{
			insert?: string | object;
			delete?: number;
			retain?: number;
		}>,
	): PositionedChange[] {
		const changes: PositionedChange[] = [];
		let pos = 0;

		for (const d of delta) {
			if (d.insert != null) {
				// Insert is string content (we ignore embedded objects)
				const insertText = typeof d.insert === "string" ? d.insert : "";
				if (insertText) {
					changes.push({ from: pos, to: pos, insert: insertText });
				}
			} else if (d.delete != null) {
				changes.push({ from: pos, to: pos + d.delete, insert: "" });
				pos += d.delete;
			} else if (d.retain != null) {
				pos += d.retain;
			}
		}
		return changes;
	}

	private async cleanupYDocs(): Promise<void> {
		// Capture final state before cleanup for idle state determination and LCA update
		let finalContent: string | null = null;
		if (this.localDoc) {
			this._localStateVector = Y.encodeStateVector(this.localDoc);
			finalContent = this.localDoc.getText("contents").toString();
		}

		// BUG-044 fix: Update LCA if disk matches final localDoc content.
		// This ensures that after a successful edit+save session, we transition to
		// idle.synced instead of idle.diverged, preventing content duplication on reopen.
		//
		// BUG-045 fix: Also check content equality (not just hash) as a fallback.
		// Hash mismatches can occur due to different hash computation paths
		// (SAVE_COMPLETE vs DISK_CHANGED vs internal hashFn).
		//
		// BUG-046 fix: Also check lastKnownEditorText, which is what we saved to disk.
		// After SAVE_COMPLETE, pendingDiskContents is null (no DISK_CHANGED event yet),
		// but lastKnownEditorText contains what was written to disk via Ctrl+S.
		if (finalContent !== null && this._disk) {
			const contentHash = await this.hashFn(finalContent);
			const hashMatches = contentHash === this._disk.hash;
			// Fallback to content comparison if hash doesn't match:
			// - pendingDiskContents: set from DISK_CHANGED events
			// - lastKnownEditorText: set from CM6_CHANGE/ACQUIRE_LOCK, represents what was saved
			const contentMatches =
				hashMatches ||
				this.pendingDiskContents === finalContent ||
				this.lastKnownEditorText === finalContent;

			if (contentMatches) {
				// Disk matches localDoc - update LCA to reflect the synced state.
				// Use disk.hash (not contentHash) to ensure hasDiskChangedSinceLCA()
				// returns false, even if hash functions differ between sources.
				this._lca = {
					contents: finalContent,
					meta: {
						hash: this._disk.hash,
						mtime: this._disk.mtime,
					},
					stateVector: this._localStateVector ?? new Uint8Array([0]),
				};
				// Persist the updated LCA
				this.emitPersistState();
			}
		}

		// Clean up Y.Text observer before destroying doc
		if (this.localDoc && this.localTextObserver) {
			const ytext = this.localDoc.getText("contents");
			ytext.unobserve(this.localTextObserver);
			this.localTextObserver = null;
		}

		if (this.localPersistence) {
			// Await destroy to ensure pending IndexedDB writes complete
			await this.localPersistence.destroy();
			this.localPersistence = null;
		}
		if (this.localDoc) {
			this.localDoc.destroy();
			this.localDoc = null;
		}
		// Do NOT destroy remoteDoc - it's managed externally
	}

	// ===========================================================================
	// Active Mode: Editor Integration
	// ===========================================================================

	private handleCM6Change(event: {
		changes: PositionedChange[];
		docText: string;
		isFromYjs: boolean;
	}): void {
		// Always track editor state, even during active.entering.
		// This ensures we have the most up-to-date editor content for
		// merge decisions in handleYDocsReady.
		this.lastKnownEditorText = event.docText;

		// Only apply to localDoc in tracking state
		if (this._statePath !== "active.tracking") return;

		if (event.isFromYjs) return;

		if (this.localDoc) {
			const ytext = this.localDoc.getText("contents");
			this.localDoc.transact(() => {
				for (const change of event.changes) {
					if (change.to > change.from) {
						ytext.delete(change.from, change.to - change.from);
					}
					if (change.insert) {
						ytext.insert(change.from, change.insert);
					}
				}
			}, this);
		}

		this.syncLocalToRemote();
	}

	// While you may be tempted to try to filter outbound sync based on
	// heuristics, that is always the wrong approach. The error is in the sender.
	private syncLocalToRemote(): void {
		if (!this.localDoc) return;

		const update = Y.encodeStateAsUpdate(
			this.localDoc,
			Y.encodeStateVector(this.remoteDoc),
		);

		if (update.length > 0) {
			Y.applyUpdate(this.remoteDoc, update, this);
			this.emitEffect({ type: "SYNC_TO_REMOTE", update });
		}
	}

	// ===========================================================================
	// Active Mode: Remote Updates
	// ===========================================================================

	private handleRemoteUpdate(event: { update: Uint8Array }): void {
		// While you may be tempted to try to filter inbound messages based on
		// heuristics, that is always the wrong approach. The error is in the sender.
		//
		// Apply update to remoteDoc (always available, managed externally).
		// Yjs apply is idempotent for same-client operations, so re-applying
		// an update the provider already applied is safe (no-op).
		Y.applyUpdate(this.remoteDoc, event.update, this.remoteDoc);
		this._remoteStateVector = Y.encodeStateVector(this.remoteDoc);

		if (
			this._statePath === "loading" ||
			this._statePath === "active.loading" ||
			this.matches("active.entering")
		) {
			// Accumulate for replay after mode transition / reconciliation.
			// active.entering: YDocs are being created; mergeRemoteToLocal() will run
			// after reconciliation completes in performReconciliation().
			const existingRemoteIdx = this._accumulatedEvents.findIndex(
				(e) => e.type === "REMOTE_UPDATE",
			);
			if (existingRemoteIdx >= 0) {
				const existing = this._accumulatedEvents[existingRemoteIdx] as {
					type: "REMOTE_UPDATE";
					update: Uint8Array;
				};
				this._accumulatedEvents[existingRemoteIdx] = {
					type: "REMOTE_UPDATE",
					update: Y.mergeUpdates([existing.update, event.update]),
				};
			} else {
				this._accumulatedEvents.push({
					type: "REMOTE_UPDATE",
					update: event.update,
				});
			}
			return;
		}

		if (this._statePath === "active.tracking") {
			this.mergeRemoteToLocal();
		} else if (this._statePath.startsWith("idle.")) {
			if (this.pendingIdleUpdates) {
				this.pendingIdleUpdates = Y.mergeUpdates([
					this.pendingIdleUpdates,
					event.update,
				]);
			} else {
				this.pendingIdleUpdates = event.update;
			}

			// Emit PERSIST_UPDATES effect for IndexedDB storage (per spec)
			this.emitEffect({
				type: "PERSIST_UPDATES",
				dbName: this.vaultId,
				update: this.pendingIdleUpdates,
			});

			if (this.hasDiskChangedSinceLCA()) {
				this.transitionTo("idle.diverged");
			} else {
				this.transitionTo("idle.remoteAhead");
			}
			this.attemptIdleAutoMerge();
		}
	}

	private handleRemoteDocUpdated(): void {
		if (this._statePath === "active.tracking") {
			this.mergeRemoteToLocal();
		}
	}

	/**
	 * Merge remote changes to local doc.
	 * The Y.Text observer (setupLocalDocObserver) handles emitting DISPATCH_CM6
	 * with correctly positioned changes derived from Yjs deltas.
	 *
	 * While you may be tempted to try to filter inbound messages based on
	 * heuristics, that is always the wrong approach. The error is in the sender.
	 */
	private mergeRemoteToLocal(): void {
		if (!this.localDoc) return;

		const localText = this.localDoc.getText("contents").toString();
		const remoteText = this.remoteDoc.getText("contents").toString();

		// Content already matches - no merge needed
		if (localText === remoteText) {
			return;
		}

		// Content differs - apply delta from remoteDoc to localDoc.
		const update = Y.encodeStateAsUpdate(
			this.remoteDoc,
			Y.encodeStateVector(this.localDoc),
		);
		Y.applyUpdate(this.localDoc, update, this.remoteDoc);
	}

	// ===========================================================================
	// Disk Changes
	// ===========================================================================

	private handleDiskChanged(event: {
		contents: string;
		mtime: number;
		hash: string;
	}): void {
		this._disk = {
			hash: event.hash,
			mtime: event.mtime,
		};

		this.pendingDiskContents = event.contents;

		// Accumulate event during loading state for replay after mode transition
		if (this._statePath === "loading") {
			// Replace any existing DISK_CHANGED event (only keep latest)
			this._accumulatedEvents = this._accumulatedEvents.filter(
				(e) => e.type !== "DISK_CHANGED",
			);
			this._accumulatedEvents.push({
				type: "DISK_CHANGED",
				contents: event.contents,
				mtime: event.mtime,
				hash: event.hash,
			});
			return;
		}

		if (this._statePath === "active.tracking") {
			// In active.tracking, Obsidian handles editor<->disk sync via diff-match-patch.
			// Per spec: LCA is never touched during active.* states.
			// Disk metadata is already updated at the start of this function.
			return;
		} else if (this._statePath.startsWith("idle.")) {
			const diskChanged = this.hasDiskChangedSinceLCA();

			// If disk matches LCA, no state change needed
			if (!diskChanged) {
				// Just update mtime in LCA if hashes match
				if (this._lca && this._lca.meta.hash === event.hash) {
					this._lca = {
						...this._lca,
						meta: {
							...this._lca.meta,
							mtime: event.mtime,
						},
					};
					this.emitPersistState();
				}
				return;
			}

			const remoteChanged = this.hasRemoteChangedSinceLCA();

			if (remoteChanged) {
				this.transitionTo("idle.diverged");
			} else {
				this.transitionTo("idle.diskAhead");
			}
			this.attemptIdleAutoMerge();
		}
	}

	private async performDiskMerge(diskContents: string): Promise<void> {
		if (!this.localDoc) return;

		const localText = this.localDoc.getText("contents").toString();
		const lcaText = this._lca?.contents ?? "";
		// Use disk hash if available (from DISK_CHANGED event)
		const diskHash = this._disk?.hash;

		if (diskContents === localText) {
			this.send({
				type: "MERGE_SUCCESS",
				newLCA: await this.createLCAFromCurrent(diskContents, diskHash),
			});
			return;
		}

		if (diskContents === lcaText) {
			this.send({
				type: "MERGE_SUCCESS",
				newLCA: this._lca!,
			});
			return;
		}

		if (localText === lcaText) {
			this.applyContentToLocalDoc(diskContents);
			this.send({
				type: "MERGE_SUCCESS",
				newLCA: await this.createLCAFromCurrent(diskContents, diskHash),
			});
			return;
		}

		const mergeResult = performThreeWayMerge(lcaText, localText, diskContents);

		if (mergeResult.success) {
			this.applyContentToLocalDoc(mergeResult.merged);

			if (mergeResult.patches.length > 0) {
				this.emitEffect({ type: "DISPATCH_CM6", changes: mergeResult.patches });
			}

			this.send({
				type: "MERGE_SUCCESS",
				// Merged content is new, need to compute hash
				newLCA: await this.createLCAFromCurrent(mergeResult.merged),
			});
		} else {
			this.send({
				type: "MERGE_CONFLICT",
				base: mergeResult.base,
				local: mergeResult.local,
				remote: mergeResult.remote,
				conflictRegions: mergeResult.conflictRegions,
			});
		}
	}

	/**
	 * Apply new content to localDoc using diff-based updates.
	 *
	 * INVARIANT: Never uses delete-all/insert-all pattern. Uses diff-match-patch
	 * to compute minimal edits that preserve CRDT operational history.
	 */
	private applyContentToLocalDoc(newContent: string): void {
		if (!this.localDoc) return;

		const ytext = this.localDoc.getText("contents");
		const currentText = ytext.toString();

		if (currentText === newContent) return;

		// Use diff-match-patch to compute minimal edits
		const dmp = new diff_match_patch();
		const diffs = dmp.diff_main(currentText, newContent);
		dmp.diff_cleanupSemantic(diffs);

		// Apply diffs incrementally to preserve CRDT history
		this.localDoc.transact(() => {
			let cursor = 0;
			for (const [operation, text] of diffs) {
				switch (operation) {
					case 1: // Insert
						ytext.insert(cursor, text);
						cursor += text.length;
						break;
					case 0: // Equal - advance cursor
						cursor += text.length;
						break;
					case -1: // Delete
						ytext.delete(cursor, text.length);
						break;
				}
			}
		}, this);

		this.syncLocalToRemote();
	}

	private async createLCAFromCurrent(
		contents: string,
		hash?: string,
	): Promise<LCAState> {
		return {
			contents,
			meta: {
				hash: hash ?? (await this.hashFn(contents)),
				mtime: this.timeProvider.now(),
			},
			stateVector: this.localDoc
				? Y.encodeStateVector(this.localDoc)
				: new Uint8Array([0]),
		};
	}

	private handleSaveComplete(event: { mtime: number; hash: string }): void {
		// Per spec: LCA is never touched during active.* states.
		// Only update disk state to match what we just saved.
		// This prevents the next poll from seeing a "change" that is actually our own save.
		this._disk = {
			mtime: event.mtime,
			hash: event.hash,
		};
	}

	// ===========================================================================
	// Conflict Resolution
	// ===========================================================================

	private handleMergeSuccess(event: { newLCA: LCAState }): void {
		if (this._statePath.startsWith("active.merging")) {
			// Per spec: LCA is never touched during active.* states.
			// LCA will be established when file transitions to idle mode.
			this.transitionTo("active.tracking");
		}
	}

	private handleMergeConflict(event: {
		base: string;
		local: string;
		remote: string;
		conflictRegions?: ConflictRegion[];
	}): void {
		if (this._statePath.startsWith("active.merging")) {
			const conflictRegions = event.conflictRegions ?? [];
			const positionedConflicts = this.calculateConflictPositions(
				conflictRegions,
				event.local,
			);

			this.conflictData = {
				base: event.base,
				local: event.local,
				remote: event.remote,
				conflictRegions,
				resolvedIndices: new Set(),
				positionedConflicts,
			};

			// Emit effect to show inline decorations
			if (positionedConflicts.length > 0) {
				this.emitEffect({
					type: "SHOW_CONFLICT_DECORATIONS",
					conflictRegions,
					positions: positionedConflicts,
				});
			}

			this.transitionTo("active.conflict.bannerShown");
		}
	}

	/**
	 * Calculate character positions for conflict regions based on line numbers.
	 */
	private calculateConflictPositions(
		regions: ConflictRegion[],
		localContent: string,
	): PositionedConflict[] {
		if (regions.length === 0) return [];

		const lines = localContent.split("\n");
		const lineStarts: number[] = [0];
		for (let i = 0; i < lines.length; i++) {
			lineStarts.push(lineStarts[i] + lines[i].length + 1);
		}

		return regions.map((region, index) => ({
			index,
			localStart: lineStarts[region.baseStart] ?? 0,
			localEnd: lineStarts[region.baseEnd] ?? localContent.length,
			localContent: region.localContent,
			remoteContent: region.remoteContent,
		}));
	}

	/**
	 * Recalculate conflict positions after a hunk is resolved.
	 * Positions shift when earlier hunks are resolved.
	 */
	private recalculateConflictPositions(): void {
		if (!this.conflictData || !this.localDoc) return;

		const currentContent = this.localDoc.getText("contents").toString();
		const unresolvedRegions = this.conflictData.conflictRegions.filter(
			(_, i) => !this.conflictData!.resolvedIndices.has(i),
		);

		// For unresolved regions, we need to find them in the new content
		// This is a simplified approach - in practice we'd need more sophisticated tracking
		// For now, we'll re-emit with adjusted positions
		this.conflictData.local = currentContent;
	}

	/**
	 * Handle per-hunk conflict resolution from inline decorations.
	 */
	private handleResolveHunk(event: ResolveHunkEvent): void {
		// Allow resolving from either bannerShown or resolving state
		if (!this._statePath.includes("conflict")) return;
		if (!this.conflictData || !this.localDoc) return;

		const { index, resolution } = event;

		// Skip if already resolved
		if (this.conflictData.resolvedIndices.has(index)) return;

		const region = this.conflictData.conflictRegions[index];
		const positioned = this.conflictData.positionedConflicts[index];

		if (!region || !positioned) return;

		// Determine content to apply based on resolution type
		let newContent: string;
		switch (resolution) {
			case "local":
				newContent = region.localContent;
				break;
			case "remote":
				newContent = region.remoteContent;
				break;
			case "both":
				newContent = region.localContent + "\n" + region.remoteContent;
				break;
		}

		// Get current editor state
		const beforeText = this.localDoc.getText("contents").toString();

		// Apply to localDoc at the conflict position
		const ytext = this.localDoc.getText("contents");
		this.localDoc.transact(() => {
			// Delete the conflict region
			const deleteLength = positioned.localEnd - positioned.localStart;
			if (deleteLength > 0) {
				ytext.delete(positioned.localStart, deleteLength);
			}
			// Insert resolved content
			if (newContent) {
				ytext.insert(positioned.localStart, newContent);
			}
		}, this);

		// Mark as resolved
		this.conflictData.resolvedIndices.add(index);

		// Emit effect to hide this conflict's decoration
		this.emitEffect({
			type: "HIDE_CONFLICT_DECORATION",
			index,
		});

		// Get updated content
		const afterText = this.localDoc.getText("contents").toString();

		// Emit DISPATCH_CM6 to update editor
		const changes = computePositionedChanges(beforeText, afterText);
		if (changes.length > 0) {
			this.emitEffect({ type: "DISPATCH_CM6", changes });
		}

		// Update stored local content
		this.conflictData.local = afterText;

		// Recalculate positions for remaining conflicts (they shift!)
		this.recalculateConflictPositions();

		// Sync to remote → collaborators see immediately
		this.syncLocalToRemote();

		// Check if all conflicts resolved
		if (
			this.conflictData.resolvedIndices.size ===
			this.conflictData.conflictRegions.length
		) {
			this.finalizeConflictResolution();
		}
	}

	/**
	 * Finalize conflict resolution when all hunks are resolved.
	 * Per spec: LCA is never touched during active.* states.
	 * LCA will be updated when transitioning back to idle mode.
	 */
	private finalizeConflictResolution(): void {
		if (!this.localDoc) return;

		this.conflictData = null;
		this.pendingDiskContents = null;
		this.transitionTo("active.tracking");
	}

	private handleOpenDiffView(): void {
		if (this._statePath === "active.conflict.bannerShown") {
			this.transitionTo("active.conflict.resolving");
		}
	}

	private handleCancel(): void {
		if (this._statePath === "active.conflict.resolving") {
			this.transitionTo("active.conflict.bannerShown");
		}
	}

	private handleResolve(event: MergeEvent): void {
		if (this._statePath !== "active.conflict.resolving") return;

		// Perform resolution work
		switch (event.type) {
			case "RESOLVE_ACCEPT_DISK":
				if (this.conflictData) {
					// Apply disk content to the CRDT
					this.applyContentToLocalDoc(this.conflictData.remote);

					// BUG-044 fix: Don't dispatch CM6 changes for RESOLVE_ACCEPT_DISK.
					// The editor is already showing disk content (Obsidian loaded it from disk
					// when the file was opened). Dispatching changes from CRDT→disk would apply
					// those changes on top of the existing disk content, causing duplication.
					//
					// Per spec: LCA is never touched during active.* states.
					// LCA will be established when file transitions to idle mode.
				}
				break;

			case "RESOLVE_ACCEPT_LOCAL":
				if (this.localDoc && this.conflictData) {
					const localText = this.localDoc.getText("contents").toString();

					// The editor was showing conflictData.remote (disk content).
					// We need to dispatch changes to update the editor to show localText (CRDT content).
					const editorText = this.conflictData.remote;
					const localChanges = computePositionedChanges(editorText, localText);
					if (localChanges.length > 0) {
						this.emitEffect({ type: "DISPATCH_CM6", changes: localChanges });
					}
					// Per spec: LCA is never touched during active.* states.
					// LCA will be established when file transitions to idle mode.
				}
				break;

			case "RESOLVE_ACCEPT_MERGED":
				if ("contents" in event && this.conflictData) {
					this.applyContentToLocalDoc(event.contents);

					// BUG-044 fix: The editor shows disk content (conflictData.remote), not CRDT content.
					// Compute changes from disk→merged to correctly update the editor.
					const editorText = this.conflictData.remote;
					const mergedChanges = computePositionedChanges(
						editorText,
						event.contents,
					);
					if (mergedChanges.length > 0) {
						this.emitEffect({ type: "DISPATCH_CM6", changes: mergedChanges });
					}
					// Per spec: LCA is never touched during active.* states.
					// LCA will be established when file transitions to idle mode.
				}
				break;
		}

		this.conflictData = null;
		this.pendingDiskContents = null;
		this.pendingEditorContent = null;

		// Transition to tracking
		this.transitionTo("active.tracking");
	}

	private handleDismissConflict(): void {
		if (this._statePath !== "active.conflict.bannerShown") return;

		// Set deferred conflict synchronously with disk hash
		// Local hash will be computed and updated asynchronously
		this._deferredConflict = {
			diskHash: this._disk?.hash ?? "",
			localHash: "", // Will be updated asynchronously
		};

		// Transition synchronously
		this.transitionTo("active.tracking");

		// Emit persist state synchronously (with partial deferred conflict)
		this.emitPersistState();

		// Async computation of local hash (fire-and-forget)
		this.computeLocalHash()
			.then((localHash) => {
				if (this._deferredConflict) {
					this._deferredConflict.localHash = localHash;
					// Emit again with updated hash
					this.emitPersistState();
				}
			})
			.catch((err) => {
				this.send({
					type: "ERROR",
					error: err instanceof Error ? err : new Error(String(err)),
				});
			});
	}

	private async computeLocalHash(): Promise<string> {
		if (!this.localDoc) return "";
		const text = this.localDoc.getText("contents").toString();
		return this.hashFn(text);
	}

	// ===========================================================================
	// Connection Events
	// ===========================================================================

	private handleProviderSynced(): void {
		this._providerSynced = true;

		if (this._statePath === "active.entering.awaitingRemote") {
			// Server CRDT now available in remoteDoc — apply to localDoc if needed
			this.applyRemoteToLocalIfNeeded();
			this.transitionTo("active.entering.reconciling");
			this.performReconciliation();
		}
		// In all other states: no-op (just record the flag)
	}

	private handleConnected(): void {
		this._isOnline = true;

		// When we reconnect, flush any pending local changes to remoteDoc.
		// This ensures edits made while offline get synced to the server.
		if (this.localDoc && this._statePath === "active.tracking") {
			this.syncLocalToRemote();
		}
	}

	private handleDisconnected(): void {
		this._isOnline = false;
		// Local edits continue to be applied to localDoc and persisted to IndexedDB.
		// When connectivity returns, handleConnected() will flush pending updates.
	}

	// ===========================================================================
	// Error Handling
	// ===========================================================================

	private handleError(event: { error: Error }): void {
		this._error = event.error;
		if (this._statePath.startsWith("idle.")) {
			this.transitionTo("idle.error");
		}
	}

	// ===========================================================================
	// State Transition Helper
	// ===========================================================================

	private transitionTo(newState: StatePath): void {
		if (process.env.NODE_ENV !== 'production') {
			const allowed = TRANSITIONS[this._statePath];
			if (allowed && !allowed.includes(newState)) {
				console.error(
					`[MergeHSM] Invalid transition: ${this._statePath} → ${newState}`,
				);
			}
		}

		const oldState = this._statePath;
		this.onExitState(oldState, newState);

		const oldStatus = this.lastSyncStatus;
		this._statePath = newState;

		this.onEnterState(newState);

		const newStatus = this.computeSyncStatusType();
		if (oldStatus !== newStatus) {
			this.lastSyncStatus = newStatus;
			this.emitEffect({
				type: "STATUS_CHANGED",
				guid: this._guid,
				status: this.getSyncStatus(),
			});
		}
	}

	private onEnterState(state: StatePath): void {
		switch (state) {
			case 'active.entering.awaitingPersistence':
				this.createYDocs();
				break;
		}
	}

	private onExitState(oldState: StatePath, _newState: StatePath): void {
		if (oldState.startsWith('idle.') && oldState !== 'idle.loading') {
			this.cancelAsync('idle-merge');
		}
	}

	// ===========================================================================
	// Async Operation Lifecycle
	// ===========================================================================

	private spawnAsync(id: string, fn: (signal: AbortSignal) => Promise<void>): void {
		this.cancelAsync(id);
		const controller = new AbortController();
		const promise = fn(controller.signal)
			.catch((err) => {
				if (!controller.signal.aborted) {
					this.send({ type: 'ERROR', error: err instanceof Error ? err : new Error(String(err)) });
				}
			})
			.finally(() => {
				const current = this._asyncOps.get(id);
				if (current?.controller === controller) {
					this._asyncOps.delete(id);
				}
			});
		this._asyncOps.set(id, { controller, promise });
	}

	private cancelAsync(id: string): void {
		const op = this._asyncOps.get(id);
		if (op) {
			op.controller.abort();
			this._asyncOps.delete(id);
		}
	}

	async awaitAsync(id: string): Promise<void> {
		let op = this._asyncOps.get(id);
		while (op) {
			await op.promise;
			op = this._asyncOps.get(id);
		}
	}

	private computeSyncStatusType(): SyncStatusType {
		const statePath = this._statePath;

		if (statePath === "idle.error" || this._error) {
			return "error";
		}

		if (statePath.includes("conflict") || statePath === "idle.diverged") {
			return "conflict";
		}

		if (
			statePath === "idle.localAhead" ||
			statePath === "idle.remoteAhead" ||
			statePath === "idle.diskAhead" ||
			statePath.startsWith("active.merging")
		) {
			return "pending";
		}

		if (statePath === "idle.synced" || statePath === "active.tracking") {
			return "synced";
		}

		if (statePath.startsWith("loading.") || statePath === "unloading") {
			return "pending";
		}

		return "synced";
	}

	// ===========================================================================
	// Diff Computation
	// ===========================================================================

	private computeDiffChanges(from: string, to: string): PositionedChange[] {
		const dmp = new diff_match_patch();
		const diffs = dmp.diff_main(from, to);
		dmp.diff_cleanupSemantic(diffs);

		const changes: PositionedChange[] = [];
		let pos = 0;

		for (const [op, text] of diffs) {
			if (op === 0) {
				pos += text.length;
			} else if (op === -1) {
				changes.push({ from: pos, to: pos + text.length, insert: "" });
				pos += text.length;
			} else if (op === 1) {
				changes.push({ from: pos, to: pos, insert: text });
			}
		}

		return this.mergeAdjacentChanges(changes);
	}

	private mergeAdjacentChanges(
		changes: PositionedChange[],
	): PositionedChange[] {
		if (changes.length <= 1) return changes;

		const merged: PositionedChange[] = [];
		let current = { ...changes[0] };

		for (let i = 1; i < changes.length; i++) {
			const next = changes[i];
			if (current.to === next.from && current.insert === "") {
				current.to = next.to;
				current.insert = next.insert;
			} else if (current.from === next.from && current.to === current.from) {
				current.to = next.to;
				current.insert += next.insert;
			} else {
				merged.push(current);
				current = { ...next };
			}
		}
		merged.push(current);

		return merged;
	}

	// ===========================================================================
	// Effect Emission
	// ===========================================================================

	private emitEffect(effect: MergeEffect): void {
		this._effects.emit(effect);
	}

	private emitPersistState(): void {
		const persistedState: PersistedMergeState = {
			guid: this._guid,
			path: this._path,
			lca: this._lca
				? {
						contents: this._lca.contents,
						hash: this._lca.meta.hash,
						mtime: this._lca.meta.mtime,
						stateVector: this._lca.stateVector,
					}
				: null,
			disk: this._disk,
			localStateVector: this._localStateVector,
			lastStatePath: this._statePath,
			deferredConflict: this._deferredConflict,
			persistedAt: this.timeProvider.now(),
		};

		this.emitEffect({
			type: "PERSIST_STATE",
			guid: this._guid,
			state: persistedState,
		});
	}

	// ===========================================================================
	// State Change Notification
	// ===========================================================================

	private notifyStateChange(
		from: StatePath,
		to: StatePath,
		event: MergeEvent,
	): void {
		// Emit on Observable (per spec)
		this._stateChanges.emit(this.state);

		// Notify legacy listeners (for test harness)
		for (const listener of this.stateChangeListeners) {
			listener(from, to, event);
		}
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if two state vectors represent the same CRDT state.
 * Uses proper CRDT semantics: decodes the state vectors and compares
 * client clocks, rather than byte-by-byte comparison.
 */
function stateVectorsEqual(sv1: Uint8Array, sv2: Uint8Array): boolean {
	const decoded1 = Y.decodeStateVector(sv1);
	const decoded2 = Y.decodeStateVector(sv2);

	// Check all clients in sv1 exist in sv2 with same clock
	for (const [clientId, clock] of decoded1) {
		if (decoded2.get(clientId) !== clock) return false;
	}

	// Check all clients in sv2 exist in sv1 (already checked clock above if they do)
	for (const [clientId] of decoded2) {
		if (!decoded1.has(clientId)) return false;
	}

	return true;
}

/**
 * Check if `ahead` state vector contains operations not present in `behind`.
 * Returns true if any client in `ahead` has a higher clock than in `behind`.
 *
 * This is the proper CRDT way to check "has remote changed since LCA" -
 * we're asking if remote's state vector contains any operations that
 * weren't in the LCA's state vector.
 */
function stateVectorIsAhead(ahead: Uint8Array, behind: Uint8Array): boolean {
	const aheadDecoded = Y.decodeStateVector(ahead);
	const behindDecoded = Y.decodeStateVector(behind);

	for (const [clientId, clock] of aheadDecoded) {
		const behindClock = behindDecoded.get(clientId) ?? 0;
		if (clock > behindClock) return true;
	}

	return false;
}

function computePositionedChanges(
	before: string,
	after: string,
): PositionedChange[] {
	let prefixLen = 0;
	while (
		prefixLen < before.length &&
		prefixLen < after.length &&
		before[prefixLen] === after[prefixLen]
	) {
		prefixLen++;
	}

	let suffixLen = 0;
	while (
		suffixLen < before.length - prefixLen &&
		suffixLen < after.length - prefixLen &&
		before[before.length - 1 - suffixLen] ===
			after[after.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	const from = prefixLen;
	const to = before.length - suffixLen;
	const insert = after.slice(prefixLen, after.length - suffixLen);

	if (from === to && insert === "") {
		return [];
	}

	return [{ from, to, insert }];
}

function simpleHash(contents: string): string {
	let hash = 0;
	for (let i = 0; i < contents.length; i++) {
		const char = contents.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return "hash:" + Math.abs(hash).toString(16);
}

/**
 * Default persistence factory: fires 'synced' synchronously (no IndexedDB).
 * Production code should pass a real factory that creates IndexeddbPersistence.
 */
const defaultCreatePersistence: CreatePersistence = (
	_vaultId: string,
	doc: Y.Doc,
	_userId?: string,
): IYDocPersistence => {
	let hasContent = false;
	return {
		synced: false,
		once(_event: "synced", cb: () => void) {
			// Fire synchronously — for test environments where no IndexedDB exists.
			// Real IndexeddbPersistence fires asynchronously after loading from IDB.
			cb();
		},
		destroy() {
			// No-op
		},
		whenSynced: Promise.resolve(),
		hasUserData() {
			return hasContent;
		},
	};
};

/**
 * Default loadUpdatesRaw: returns empty array (no IndexedDB).
 * Production code should pass the real loadUpdatesRaw from y-indexeddb.
 * Used for idle mode auto-merge (BUG-021 fix).
 */
const defaultLoadUpdatesRaw: LoadUpdatesRaw = async (
	_vaultId: string,
): Promise<Uint8Array[]> => {
	// Return empty array for test environments where no IndexedDB exists.
	// Real implementation should use loadUpdatesRaw from y-indexeddb.
	return [];
};

async function defaultHashFn(contents: string): Promise<string> {
	if (typeof crypto !== "undefined" && crypto.subtle) {
		const encoder = new TextEncoder();
		const data = encoder.encode(contents);
		const hashBuffer = await crypto.subtle.digest("SHA-256", data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}
	return simpleHash(contents);
}

// =============================================================================
// 3-Way Merge Implementation
// =============================================================================

function performThreeWayMerge(
	lca: string,
	local: string,
	remote: string,
): MergeResult {
	const lcaLines = lca.split("\n");
	const localLines = local.split("\n");
	const remoteLines = remote.split("\n");

	const result = diff3Merge(localLines, lcaLines, remoteLines);

	const hasConflict = result.some(
		(region: {
			ok?: string[];
			conflict?: { a: string[]; o: string[]; b: string[] };
		}) => "conflict" in region,
	);

	if (hasConflict) {
		return {
			success: false,
			base: lca,
			local,
			remote,
			conflictRegions: extractConflictRegions(result, lca),
		};
	}

	const mergedLines: string[] = [];
	for (const region of result) {
		if ("ok" in region && region.ok) {
			mergedLines.push(...region.ok);
		}
	}
	const merged = mergedLines.join("\n");

	const patches = computeDiffMatchPatchChanges(local, merged);

	return {
		success: true,
		merged,
		patches,
	};
}

function extractConflictRegions(
	result: Array<{
		ok?: string[];
		conflict?: { a: string[]; o: string[]; b: string[] };
	}>,
	base: string,
): Array<{
	baseStart: number;
	baseEnd: number;
	localContent: string;
	remoteContent: string;
}> {
	const regions: Array<{
		baseStart: number;
		baseEnd: number;
		localContent: string;
		remoteContent: string;
	}> = [];

	let lineOffset = 0;
	for (const region of result) {
		if ("conflict" in region && region.conflict) {
			const { a: localLines, o: baseLines, b: remoteLines } = region.conflict;
			regions.push({
				baseStart: lineOffset,
				baseEnd: lineOffset + (baseLines?.length ?? 0),
				localContent: localLines?.join("\n") ?? "",
				remoteContent: remoteLines?.join("\n") ?? "",
			});
			lineOffset += baseLines?.length ?? 0;
		} else if ("ok" in region && region.ok) {
			lineOffset += region.ok.length;
		}
	}

	return regions;
}

function computeDiffMatchPatchChanges(
	before: string,
	after: string,
): PositionedChange[] {
	if (before === after) return [];

	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(before, after);
	dmp.diff_cleanupSemantic(diffs);

	const changes: PositionedChange[] = [];
	let pos = 0;

	for (const [op, text] of diffs) {
		if (op === 0) {
			pos += text.length;
		} else if (op === -1) {
			changes.push({ from: pos, to: pos + text.length, insert: "" });
			pos += text.length;
		} else if (op === 1) {
			changes.push({ from: pos, to: pos, insert: text });
		}
	}

	return mergeAdjacentChanges(changes);
}

function mergeAdjacentChanges(changes: PositionedChange[]): PositionedChange[] {
	if (changes.length <= 1) return changes;

	const merged: PositionedChange[] = [];
	let i = 0;

	while (i < changes.length) {
		const current = changes[i];

		if (
			i + 1 < changes.length &&
			current.insert === "" &&
			changes[i + 1].from === current.from &&
			changes[i + 1].to === changes[i + 1].from
		) {
			merged.push({
				from: current.from,
				to: current.to,
				insert: changes[i + 1].insert,
			});
			i += 2;
		} else {
			merged.push(current);
			i++;
		}
	}

	return merged;
}
