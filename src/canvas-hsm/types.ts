/**
 * CanvasHSM Types
 *
 * Type definitions for the per-canvas content-convergence state machine.
 * Where MergeHSM reconciles three representations of one document's text
 * and FolderHSM reconciles two representations of the folder's membership,
 * CanvasHSM reconciles the canvas JSON on disk with the canvas localDoc,
 * anchored by a persisted LCA. Remote state converges through the
 * CanvasDocBridge (localDoc ↔ remoteDoc) in CRDT space; the machine only
 * ever reasons about disk, localDoc, and the LCA.
 *
 * The declarative machine shape (StateNode / TransitionCandidate /
 * EventHandler) mirrors merge-hsm/types.ts so the same interpreter can
 * drive all three machines.
 */

import type { CanvasData } from "../CanvasView";
import type { PersistedCanvasState } from "../merge-hsm/types";

// =============================================================================
// States
// =============================================================================

export type CanvasStatePath =
	| "loading" // persistence loading; events absorbed, no effects
	| "idle.loading" // reading disk and comparing disk / localDoc / LCA
	| "idle.synced" // disk and localDoc agree (or nothing to act on); LCA current
	| "idle.remoteAhead" // localDoc ahead of a provably untouched disk; write in flight
	| "idle.ingesting" // merge in flight: three-way with an LCA, additive union without
	| "idle.diverged" // disk changed with no safe convergence path; parked
	| "active"; // a view is attached; the view owns the disk file

// =============================================================================
// Context
// =============================================================================

/**
 * The last content on which disk and localDoc agreed. Base for deciding
 * whether a disk file is safe to overwrite, and — once snapshot ingestion
 * ships — the ancestor for per-id three-way merge.
 */
export interface CanvasLCA {
	/** Formatted canvas JSON (formatCanvasData output). */
	contents: string;
	hash: string;
	mtime: number;
}

export interface CanvasDiskMeta {
	hash: string;
	mtime: number;
}

export interface CanvasContext {
	persistenceLoaded: boolean;
	userLock: boolean;
	/** SERVER_AHEAD observed while the machine could not act on it. */
	serverAheadPending: boolean;
	/** An ENQUEUE_DOWNLOAD effect emitted and not yet settled. */
	downloadPending: boolean;
	/** A change arrived while idle.loading/idle.remoteAhead is in flight; re-evaluate on settle. */
	reevaluatePending: boolean;
	lca: CanvasLCA | null;
	/** Metadata of the disk file as last observed by evaluation or flush. */
	disk: CanvasDiskMeta | null;
	/** Bumped by every durable-context mutation; drives PERSIST_STATE. */
	revision: number;
}

// =============================================================================
// Evaluation (the `evaluate` invoke)
// =============================================================================

export type EvaluationVerdict =
	| "not-member" // path absent from folder membership; no disk authority
	| "awaiting-enrollment" // localDoc has no content yet; nothing may be flushed
	| "synced" // disk matches localDoc
	| "remote-ahead" // disk untouched since the LCA (or empty); localDoc ahead
	| "ingest" // disk changed; merge computed (three-way with an LCA, additive union without)
	| "diverged"; // the disk file cannot be read as a canvas; parked

export interface EvaluationResult {
	verdict: EvaluationVerdict;
	/** Formatted localDoc export at evaluation time (flush payload). */
	contents: string;
	/** Hash of `contents`. */
	hash: string;
	/** Disk metadata, null when no file exists. */
	disk: CanvasDiskMeta | null;
	/** The disk JSON failed to parse. */
	parseError: boolean;
	/**
	 * Merge result — three-way against the LCA, or the additive union by
	 * identity when no baseline exists; present only with the ingest
	 * verdict.
	 */
	merged?: {
		data: CanvasData;
		/** Formatted merge including the disk file's unknown top-level keys. */
		contents: string;
		hash: string;
		/**
		 * The localDoc export the merge was computed from. The host applies
		 * the merge only while the localDoc still exports exactly this —
		 * a bridge-applied peer update in the evaluate→apply window makes
		 * the merge stale, and applying it anyway would delete the
		 * concurrent content (and replicate the deletion).
		 */
		ours: CanvasData;
	};
}

// =============================================================================
// Events
// =============================================================================

