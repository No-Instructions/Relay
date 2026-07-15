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
	| "evaluating" // reading disk and comparing disk / localDoc / LCA
	| "synced" // disk and localDoc agree (or nothing to act on); LCA current
	| "flushing" // localDoc ahead of a provably untouched disk; write in flight
	| "diverged" // disk changed with no safe convergence path; parked
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
	viewAttached: boolean;
	/** SERVER_AHEAD observed while the machine could not act on it. */
	serverAheadPending: boolean;
	/** An ENQUEUE_DOWNLOAD effect emitted and not yet settled. */
	downloadPending: boolean;
	/** A change arrived while evaluating/flushing; re-evaluate on settle. */
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
	| "empty-local" // localDoc has no content yet; nothing may be flushed
	| "in-sync" // disk matches localDoc
	| "local-ahead" // disk untouched since the LCA (or empty); localDoc ahead
	| "disk-ahead" // disk changed, localDoc still at the LCA (ingestion slot)
	| "diverged"; // disk changed and cannot be proven untouched

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
	| { type: "VIEW_ATTACHED" }
	| { type: "VIEW_DETACHED" }
	| { type: "VIEW_DATA_LOADED" }
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
	/** Master switch — loading and evaluating leave it unset. */
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
