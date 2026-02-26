/**
 * MergeHSM - Hierarchical State Machine for Document Synchronization
 *
 * Manages the sync between disk, local CRDT (Yjs), and remote CRDT.
 * Pure state machine: events in → state transitions → effects out.
 *
 * Architecture:
 * - Two-YDoc architecture: localDoc (persisted) + remoteDoc (ephemeral)
 * - In active mode: editor ↔ localDoc ↔ remoteDoc ↔ server
 * - In idle mode: localDoc stays alive, persistence writes to IDB automatically
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
	DiskLoader,
	IdleMergeCompleteEvent,
	MachineHSM,
	ActiveInvoke,
	Fork,
	SyncGate,
	CaptureOpts,
	EditorViewRef,
} from "./types";
import type { TimeProvider } from "../TimeProvider";
import { DefaultTimeProvider } from "../TimeProvider";
import { curryLog, recordHSMEntry } from "../debug";
import type { TestableHSM } from "./testing/createTestHSM";
import { processEvent } from "./machine-interpreter";
import { MACHINE, createInterpreterConfig } from "./machine-definition";
import type { InterpreterConfig, GuardFn, ActionFn, InvokeSourceFn } from "./types";
import { DISK_ORIGIN, OpCapture, CapturedOp } from "./undo";

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
// MergeHSM Class
// =============================================================================

export class MergeHSM implements TestableHSM, MachineHSM {
	// Current state path
	private _statePath: StatePath = "unloaded";

	private _guid: string;
	private _getPath: () => string;
	private _lca: LCAState | null = null;
	private _disk: MergeMetadata | null = null;
	private _localStateVector: Uint8Array | null = null;
	private _remoteStateVector: Uint8Array | null = null;
	private _error: Error | undefined;
	private _deferredConflict:
		| { diskHash: string; localHash: string }
		| undefined;

	// Fork: snapshot of localDoc state before disk edit ingestion (idle mode)
	private _fork: Fork | null = null;

	// "After" snapshot of each disk ingestion within the current fork.
	// Each ingestDisk call pushes one entry, giving 1:1 correspondence
	// with CapturedOp entries from OpCapture. Cleared when the fork is cleared.
	private _ingestionTexts: string[] = [];
	// SyncGate: controls CRDT op flow between localDoc and remoteDoc
	private _syncGate: SyncGate = {
		providerConnected: false,
		providerSynced: false,
		localOnly: false,
		pendingInbound: 0,
		pendingOutbound: 0,
	};

	// Live reference to the editor view for reading the dirty flag
	private _editorViewRef: EditorViewRef | null = null;

	// Obsidian file lifecycle tracking (from workspace events)
	private _obsidianFileOpen: boolean = false;

	// YDocs
	private localDoc: Y.Doc | null = null; // Alive in idle + active mode; null when unloaded/hibernated
	private remoteDoc: Y.Doc | null; // Lazily provided, managed externally. Null when hibernated.

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
		ours: string;
		theirs: string;
		oursLabel: string;
		theirsLabel: string;
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

	// Persistence for localDoc (alive in idle + active mode; null when unloaded/hibernated)
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

	// Push-based transition callback for recording bridge
	private _onTransition?: (info: { from: StatePath; to: StatePath; event: MergeEvent; effects: MergeEffect[] }) => void;
	private _pendingEffects: MergeEffect[] | null = null;

	// Legacy listeners (for backward compatibility with test harness)
	private stateChangeListeners: Array<
		(from: StatePath, to: StatePath, event: MergeEvent) => void
	> = [];

	// Configuration
	private timeProvider: TimeProvider;
	private hashFn: (contents: string) => Promise<string>;
	private vaultId: string;
	private _createPersistence: CreatePersistence;
	private _persistenceMetadata?: PersistenceMetadata;
	private _diskLoader: DiskLoader;
	private _isProviderSynced: () => boolean;
	private _captureOpts: CaptureOpts | null;

	// Whether PROVIDER_SYNCED has been received during the current lock cycle
	private _providerSynced = false;

	// Async operation tracking with cancellation support
	private _asyncOps = new Map<string, { controller: AbortController; promise: Promise<void> }>();

	// Declarative machine interpreter state
	private _activeInvoke: ActiveInvoke | null = null;
	private _cleanupType: 'unload' | 'release' | null = null;
	private _cleanupWasConflict = false;
	private _interpreterConfig: InterpreterConfig = createInterpreterConfig();

	// Network connectivity status (does not block state transitions)
	private _isOnline: boolean = false;

	/** Whether sync operations can proceed (provider connected+synced and no fork) */
	private get canSync(): boolean {
		return this._syncGate.providerConnected
			&& this._syncGate.providerSynced
			&& this._fork === null;
	}

	/** Whether sync is actively flowing (canSync and not in local-only mode) */
	private get isSyncing(): boolean {
		return this.canSync && !this._syncGate.localOnly;
	}

	private getOpCapture(): OpCapture | null {
		return this.localPersistence?.opCapture ?? null;
	}

	// User ID for PermanentUserData tracking
	private _userId?: string;

	// CRDT operation logging
	private crdtLog = curryLog("[MergeHSM:CRDT]", "debug");

	// Event accumulation queue for loading state (Gap 11)
	// Events like REMOTE_UPDATE and DISK_CHANGED are accumulated during loading
	// and replayed after mode transition (to idle.* or active.*)
	private _accumulatedEvents: Array<
		| { type: "REMOTE_UPDATE"; update: Uint8Array }
		| { type: "DISK_CHANGED"; contents: string; mtime: number; hash: string }
		| { type: "CM6_CHANGE"; changes: any[]; docText: string; isFromYjs: boolean }
	> = [];

	// Mode decision during loading state (null = not decided, 'idle' or 'active')
	private _modeDecision: "idle" | "active" | null = null;

	// Track if entering active mode from diverged state for conflict handling
	private _enteringFromDiverged: boolean = false;

	constructor(config: MergeHSMConfig) {
		this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
		this.hashFn = config.hashFn ?? defaultHashFn;
		this._guid = config.guid;
		this._getPath = config.getPath;
		this.vaultId = config.vaultId;
		this.remoteDoc = config.remoteDoc;
		this._createPersistence =
			config.createPersistence ?? defaultCreatePersistence;
		this._persistenceMetadata = config.persistenceMetadata;
		this._userId = config.userId;
		this._diskLoader = config.diskLoader;
		this._isProviderSynced = config.isProviderSynced ?? (() => this._syncGate.providerSynced);
		this._captureOpts = {
			scope: "contents",
			trackedOrigins: new Set([DISK_ORIGIN]),
			captureTimeout: 0,
		};
		this._interpreterConfig = createInterpreterConfig({
			guards: this.buildGuards(),
			actions: this.buildActions(),
			invokeSources: this.buildInvokeSources(),
		});
	}

	// ===========================================================================
	// Public API
	// ===========================================================================

	get path(): string {
		return this._getPath();
	}

	get guid(): string {
		return this._guid;
	}

	get state(): MergeState {
		return {
			guid: this._guid,
			path: this.path,
			lca: this._lca,
			disk: this._disk,
			localStateVector: this._localStateVector,
			remoteStateVector: this._remoteStateVector,
			statePath: this._statePath,
			error: this._error,
			deferredConflict: this._deferredConflict,
			fork: this._fork,
			isOnline: this._isOnline,
			pendingEditorContent: this.pendingEditorContent ?? undefined,
			lastKnownEditorText: this.lastKnownEditorText ?? undefined,
		};
	}

	send(event: MergeEvent): void {
		const fromState = this._statePath;
		if (this._onTransition) this._pendingEffects = [];
		this.handleEvent(event);
		const toState = this._statePath;
		if (this._onTransition && this._pendingEffects) {
			this._onTransition({ from: fromState, to: toState, event, effects: this._pendingEffects });
			this._pendingEffects = null;
		}
		// Always notify even if statePath unchanged — subscribers rely on
		// property changes (e.g. diskMtime) that can occur without transitions.
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

	hasFork(): boolean {
		return this._fork !== null;
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

	/**
	 * Check if Obsidian has the file open (based on workspace events).
	 * Used as a fail-closed interlock for disk writes.
	 */
	get isObsidianFileOpen(): boolean {
		return this._obsidianFileOpen;
	}

	getLocalDoc(): Y.Doc | null {
		return this.localDoc;
	}

	/**
	 * Get the length of the local document content.
	 * localDoc is always alive in idle mode, so this returns immediately.
	 */
	async getLocalDocLength(): Promise<number> {
		if (this.localDoc) {
			return this.localDoc.getText("contents").toString().length;
		}
		return 0;
	}

	getConflictData(): {
		base: string;
		ours: string;
		theirs: string;
		oursLabel: string;
		theirsLabel: string;
		conflictRegions?: ConflictRegion[];
		resolvedIndices?: Set<number>;
		positionedConflicts?: PositionedConflict[];
	} | null {
		return this.conflictData;
	}

	getRemoteDoc(): Y.Doc | null {
		return this.remoteDoc;
	}

	/**
	 * Set or replace the remote YDoc. Used by MergeManager to provide
	 * a remoteDoc when waking from hibernation.
	 */
	setRemoteDoc(doc: Y.Doc | null): void {
		this.remoteDoc = doc;
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
	 * Wait for any pending fork reconciliation to complete.
	 * Returns immediately if no fork-reconcile is in progress.
	 */
	async awaitForkReconcile(): Promise<void> {
		await this.awaitAsync('fork-reconcile');
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
	 * Initialize localDoc from downloaded CRDT bytes.
	 * Applies bytes to localDoc via persistence, then derives LCA from localDoc.
	 * No remoteDoc dependency — bytes flow directly from the download.
	 *
	 * @param updateBytes - Raw CRDT update bytes from the server
	 * @param mtime - Modification time from disk
	 * @returns true if initialization happened, false if already initialized
	 */
	async initializeFromRemote(
		updateBytes: Uint8Array,
		mtime: number,
	): Promise<boolean> {
		await this.ensurePersistence();

		const didInitialize = await this.localPersistence!.initializeFromRemote!(updateBytes, this.remoteDoc);

		if (didInitialize) {
			const content = this.localDoc!.getText("contents").toString();
			const hash = await this.hashFn(content);
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
				this._captureOpts,
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
	 *
	 * When actualEditorText is provided, it is used instead of the cached
	 * lastKnownEditorText. This is important because lastKnownEditorText
	 * is only updated via CM6_CHANGE events — if a change bypasses that
	 * path (e.g. Obsidian's metadata renderer calling setViewData), the
	 * cached value will be stale.
	 */
	checkAndCorrectDrift(actualEditorText?: string): boolean {
		if (this._statePath !== "active.tracking") {
			return false;
		}

		if (!this.localDoc) {
			return false;
		}

		const editorText = actualEditorText ?? this.lastKnownEditorText;
		if (editorText === null) {
			return false;
		}

		// Update cached value if caller provided actual editor text
		if (actualEditorText !== undefined) {
			this.lastKnownEditorText = actualEditorText;
		}

		const yjsText = this.localDoc.getText("contents").toString();

		if (editorText === yjsText) {
			return false; // No drift
		}

		// Drift detected — this indicates a bug in the sync pipeline.
		// Log diagnostics so the root cause can be investigated.
		this.logDrift(editorText, yjsText);

		// localDoc (Yjs) wins — dispatch correction to the editor
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
	 * Log drift diagnostic to both relay log and HSM recording.
	 * Captures editor text, CRDT text, and the diff for debugging.
	 */
	private logDrift(editorText: string, yjsText: string): void {
		const driftLog = curryLog(`[MergeHSM:DRIFT:${this._guid}]`, "warn");
		driftLog(
			`Editor and localDoc diverged during active.tracking. ` +
			`Editor: ${editorText.length} chars, localDoc: ${yjsText.length} chars, ` +
			`delta: ${editorText.length - yjsText.length} chars. ` +
			`Correcting editor to match localDoc.`,
		);

		// Write structured diagnostic to HSM recording file (standard format)
		recordHSMEntry({
			ns: "mergeHSM",
			ts: new Date().toISOString(),
			guid: this._guid,
			path: this.path,
			event: "DRIFT_DETECTED",
			from: this._statePath,
			to: this._statePath,
			editorLength: editorText.length,
			yjsLength: yjsText.length,
			editorPreview: editorText.substring(0, 200),
			yjsPreview: yjsText.substring(0, 200),
		});
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
	// MachineHSM Interface (for declarative interpreter)
	// ===========================================================================

	get statePath(): StatePath {
		return this._statePath;
	}

	/**
	 * Transition to a new state path. Called by the interpreter during
	 * transition execution. Updates statePath and emits STATUS_CHANGED
	 * if the sync status category changes.
	 */
	setStatePath(target: StatePath): void {
		const oldStatus = this.lastSyncStatus;
		this._statePath = target;

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

	getActiveInvoke(): ActiveInvoke | null {
		return this._activeInvoke;
	}

	setActiveInvoke(invoke: ActiveInvoke | null): void {
		// Sync with _asyncOps so awaitIdleAutoMerge()/awaitCleanup() continue to work
		if (this._activeInvoke) {
			this._asyncOps.delete(this._activeInvoke.id);
		}
		this._activeInvoke = invoke;
		if (invoke && invoke.promise) {
			const promise = invoke.promise.finally(() => {
				// Clean up from _asyncOps when promise settles
				const current = this._asyncOps.get(invoke.id);
				if (current?.controller === invoke.controller) {
					this._asyncOps.delete(invoke.id);
				}
			});
			this._asyncOps.set(invoke.id, { controller: invoke.controller, promise });
		}
	}

	// ===========================================================================
	// Declarative Machine: Guards, Actions, Invoke Sources
	// ===========================================================================

	private buildGuards(): Record<string, GuardFn> {
		return {
			// Idle state determination (for always transitions in idle.loading)
			allSyncedAtLoad: () => {
				if (!this._lca) {
					// No LCA: synced only if no local state
					return !this._localStateVector || this._localStateVector.length <= 1;
				}
				return !this.hasLocalChangedSinceLCA() && !this.hasDiskChangedSinceLCA() && !this.hasRemoteChangedSinceLCA();
			},
			localAheadAtLoad: () => {
				if (!this._lca) {
					// No LCA: local ahead if we have local state
					return !!this._localStateVector && this._localStateVector.length > 1;
				}
				return this.hasLocalChangedSinceLCA() && !this.hasDiskChangedSinceLCA() && !this.hasRemoteChangedSinceLCA();
			},
			remoteAheadAtLoad: () => {
				if (!this._lca) return false;
				return this.hasRemoteChangedSinceLCA() && !this.hasDiskChangedSinceLCA() && !this.hasLocalChangedSinceLCA();
			},
			diskAheadAtLoad: () => {
				if (!this._lca) return false;
				return this.hasDiskChangedSinceLCA() && !this.hasRemoteChangedSinceLCA() && !this.hasLocalChangedSinceLCA();
			},

			// DISK_CHANGED: check if disk event matches LCA (using event hash, not stored _disk)
			diskMatchesLCA: (_hsm, event) => {
				if (!this._lca) return false;
				return this._lca.meta.hash === (event as any).hash;
			},

			// Idle event guards (for REMOTE_UPDATE candidates)
			diskChangedSinceLCA: () => this.hasDiskChangedSinceLCA(),
			remoteOrLocalAhead: () =>
				this.hasRemoteChangedSinceLCA() || this._statePath === "idle.localAhead",

			// Invoke completion guards
			mergeSucceeded: (_hsm, event) => (event as any).data?.success === true,
			forkWasCreated: (_hsm, event) => (event as any).data?.forked === true,
			awaitingProvider: (_hsm, event) => (event as any).data?.awaitingProvider === true,

			// Fork guard: stay in localAhead when remote updates arrive during fork reconciliation
			hasFork: () => this._fork !== null,

			// === Cleanup guards ===
			cleanupWasConflict: (_hsm, event) => {
				const data = (event as any).data;
				return data?.type === 'release' && data?.wasConflict === true;
			},
			cleanupWasReleaseLock: (_hsm, event) => {
				return (event as any).data?.type === 'release';
			},

			// === Active entering/tracking guards ===
			persistenceHasContent: (_hsm, event) => (event as any).hasContent === true,
			persistenceEmptyAndProviderNotSynced: (_hsm, event) =>
				(event as any).hasContent !== true && !this._providerSynced,
			hasPreexistingConflict: () => this.conflictData !== null,
			contentMatchesAtReconcile: () => {
				const localText = this.localDoc?.getText("contents").toString() ?? "";
				const diskText = this.lastKnownEditorText ?? this.pendingEditorContent ?? "";
				return localText === diskText;
			},
			isRecoveryMode: () => this._lca === null,
			isFromYjs: (_hsm, event) => (event as any).isFromYjs === true,
		};
	}

	private buildActions(): Record<string, ActionFn> {
		return {
			// === Idle loading ===
			ensureLocalDocForIdle: () => this.ensureLocalDocForIdle(),

			// === Remote/Disk data ===
			applyRemoteToRemoteDoc: (_hsm, event) => {
				const update = (event as any).update as Uint8Array;
				if (this.remoteDoc) {
					Y.applyUpdate(this.remoteDoc, update, this.remoteDoc);
					this._remoteStateVector = Y.encodeStateVector(this.remoteDoc);
				} else {
					try {
						this._remoteStateVector = Y.encodeStateVectorFromUpdate(update);
					} catch (e) {
						console.error(`[MergeHSM] Dropping unparseable remote update for ${this._guid} (${update.byteLength} bytes):`, e);
					}
				}
			},
			storePendingRemoteUpdate: (_hsm, event) => {
				const update = (event as any).update as Uint8Array;
				if (this.pendingIdleUpdates) {
					this.pendingIdleUpdates = Y.mergeUpdates([this.pendingIdleUpdates, update]);
				} else {
					this.pendingIdleUpdates = update;
				}
			},
			storeDiskMetadata: (_hsm, event) => {
				const e = event as any;
				this._disk = { hash: e.hash, mtime: e.mtime };
				this.pendingDiskContents = e.contents;
			},
			updateLCAMtime: (_hsm, event) => {
				const e = event as any;
				if (this._lca && this._lca.meta.hash === e.hash) {
					this._lca = {
						...this._lca,
						meta: { ...this._lca.meta, mtime: e.mtime },
					};
					this.emitPersistState();
				}
			},

			// === Idle merge completion ===
			updateLCAFromInvokeResult: (_hsm, event) => {
				const result = (event as any).data;
				if (result?.newLCA) {
					this._lca = result.newLCA;
					this._localStateVector = result.newLCA.stateVector;
					this._remoteStateVector = result.newLCA.stateVector;
					// The idle-merge emits WRITE_DISK, so disk now matches LCA
					if (result.newLCA.meta) {
						this._disk = { hash: result.newLCA.meta.hash, mtime: result.newLCA.meta.mtime };
					}
					this.emitPersistState();
				}
			},

			// === ACQUIRE_LOCK from idle ===
			storeEditorContent: (_hsm, event) => {
				const e = event as any;
				if (e.editorContent !== undefined) {
					this.pendingEditorContent = e.editorContent;
					this.lastKnownEditorText = e.editorContent;
				}
				this._editorViewRef = e.editorViewRef ?? null;
				if (this._statePath.startsWith("idle.")) {
					this._enteringFromDiverged = this._statePath === "idle.diverged";
				}
				this._providerSynced = false;
				this._syncGate.providerSynced = false;
			},

			// === Lifecycle ===
			beginUnload: () => {
				this._cleanupType = 'unload';
			},
			initializeFromLoad: (_hsm, event) => {
				const e = event as any;
				this._guid = e.guid;
				this._modeDecision = null;
				this._accumulatedEvents = [];
				this._disk = null;
				this._remoteStateVector = null;
			},
			storeError: (_hsm, event) => {
				this._error = (event as any).error;
			},
			storePersistenceData: (_hsm, event) => {
				const e = event as any;
				if (!this._lca && e.lca) {
					this._lca = e.lca;
				}
				if (e.localStateVector) {
					this._localStateVector = e.localStateVector;
				} else if (e.updates && e.updates.length > 0) {
					this._localStateVector = Y.encodeStateVectorFromUpdate(e.updates);
					this.initialPersistenceUpdates = e.updates;
				}
				// Restore fork from persisted state
				if (e.fork !== undefined) {
					this._fork = e.fork ?? null;
				}
			},
			initIdleMode: () => {
				this._modeDecision = "idle";
			},
			processAccumulatedForIdle: () => {
				// Extract accumulated REMOTE_UPDATE data into pendingIdleUpdates.
				// The update was already applied to remoteDoc during loading (by applyRemoteToRemoteDoc),
				// but it needs to be in pendingIdleUpdates for the idle merge to use.
				for (const event of this._accumulatedEvents) {
					if (event.type === 'REMOTE_UPDATE') {
						const update = (event as any).update as Uint8Array;
						if (this.pendingIdleUpdates) {
							this.pendingIdleUpdates = Y.mergeUpdates([this.pendingIdleUpdates, update]);
						} else {
							this.pendingIdleUpdates = update;
						}
					}
					// DISK_CHANGED data already stored by storeDiskMetadata during loading
				}
				this._accumulatedEvents = [];
			},

			// === Active conflict/merging actions ===
			trackEditorText: (_hsm, event) => {
				const e = event as any;
				if (e.docText !== undefined) {
					this.lastKnownEditorText = e.docText;
				}
			},
			resolveConflict: (_hsm, event) => {
				const contents = (event as any).contents as string;

				if (!this.localDoc || !this.remoteDoc) {
					this.conflictData = null;
					return;
				}

				// Step 1: Reverse disk ops from OpCapture to undo the disk edit
				// from localDoc's CRDT history. This restores localDoc to its
				// pre-fork state so the CRDT merge in step 2 won't interleave.
				const opCapture = this.getOpCapture();
				if (opCapture && this._fork?.captureMark != null) {
					const diskOps = opCapture.sinceByOrigin(this._fork.captureMark, DISK_ORIGIN);
					opCapture.reverse(diskOps);
				}

				// Step 2: Merge remote CRDT into local so histories converge.
				const remoteUpdate = Y.encodeStateAsUpdate(
					this.remoteDoc,
					Y.encodeStateVector(this.localDoc),
				);
				Y.applyUpdate(this.localDoc, remoteUpdate, this.remoteDoc);

				// Step 3: DMP the resolved text onto localDoc. After the CRDT
				// merge the text may not match what the user chose (e.g. they
				// accepted ours, or merged individual hunks). DMP fixes it up.
				this.applyContentToLocalDoc(contents);

				// Step 4: Sync localDoc → remoteDoc and server. Histories are
				// now converged so the update is clean.
				const outUpdate = Y.encodeStateAsUpdate(
					this.localDoc,
					Y.encodeStateVector(this.remoteDoc),
				);
				if (outUpdate.length > 0) {
					Y.applyUpdate(this.remoteDoc, outUpdate, this.localDoc);
				}
				this.emitEffect({ type: 'SYNC_TO_REMOTE', update: Y.encodeStateAsUpdate(this.localDoc) });

				// Clear fork and conflict state
				this._fork = null;
				this._ingestionTexts = [];
				this.conflictData = null;
				this.pendingDiskContents = null;
				this.pendingEditorContent = null;
			},
			storeConflictData: (_hsm, event) => {
				const e = event as any;
				const conflictRegions = e.conflictRegions ?? [];
				const positionedConflicts = this.calculateConflictPositions(
					conflictRegions,
					e.ours,
				);
				this.conflictData = {
					base: e.base,
					ours: e.ours,
					theirs: e.theirs,
					oursLabel: e.oursLabel ?? "Editor",
					theirsLabel: e.theirsLabel ?? "Disk",
					conflictRegions,
					resolvedIndices: new Set(),
					positionedConflicts,
				};
				if (positionedConflicts.length > 0) {
					this.emitEffect({
						type: "SHOW_CONFLICT_DECORATIONS",
						conflictRegions,
						positions: positionedConflicts,
					});
				}
			},
			handleMergeSuccessAction: () => {
				// No-op: per spec, LCA is never touched during active.* states.
				// Transition to tracking is handled by the machine definition.
			},
			storeDeferredConflict: () => {
				this._deferredConflict = {
					diskHash: this._disk?.hash ?? "",
					localHash: "",
				};
				this.emitPersistState();
				// Async local hash computation (fire-and-forget)
				this.computeLocalHash()
					.then((localHash) => {
						if (this._deferredConflict) {
							this._deferredConflict.localHash = localHash;
							this.emitPersistState();
						}
					})
					.catch((err) => {
						this.send({
							type: "ERROR",
							error: err instanceof Error ? err : new Error(String(err)),
						});
					});
			},
			resolveHunk: (_hsm, event) => {
				this.handleResolveHunk(event as ResolveHunkEvent);
			},
			beginReleaseLock: () => {
				this._editorViewRef = null;
				this._cleanupWasConflict = this._statePath.includes("conflict");
				this._cleanupType = 'release';
				this._syncGate.providerSynced = false;
				if (this._fork) {
					this.emitEffect({ type: "REQUEST_PROVIDER_SYNC", guid: this._guid });
				}
			},

			// === Active entering/tracking actions ===
			accumulateRemoteUpdate: (_hsm, event) => {
				const update = (event as any).update as Uint8Array;
				const existingIdx = this._accumulatedEvents.findIndex(
					(e) => e.type === "REMOTE_UPDATE",
				);
				if (existingIdx >= 0) {
					const existing = this._accumulatedEvents[existingIdx] as {
						type: "REMOTE_UPDATE";
						update: Uint8Array;
					};
					this._accumulatedEvents[existingIdx] = {
						type: "REMOTE_UPDATE",
						update: Y.mergeUpdates([existing.update, update]),
					};
				} else {
					this._accumulatedEvents.push({ type: "REMOTE_UPDATE", update });
				}
			},
			accumulateCM6Change: (_hsm, event) => {
				const e = event as any;
				if (e.docText !== undefined) {
					this.lastKnownEditorText = e.docText;
				}
				this._accumulatedEvents.push({
					type: "CM6_CHANGE",
					changes: e.changes,
					docText: e.docText,
					isFromYjs: false,
				});
			},
			accumulateDiskChanged: (_hsm, event) => {
				const e = event as any;
				this._accumulatedEvents = this._accumulatedEvents.filter(
					(ev) => ev.type !== "DISK_CHANGED",
				);
				this._accumulatedEvents.push({
					type: "DISK_CHANGED",
					contents: e.contents,
					mtime: e.mtime,
					hash: e.hash,
				});
			},
			createYDocs: () => this.createYDocs(),
			applyRemoteToLocalIfNeeded: () => this.applyRemoteToLocalIfNeeded(),
			clearEnteringState: () => {
				this._enteringFromDiverged = false;
				this.pendingEditorContent = null;
			},
			mergeRemoteToLocal: () => this.mergeRemoteToLocal(),
			replayAccumulatedEvents: () => this.replayAccumulatedEvents(),
			startTwoWayMerge: () => {
				const localText = this.localDoc?.getText("contents").toString() ?? "";
				const diskText = this.lastKnownEditorText ?? this.pendingEditorContent ?? "";
				this.performTwoWayMerge(localText, diskText);
			},
			startThreeWayMerge: () => this.performThreeWayMergeFromState(),
			applyCM6ToLocalDoc: (_hsm, event) => {
				const e = event as any;
				this.lastKnownEditorText = e.docText;
				if (this.localDoc) {
					const ytext = this.localDoc.getText("contents");
					this.localDoc.transact(() => {
						for (const change of e.changes) {
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
			},
			updateDiskFromSave: (_hsm, event) => {
				const e = event as any;
				this._disk = { mtime: e.mtime, hash: e.hash };
			},
			storeDiskMetadataOnly: (_hsm, event) => {
				// In active.tracking, only update disk metadata (no state changes)
				const e = event as any;
				this._disk = { hash: e.hash, mtime: e.mtime };
				this.pendingDiskContents = e.contents;

				// Advance LCA when Obsidian's auto-save has flushed (dirty === false).
				// At this point disk and localDoc agree — a safe LCA snapshot.
				const dirty = this._editorViewRef?.dirty;
				if (this._editorViewRef && !dirty && this.localDoc) {
					const stateVector = Y.encodeStateVector(this.localDoc);
					this._lca = {
						contents: e.contents,
						meta: { hash: e.hash, mtime: e.mtime },
						stateVector,
					};
					this.emitPersistState();
				}
			},
			flushPendingToRemote: () => {
				this._isOnline = true;
				this._syncGate.providerConnected = true;
				if (this.localDoc) {
					this.syncLocalToRemote();
				}
			},
			setOffline: () => {
				this._isOnline = false;
				this._syncGate.providerConnected = false;
				this._syncGate.providerSynced = false;
			},
			markProviderSynced: () => {
				this._syncGate.providerSynced = true;
			},
			clearForkAndUpdateLCA: (_hsm, event) => {
				this._fork = null;
				this._ingestionTexts = [];
				this.pendingIdleUpdates = null;
				const result = (event as any).data;
				if (result?.newLCA) {
					this._lca = result.newLCA;
					this._localStateVector = result.newLCA.stateVector;
					this._remoteStateVector = result.newLCA.stateVector;
				}
				// Flush pending inbound: apply accumulated remote updates
				if (this._syncGate.pendingInbound > 0 && this.localDoc && this.remoteDoc) {
					const update = Y.encodeStateAsUpdate(
						this.remoteDoc,
						Y.encodeStateVector(this.localDoc),
					);
					if (update.length > 0) {
						Y.applyUpdate(this.localDoc, update, this.remoteDoc);
					}
				}
				// Flush pending outbound: sync accumulated local changes to remote
				if (this._syncGate.pendingOutbound > 0 && this.localDoc && this.remoteDoc) {
					const update = Y.encodeStateAsUpdate(
						this.localDoc,
						Y.encodeStateVector(this.remoteDoc),
					);
					if (update.length > 0) {
						Y.applyUpdate(this.remoteDoc, update, this);
						this.emitEffect({ type: "SYNC_TO_REMOTE", update });
					}
				}
				this._syncGate.pendingInbound = 0;
				this._syncGate.pendingOutbound = 0;
				this.emitPersistState();
			},
			clearForkKeepDiverged: () => {
				// Restore pendingDiskContents from localDoc (which has the disk-ingested
				// content). Without this, invokeIdleThreeWayAutoMerge falls back to LCA
				// for the disk side and sees no disk changes, causing it to auto-accept
				// and escape to idle.synced instead of staying diverged.
				this.pendingDiskContents = this.localDoc?.getText("contents").toString() ?? null;
				// Keep the fork alive — it gates syncLocalToRemote and holds the
				// captureMark needed to reverse disk ops during conflict resolution.
				// Clear pending remote updates — fork reconciliation already
				// evaluated them via diff3 and found a conflict. Without this,
				// idle.diverged's idle-merge invoke runs invokeIdleRemoteAutoMerge
				// with the same updates, applying a raw CRDT merge that
				// interleaves conflicting edits instead of surfacing a conflict.
				this.pendingIdleUpdates = null;
				this.emitPersistState();
			},
			ingestDiskToLocalDoc: () => {
				if (this.pendingDiskContents !== null) {
					this.applyContentToLocalDoc(this.pendingDiskContents, DISK_ORIGIN);
					this._ingestionTexts.push(this.pendingDiskContents);
				}
			},
			reconcileForkInActive: () => {
				// Reconcile fork when PROVIDER_SYNCED arrives in active mode
				if (!this._fork || !this.localDoc || !this.remoteDoc) {
					return;
				}

				const fork = this._fork;
				const localContent = this.localDoc.getText("contents").toString();

				// Check if remote has changed since fork using remoteDoc's actual
				// state vector (not the cached _remoteStateVector, which may be
				// stale if updates arrived via provider sync rather than REMOTE_UPDATE).
				const remoteChanged = stateVectorIsAhead(
					Y.encodeStateVector(this.remoteDoc),
					fork.remoteStateVector,
				);

				if (!remoteChanged) {
					// Remote unchanged — disk edit is confirmed safe, drop captured ops
					const opCapture = this.getOpCapture();
					if (opCapture && fork.captureMark != null) {
						const diskOps = opCapture.sinceByOrigin(fork.captureMark, DISK_ORIGIN);
						opCapture.drop(diskOps);
					}

					const stateVector = Y.encodeStateVector(this.localDoc);
					const diffUpdate = Y.encodeStateAsUpdate(this.localDoc, fork.localStateVector);
					if (diffUpdate.length > 0) {
						Y.applyUpdate(this.remoteDoc, diffUpdate, this);
						this.emitEffect({ type: "SYNC_TO_REMOTE", update: diffUpdate });
					}

					// Clear fork and update LCA
					this._fork = null;
					this._ingestionTexts = [];
					this._lca = {
						contents: localContent,
						meta: { hash: "", mtime: this.timeProvider.now() },
						stateVector,
					};
					this._localStateVector = stateVector;
					this._remoteStateVector = stateVector;
					this._syncGate.pendingInbound = 0;
					this._syncGate.pendingOutbound = 0;
					this.emitPersistState();
					this.patchLCAHash(localContent, stateVector);
					return;
				}

				// Remote changed — need three-way merge
				const remoteContent = this.remoteDoc.getText("contents").toString();
				const mergeResult = performThreeWayMerge(fork.base, localContent, remoteContent);

				if (mergeResult.success) {
					// Reverse redundant / drop unique disk ops before applying merged result
					const opCapture = this.getOpCapture();
					if (opCapture && fork.captureMark != null) {
						const diskOps = opCapture.sinceByOrigin(fork.captureMark, DISK_ORIGIN);
						const redundant: CapturedOp[] = [];
						const unique: CapturedOp[] = [];
						diskOps.forEach((op, i) => {
							const beforeText = i === 0 ? fork.base : this._ingestionTexts[i - 1];
							const afterText = this._ingestionTexts[i];
							if (afterText != null && isRedundantWithRemote(beforeText, afterText, remoteContent)) {
								redundant.push(op);
							} else {
								unique.push(op);
							}
						});
						opCapture.reverse(redundant);
						opCapture.drop(unique);
					}

					// Apply merged result to localDoc
					const beforeMerge = localContent;
					this.applyContentToLocalDoc(mergeResult.merged);

					// Dispatch granular changes to editor if content changed
					if (mergeResult.merged !== beforeMerge) {
						const changes = this.computeDiffChanges(beforeMerge, mergeResult.merged);
						if (changes.length > 0) {
							this.emitEffect({ type: "DISPATCH_CM6", changes });
						}
					}

					// Clear fork and update LCA
					const stateVector = Y.encodeStateVector(this.localDoc);
					this._fork = null;
					this._ingestionTexts = [];
					this._lca = {
						contents: mergeResult.merged,
						meta: { hash: "", mtime: this.timeProvider.now() },
						stateVector,
					};
					this._localStateVector = stateVector;
					this._remoteStateVector = stateVector;
					this._syncGate.pendingInbound = 0;
					this._syncGate.pendingOutbound = 0;
					this.emitPersistState();
					this.patchLCAHash(mergeResult.merged, stateVector);

					// Sync merged result to remote
					const update = Y.encodeStateAsUpdate(this.localDoc);
					if (update.length > 0) {
						this.emitEffect({ type: "SYNC_TO_REMOTE", update });
					}
				} else {
					// Conflict detected — clear fork tracking and surface it to the user.
					// pendingInbound/Outbound are reset because the fork gate is lifting;
					// conflict resolution will re-sync both sides via resolveWith* actions.
					this._fork = null;
					this._ingestionTexts = [];
					this._syncGate.pendingInbound = 0;
					this._syncGate.pendingOutbound = 0;

					// Drop captured disk ops — conflict resolution supersedes them.
					const opCapture = this.getOpCapture();
					if (opCapture && fork.captureMark != null) {
						const diskOps = opCapture.sinceByOrigin(fork.captureMark, DISK_ORIGIN);
						opCapture.drop(diskOps);
					}

					this.send({
						type: "MERGE_CONFLICT",
						base: fork.base,
						ours: localContent,
						theirs: remoteContent,
						conflictRegions: mergeResult.conflictRegions,
					});
				}
			},

			// === Obsidian file lifecycle tracking ===
			setObsidianFileOpen: () => {
				this._obsidianFileOpen = true;
			},
			setObsidianFileClosed: () => {
				this._obsidianFileOpen = false;
			},
		};
	}

	private buildInvokeSources(): Record<string, InvokeSourceFn> {
		return {
			'idle-merge': async (_hsm, signal) => {
				// Entry action ensureLocalDocForIdle creates localDoc +
				// persistence. Await persistence sync before merging
				// (e.g. after waking from hibernation).
				if (this.localPersistence && !this.localPersistence.synced) {
					await this.localPersistence.whenSynced;
					if (signal.aborted) return { success: false };
				}

				// Dispatch to the right merge based on which idle state spawned the invoke.
				// The interpreter spawns invokes on state entry, so _statePath is
				// the state that declared the invoke.
				switch (this._statePath) {
					case 'idle.remoteAhead':
						return this.invokeIdleRemoteAutoMerge(signal);
					case 'idle.diskAhead':
						return this.invokeIdleDiskAutoMerge(signal);
					case 'idle.diverged':
						return this.invokeIdleThreeWayAutoMerge(signal);
					default:
						return Promise.resolve({ success: false });
				}
			},
			'fork-reconcile': async (_hsm, signal) => {
				if (this.localPersistence && !this.localPersistence.synced) {
					await this.localPersistence.whenSynced;
					if (signal.aborted) return { success: false };
				}
				return this.invokeForkReconcile(signal);
			},
			'cleanup': async (_hsm, _signal) => {
				const cleanupType = this._cleanupType;
				this._cleanupType = null;

				if (cleanupType === 'release') {
					const wasConflict = this._cleanupWasConflict;
					this._cleanupWasConflict = false;
					try {
						await this.deactivateEditor();
					} catch (err) {
						console.error("[MergeHSM] Error during release lock cleanup:", err);
					}
					return { type: 'release', wasConflict };
				} else {
					try {
						await this.destroyLocalDoc();
					} catch (err) {
						console.error("[MergeHSM] Error during unload cleanup:", err);
					}
					return { type: 'unload' };
				}
			},
		};
	}

	// ===========================================================================
	// Invoke Source Implementations (async operations)
	// ===========================================================================

	private async invokeIdleRemoteAutoMerge(signal: AbortSignal): Promise<unknown> {
		if (!this.pendingIdleUpdates || !this.localDoc) {
			return { success: false };
		}

		// Block automatic writes when there is no LCA, UNLESS there is no file on
		// disk. No LCA + no disk file = initial sync from a remote peer (safe to
		// write). No LCA + disk file exists = up-migration where we must not
		// silently overwrite what the user has on disk.
		if (!this._lca && this._disk !== null) {
			return { success: false };
		}

		// Fast path: no actual updates to merge (state vectors advanced but no pending data)
		if (!this.pendingIdleUpdates) {
			if (this._lca && this._remoteStateVector) {
				this._lca.stateVector = this._remoteStateVector;
				this._localStateVector = this._remoteStateVector;
				this.emitPersistState();
			}
			return { success: true, newLCA: this._lca };
		}

		const localContent = this.localDoc.getText("contents").toString();

		// Check if local and remote have identical CONTENT before merging.
		// Different state vectors with identical content means the same text was inserted
		// by different clients. Merging would duplicate content.
		const remoteDoc = new Y.Doc();
		try {
			Y.applyUpdate(remoteDoc, this.pendingIdleUpdates, this);
			const remoteContent = remoteDoc.getText("contents").toString();
			if (localContent === remoteContent) {
				this.pendingIdleUpdates = null;
				return { success: true, newLCA: this._lca };
			}
		} finally {
			remoteDoc.destroy();
		}

		// Apply pending updates to the live localDoc.
		// Persistence's _storeUpdate handler writes to IDB automatically.
		const beforeSV = Y.encodeStateVector(this.localDoc);
		Y.applyUpdate(this.localDoc, this.pendingIdleUpdates, this.remoteDoc);

		const mergedContent = this.localDoc.getText("contents").toString();
		const stateVector = Y.encodeStateVector(this.localDoc);

		// Check if merge actually added anything
		if (stateVectorsEqual(beforeSV, stateVector)) {
			this.pendingIdleUpdates = null;
			return { success: true, newLCA: this._lca };
		}

		this.pendingIdleUpdates = null;

		const hash = await this.hashFn(mergedContent);
		if (signal.aborted) return { success: false };

		this.emitEffect({
			type: "WRITE_DISK",
			guid: this._guid,
			contents: mergedContent,
		});

		return {
			success: true,
			newLCA: { contents: mergedContent, meta: { hash, mtime: this.timeProvider.now() }, stateVector },
		};
	}

	private async invokeIdleDiskAutoMerge(signal: AbortSignal): Promise<unknown> {
		if (this.pendingDiskContents == null || !this._lca || !this.localDoc) {
			return { success: false };
		}

		const diskContent = this.pendingDiskContents;

		// Snapshot fork BEFORE ingesting disk edit.
		// The fork captures localDoc's state so that when the provider reconnects
		// and syncs, we can perform three-way reconciliation (fork.base vs localDoc vs remoteDoc).
		const fork: Fork = {
			base: this.localDoc.getText("contents").toString(),
			localStateVector: Y.encodeStateVector(this.localDoc),
			remoteStateVector: this._remoteStateVector ?? new Uint8Array([0]),
			origin: 'disk-edit',
			created: this.timeProvider.now(),
			captureMark: this.getOpCapture()?.mark() ?? 0,
		};

		// Capture state vector BEFORE modifying (for diff encoding)
		const previousStateVector = Y.encodeStateVector(this.localDoc);

		// Apply disk content using diff-based updates directly to the live localDoc.
		const ytext = this.localDoc.getText("contents");
		const currentContent = ytext.toString();
		if (currentContent !== diskContent) {
			const dmp = new diff_match_patch();
			const diffs = dmp.diff_main(currentContent, diskContent);
			dmp.diff_cleanupSemantic(diffs);
			this.localDoc.transact(() => {
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
			}, DISK_ORIGIN);
		}

		this._fork = fork;
		this._ingestionTexts.push(diskContent);
		this._syncGate.providerSynced = false;
		this.pendingDiskContents = null;
		this.emitPersistState();

		// Request provider sync for fork reconciliation
		this.emitEffect({ type: "REQUEST_PROVIDER_SYNC", guid: this._guid });

		// Return forked: true to signal the machine to transition to idle.localAhead
		return { success: false, forked: true };
	}

	private async invokeIdleThreeWayAutoMerge(signal: AbortSignal): Promise<unknown> {
		// If fork-reconcile already detected a conflict, don't re-attempt the
		// merge — the conflict data is authoritative and must be surfaced to
		// the user when they open the file.
		if (this.conflictData) return { success: false };
		if (!this._lca || !this.localDoc) return { success: false };

		const lcaContent = this._lca.contents;

		// Read the remote content from remoteDoc. Applying pendingIdleUpdates
		// to localDoc via raw Y.applyUpdate causes CRDT-level interleaving that
		// corrupts text when there's a true conflict (e.g. post-fork diverge).
		// remoteDoc already has all remote updates applied (applyRemoteToRemoteDoc
		// runs before storePendingRemoteUpdate), so reading its text gives the
		// correct remote content without the corruption path.
		// If remoteDoc isn't available yet (e.g. waking from hibernation), bail
		// out — REMOTE_UPDATE will reenter idle.diverged once the provider syncs.
		if (!this.remoteDoc) return { success: false };
		const crdtContent = this.remoteDoc.getText("contents").toString();

		const diskContent = this.pendingDiskContents ?? lcaContent;

		// 3-way merge: lca (base), disk (local changes), crdt (remote changes)
		const mergeResult = performThreeWayMerge(lcaContent, diskContent, crdtContent);

		if (mergeResult.success) {
			// Apply merged result to localDoc using diff-based updates
			this.applyContentToLocalDoc(mergeResult.merged);

			const stateVector = Y.encodeStateVector(this.localDoc);
			const update = Y.encodeStateAsUpdate(this.localDoc);

			this.pendingIdleUpdates = null;
			this.pendingDiskContents = null;

			const hash = await this.hashFn(mergeResult.merged);
			if (signal.aborted) return { success: false };

			this.emitEffect({
				type: "WRITE_DISK",
				guid: this._guid,
				contents: mergeResult.merged,
			});
			this.emitEffect({ type: "SYNC_TO_REMOTE", update });

			return {
				success: true,
				newLCA: { contents: mergeResult.merged, meta: { hash, mtime: this.timeProvider.now() }, stateVector },
			};
		}

		// Merge conflict — stay in idle.diverged
		return { success: false };
	}

	/**
	 * Fork reconciliation: three-way merge using fork.base as the common ancestor.
	 *
	 * Called when entering idle.localAhead after a fork was created.
	 * If provider is not synced, returns immediately with awaitingProvider so the
	 * invoke completes; PROVIDER_SYNCED reenters idle.localAhead which restarts it.
	 *
	 * When provider is synced, runs diff3(localDoc, fork.base, remoteDoc):
	 * - Success: write disk, sync to remote, clear fork, update LCA → idle.synced
	 * - Conflict: → idle.diverged
	 */
	private async invokeForkReconcile(signal: AbortSignal): Promise<unknown> {
		if (!this._fork) {
			return { success: true, newLCA: this._lca };
		}

		if (!this._isProviderSynced()) {
			// Provider not synced yet — stay in idle.localAhead and wait.
			// PROVIDER_SYNCED will reenter idle.localAhead, restarting this invoke.
			return { success: false, awaitingProvider: true };
		}

		if (!this.localDoc || !this.remoteDoc) {
			return { success: false };
		}

		const fork = this._fork;
		const localContent = this.localDoc.getText("contents").toString();

		// Apply any pending remote updates before reading remoteDoc content
		if (this.pendingIdleUpdates) {
			Y.applyUpdate(this.remoteDoc, this.pendingIdleUpdates, this.remoteDoc);
			this.pendingIdleUpdates = null;
		}
		const remoteContent = this.remoteDoc.getText("contents").toString();

		const mergeResult = performThreeWayMerge(fork.base, localContent, remoteContent);

		if (mergeResult.success) {
			// Reverse redundant / drop unique disk ops before applying merged result
			const opCapture = this.getOpCapture();
			if (opCapture && fork.captureMark != null) {
				const diskOps = opCapture.sinceByOrigin(fork.captureMark, DISK_ORIGIN);
				const redundant: CapturedOp[] = [];
				const unique: CapturedOp[] = [];
				diskOps.forEach((op, i) => {
					const beforeText = i === 0 ? fork.base : this._ingestionTexts[i - 1];
					const afterText = this._ingestionTexts[i];
					if (afterText != null && isRedundantWithRemote(beforeText, afterText, remoteContent)) {
						redundant.push(op);
					} else {
						unique.push(op);
					}
				});
				opCapture.reverse(redundant);
				opCapture.drop(unique);
			}
			this._ingestionTexts = [];

			this.applyContentToLocalDoc(mergeResult.merged);

			const stateVector = Y.encodeStateVector(this.localDoc);
			const update = Y.encodeStateAsUpdate(this.localDoc);

			const hash = await this.hashFn(mergeResult.merged);
			if (signal.aborted) {
				return { success: false };
			}
			this.emitEffect({
				type: "WRITE_DISK",
				guid: this._guid,
				contents: mergeResult.merged,
			});
			this.emitEffect({ type: "SYNC_TO_REMOTE", update });

			return {
				success: true,
				newLCA: {
					contents: mergeResult.merged,
					meta: { hash, mtime: this.timeProvider.now() },
					stateVector,
				},
			};
		}

		// Merge conflict — can't auto-resolve.
		// Populate conflictData so the diff UI is available when the user opens
		// the file from idle.diverged. Without this, CRDT merge during provider
		// sync would make localDoc and disk identical, causing the active.entering
		// reconciliation to skip conflict detection (localText === diskText).
		this.conflictData = {
			base: fork.base,
			ours: localContent,
			theirs: remoteContent,
			oursLabel: "Local",
			theirsLabel: "Remote",
			conflictRegions: mergeResult.conflictRegions ?? [],
			resolvedIndices: new Set(),
			positionedConflicts: this.calculateConflictPositions(
				mergeResult.conflictRegions ?? [],
				localContent,
			),
		};
		return { success: false };
	}

	// ===========================================================================
	// Event Handler
	// ===========================================================================

	private handleEvent(event: MergeEvent): void {
		// Handle Obsidian file lifecycle events (diagnostic, all states)
		if (event.type === 'OBSIDIAN_FILE_OPENED') {
			this._obsidianFileOpen = true;
			return; // Diagnostic only, no state transition
		}
		if (event.type === 'OBSIDIAN_FILE_UNLOADED') {
			this._obsidianFileOpen = false;
			return; // Diagnostic only, no state transition
		}
		if (event.type === 'OBSIDIAN_SAVE_FRONTMATTER' || event.type === 'OBSIDIAN_METADATA_SYNC') {
			return; // Diagnostic only, no state transition
		}

		processEvent(this, event, MACHINE, this._interpreterConfig);
	}


	/**
	 * Create localDoc and localPersistence if they don't exist.
	 * Used when entering idle mode to keep docs alive for auto-merge.
	 */
	ensureLocalDocForIdle(): void {
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
				this._captureOpts,
			);

			// Do NOT apply initialPersistenceUpdates here. The persistence
			// loads from IDB during sync and provides the correct content.
			// Applying initialPersistenceUpdates separately can cause content
			// duplication when IDB and persistence updates have different
			// CRDT histories (e.g., conflict scenarios).
			this.initialPersistenceUpdates = null;

			// Wait for persistence sync (fire-and-forget for idle mode)
			if (!this.localPersistence.synced) {
				this.localPersistence.once("synced", () => {
					// Update state vector after persistence loads
					if (this.localDoc) {
						this._localStateVector = Y.encodeStateVector(this.localDoc);
						if (this._localDocClientID === null) {
							this._localDocClientID = this.localDoc.clientID;
						}
					}
				});
			} else {
				// Already synced - update state vector now
				if (this.localDoc) {
					this._localStateVector = Y.encodeStateVector(this.localDoc);
					if (this._localDocClientID === null) {
						this._localDocClientID = this.localDoc.clientID;
					}
				}
			}
		}
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

	/**
	 * Perform two-way merge when no LCA is available.
	 * Per spec: always shows diff UI for user resolution.
	 * Edits in differ write immediately to CRDT/disk.
	 */
	private performTwoWayMerge(localText: string, diskText: string): void {
		// Populate conflictData for the diff UI
		this.conflictData = {
			base: "", // No baseline available
			ours: localText,
			theirs: diskText,
			oursLabel: "Editor",
			theirsLabel: "Disk",
			conflictRegions: [], // No regions - entire content is in conflict
			resolvedIndices: new Set(),
			positionedConflicts: [],
		};

		// Two-way merge always shows diff UI - send MERGE_CONFLICT to transition
		this.send({
			type: "MERGE_CONFLICT",
			base: "",
			ours: localText,
			theirs: diskText,
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
				ours: localText,
				theirs: diskText,
				oursLabel: "Editor",
				theirsLabel: "Disk",
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
				ours: localText,
				theirs: diskText,
				conflictRegions: mergeResult.conflictRegions,
			});
		}
	}


	// ===========================================================================
	// YDoc Management
	// ===========================================================================

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
				this._captureOpts,
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
		// Guard: If we're no longer in awaitingPersistence (e.g., lock was released
		// or unload happened during async persistence load), ignore this callback.
		if (!this.matches("active.entering.awaitingPersistence")) {
			return;
		}

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
	 * When IDB was empty and the server has content, apply server CRDT to localDoc.
	 * This ensures localDoc has the latest remote state before reconciliation.
	 */
	private applyRemoteToLocalIfNeeded(): void {
		if (!this.localDoc || !this.remoteDoc) return;

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

	/**
	 * Asynchronously compute the hash for a just-established LCA and patch it in.
	 * Called after reconcileForkInActive sets an LCA with an empty hash placeholder.
	 * Checks that the LCA state vector still matches before patching, so stale
	 * results from superseded reconciliations are safely ignored.
	 */
	private patchLCAHash(content: string, stateVector: Uint8Array): void {
		this.hashFn(content).then((hash) => {
			if (
				this._lca &&
				this._lca.meta.hash === "" &&
				stateVectorsEqual(this._lca.stateVector, stateVector)
			) {
				this._lca = { ...this._lca, meta: { ...this._lca.meta, hash } };
				this.emitPersistState();
			}
		}).catch(() => {
			// Hash failure is non-fatal; deactivateEditor will compute a correct LCA on close.
		});
	}

	/**
	 * Editor-specific teardown (active → idle).
	 * Captures final state, updates LCA if disk matches, persists state,
	 * removes Y.Text observer. localDoc, localPersistence, and remoteDoc stay alive.
	 */
	private async deactivateEditor(): Promise<void> {
		// Capture final state for idle state determination and LCA update
		let finalContent: string | null = null;
		if (this.localDoc) {
			this._localStateVector = Y.encodeStateVector(this.localDoc);
			finalContent = this.localDoc.getText("contents").toString();
		}

		// Update LCA if disk matches final localDoc content.
		// This ensures that after a successful edit+save session, we transition to
		// idle.synced instead of idle.diverged, preventing content duplication on reopen.
		if (finalContent !== null && this._disk) {
			const contentHash = await this.hashFn(finalContent);
			const hashMatches = contentHash === this._disk.hash;
			// Fallback to content comparison if hash doesn't match
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
			}
		}

		// Always persist state on deactivation to cache the latest localStateVector.
		// This ensures idle mode sync status is accurate after reopening.
		if (finalContent !== null) {
			this.emitPersistState();
		}

		// Clean up Y.Text observer (editor-specific)
		if (this.localDoc && this.localTextObserver) {
			const ytext = this.localDoc.getText("contents");
			ytext.unobserve(this.localTextObserver);
			this.localTextObserver = null;
		}

		// localDoc, localPersistence, and remoteDoc stay alive for idle mode
	}

	/**
	 * Destroy localDoc and persistence (for unload and hibernation).
	 *
	 * Nulls out references synchronously so callers see localDoc === null
	 * immediately, then awaits pending IndexedDB writes on the captured
	 * references. This prevents races where wake() recreates localDoc
	 * while the async cleanup is still running.
	 *
	 * Caller handles remoteDoc separately.
	 */
	async destroyLocalDoc(): Promise<void> {
		// Capture current references before nulling — async cleanup
		// operates on these, not on this.localDoc / this.localPersistence
		// which may be replaced by ensureLocalDocForIdle() during the await.
		const doc = this.localDoc;
		const persistence = this.localPersistence;
		const observer = this.localTextObserver;

		// Null out immediately (synchronous) so the HSM is in a clean
		// state for any subsequent ensureLocalDocForIdle() call.
		this.localDoc = null;
		this.localPersistence = null;
		this.localTextObserver = null;

		// Clean up captured references
		if (doc && observer) {
			const ytext = doc.getText("contents");
			ytext.unobserve(observer);
		}

		if (persistence) {
			await persistence.destroy();
		}
		if (doc) {
			doc.destroy();
		}
	}


	// While you may be tempted to try to filter outbound sync based on
	// heuristics, that is always the wrong approach. The error is in the sender.
	private syncLocalToRemote(): void {
		if (!this.localDoc || !this.remoteDoc) return;

		// Don't sync local→remote while a fork is unreconciled
		if (this._fork !== null) {
			this._syncGate.pendingOutbound++;
			return;
		}

		const update = Y.encodeStateAsUpdate(
			this.localDoc,
			Y.encodeStateVector(this.remoteDoc),
		);

		if (update.length > 0) {
			Y.applyUpdate(this.remoteDoc, update, this);
			this.emitEffect({ type: "SYNC_TO_REMOTE", update });
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
		if (!this.localDoc || !this.remoteDoc) return;

		// Don't merge remote→local while a fork is unreconciled
		if (this._fork !== null) {
			this._syncGate.pendingInbound++;
			return;
		}

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

	/**
	 * Apply new content to localDoc using diff-based updates.
	 *
	 * INVARIANT: Never uses delete-all/insert-all pattern. Uses diff-match-patch
	 * to compute minimal edits that preserve CRDT operational history.
	 *
	 * @param origin - Transaction origin. Pass DISK_ORIGIN for disk ingestion
	 *   so OpCapture can track these operations. Defaults to `this`.
	 */
	private applyContentToLocalDoc(newContent: string, origin?: any): void {
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
		}, origin ?? this);

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
			oursContent: region.oursContent,
			theirsContent: region.theirsContent,
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
		this.conflictData.ours = currentContent;
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
				newContent = region.oursContent;
				break;
			case "remote":
				newContent = region.theirsContent;
				break;
			case "both":
				newContent = region.oursContent + "\n" + region.theirsContent;
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
		this.conflictData.ours = afterText;

		// Recalculate positions for remaining conflicts (they shift!)
		this.recalculateConflictPositions();

		// Sync to remote → collaborators see immediately
		this.syncLocalToRemote();

		// Check if all conflicts resolved
		if (
			this.conflictData.resolvedIndices.size ===
			this.conflictData.conflictRegions.length
		) {
			// All hunks resolved — localDoc already has the final content.
			const finalContent = this.localDoc.getText("contents").toString();
			this.send({ type: "RESOLVE", contents: finalContent });
		}
	}

	private async computeLocalHash(): Promise<string> {
		if (!this.localDoc) return "";
		const text = this.localDoc.getText("contents").toString();
		return this.hashFn(text);
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
		this._pendingEffects?.push(effect);
		this._effects.emit(effect);
	}

	setOnTransition(cb: ((info: { from: StatePath; to: StatePath; event: MergeEvent; effects: MergeEffect[] }) => void) | null): void {
		this._onTransition = cb ?? undefined;
	}

	private emitPersistState(): void {
		const persistedState: PersistedMergeState = {
			guid: this._guid,
			path: this.path,
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
			fork: this._fork,
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
	_captureOpts?: CaptureOpts | null,
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
// OpCapture: Redundancy Detection
// =============================================================================

/**
 * Returns true if all text changes the disk op made (beforeText → afterText)
 * are already present in remoteText. Uses newline-as-explicit-token comparison
 * (same tokenization as diff3) so adjacent-line changes are checked independently.
 */
function isRedundantWithRemote(
	beforeText: string,
	afterText: string,
	remoteText: string,
): boolean {
	const tok = (s: string) => s.split(/(\n)/);
	const beforeTok = tok(beforeText);
	const afterTok = tok(afterText);
	const remoteTok = tok(remoteText);
	const maxLen = Math.max(beforeTok.length, afterTok.length);
	for (let i = 0; i < maxLen; i++) {
		const b = beforeTok[i] ?? "";
		const a = afterTok[i] ?? "";
		const r = remoteTok[i] ?? "";
		if (a !== b && a !== r) return false;
	}
	return true;
}

// =============================================================================
// 3-Way Merge Implementation
// =============================================================================

function performThreeWayMerge(
	lca: string,
	local: string,
	remote: string,
): MergeResult {
	const tok = (s: string) => s.split(/(\n)/);
	const lcaTokens = tok(lca);
	const localTokens = tok(local);
	const remoteTokens = tok(remote);

	const result = diff3Merge(localTokens, lcaTokens, remoteTokens);

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
			ours: local,
			theirs: remote,
			conflictRegions: extractConflictRegions(result, lca),
		};
	}

	const mergedTokens: string[] = [];
	for (const region of result) {
		if ("ok" in region && region.ok) {
			mergedTokens.push(...region.ok);
		}
	}
	const merged = mergedTokens.join("");

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
	oursContent: string;
	theirsContent: string;
}> {
	const regions: Array<{
		baseStart: number;
		baseEnd: number;
		oursContent: string;
		theirsContent: string;
	}> = [];

	let lineOffset = 0;
	for (const region of result) {
		if ("conflict" in region && region.conflict) {
			const { a: localTokens, o: baseTokens, b: remoteTokens } = region.conflict;
			regions.push({
				baseStart: lineOffset,
				baseEnd: lineOffset + (baseTokens?.length ?? 0),
				oursContent: localTokens?.join("") ?? "",
				theirsContent: remoteTokens?.join("") ?? "",
			});
			lineOffset += baseTokens?.length ?? 0;
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