export type CanvasEvent =
	| { type: "LOAD" }
	| { type: "PERSISTENCE_LOADED"; state: PersistedCanvasState | null }
	| {
			/**
			 * The localDoc changed. Host-debounced; origins that are pure
			 * replay (the localDoc's own persistence) are never reported.
			 */
			type: "LOCAL_DOC_CHANGED";
			origin: "bridge" | "ingest" | "view" | "unknown";
	  }
	| { type: "DISK_CHANGED" }
	| { type: "ACQUIRE_LOCK" }
	| { type: "RELEASE_LOCK" }
	| { type: "OBSIDIAN_SET_VIEW_DATA" }
	| { type: "SERVER_AHEAD" }
	| { type: "FLUSH_COMPLETE"; contents: string; hash: string; mtime: number }
	| { type: "FLUSH_FAILED"; error?: unknown }
	| { type: "DOWNLOAD_COMPLETE" }
	| { type: "DOWNLOAD_FAILED" }
	| { type: `done.invoke.${string}`; data: unknown }
	| { type: `error.invoke.${string}`; data: unknown };

// =============================================================================
// Effects (executed by the host)
// =============================================================================

export type CanvasEffect =
	| { type: "WRITE_DISK"; contents: string; hash: string }
	| {
			/**
			 * Apply the merged data into the localDoc, then write the
			 * formatted merge to disk, then report FLUSH_COMPLETE — one
			 * unit; a failure at any step reports FLUSH_FAILED. The apply
			 * must be atomic against the live doc: `ours` is the localDoc
			 * export the merge was computed from, and the host aborts
			 * (FLUSH_FAILED, then re-evaluation) when the doc has moved
			 * since — never a destructive apply from a stale snapshot.
			 */
			type: "INGEST_MERGE";
			data: CanvasData;
			contents: string;
			hash: string;
			ours: CanvasData;
	  }
	| { type: "RECONCILE_VIEW" }
	| { type: "ENQUEUE_DOWNLOAD" }
	| { type: "PERSIST_STATE"; state: PersistedCanvasState }
	| { type: "SURFACE_STATUS" };

// =============================================================================
// Configuration (host-injected callbacks, mirroring folder-hsm)
// =============================================================================

export interface CanvasHSMConfig {
	guid: string;
	/** Owning shared folder guid; stamped on every persisted record. */
	folderGuid: string;
	/** Current virtual path (canvases move; never cache it). */
	getPath: () => string;
	/** Whether the path currently holds folder membership. */
	isMember: () => boolean;
	/** Read the canvas file; null when it does not exist. */
	readDisk: () => Promise<{ contents: string; mtime: number } | null>;
	/** Export the localDoc's canvas data. */
	exportData: () => CanvasData;
	/** Format canvas data as the on-disk JSON representation. */
	formatData: (data: CanvasData) => string;
	/** Content hash (defaults to the vault-wide SHA-256 helper). */
	hashFn?: (contents: string) => Promise<string>;
	/**
	 * The localDoc's current head, persisted so the advertised-head sweep
	 * can classify this canvas while hibernated. Absent on hosts that do
	 * not track snapshots (tests).
	 */
	getLocalSnapshot?: () => Uint8Array | null;
	/** Clock for persistedAt stamps (injectable for tests). */
	now?: () => number;
	onEffect: (effect: CanvasEffect) => void;
	onTransition?: (
		from: CanvasStatePath,
		to: CanvasStatePath,
		eventType: string,
	) => void;
}

// =============================================================================
// Declarative machine shape (structurally mirrors merge-hsm/types.ts)
// =============================================================================

export type CanvasTransitionCandidate = {
	target: CanvasStatePath;
	guard?: string;
	actions?: string[];
	reenter?: boolean;
};

export type CanvasEventHandler =
	| CanvasStatePath
	| CanvasTransitionCandidate
	| CanvasTransitionCandidate[];

export type CanvasAlwaysCandidate = {
	target: CanvasStatePath;
	guard?: string;
	actions?: string[];
};

export type CanvasInvokeDef = {
	src: string;
	onDone: CanvasEventHandler;
	onError?: CanvasEventHandler;
};

/**
 * Effect capabilities per state. These encode the engine's structural
 * invariants in the machine definition itself; CanvasHSM refuses (throws)
 * to emit an effect from a state whose node does not grant the capability.
 */
export interface CanvasCapabilities {
	/** Master switch — loading and idle.loading leave it unset. */
	canEmitEffects?: boolean;
	canWriteDisk?: boolean;
	canReconcileView?: boolean;
	canDownload?: boolean;
	canSurfaceStatus?: boolean;
}

export type CanvasStateNode = {
	entry?: string[];
	exit?: string[];
	on?: Record<string, CanvasEventHandler>;
	always?: CanvasAlwaysCandidate[];
	invoke?: CanvasInvokeDef;
	capabilities?: CanvasCapabilities;
};

export type CanvasMachineDefinition = Partial<
	Record<CanvasStatePath, CanvasStateNode>
>;

export type CanvasGuardFn = (event: CanvasEvent) => boolean;
export type CanvasActionFn = (event: CanvasEvent) => void;
