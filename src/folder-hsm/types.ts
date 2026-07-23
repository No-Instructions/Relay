/**
 * FolderHSM Types
 *
 * Type definitions for the per-shared-folder membership engine. Where
 * MergeHSM reconciles three representations of one document's content,
 * FolderHSM reconciles two representations of the folder's membership
 * (the local file tree and the map) plus device-local records.
 *
 * The engine is two declarative constants executed together:
 *
 * - the FOLDER machine (machine-definition.ts) — postures describing what
 *   the folder as a whole is doing, interpreted by the shared merge-hsm
 *   machine interpreter;
 * - the ENTRY machine (entry-machine.ts) — per-file states held as a
 *   keyed row table inside the folder machine's context, ticked
 *   synchronously from the folder machine's actions.
 *
 * The declarative machine shape (StateNode / TransitionCandidate /
 * EventHandler) mirrors merge-hsm/types.ts so the same interpreter can
 * drive the folder machine.
 */

// =============================================================================
// Folder states
// =============================================================================

export type FolderStatePath =
	| "loading" // persistence loading; observations absorbed, no effects
	| "syncing" // persistence loaded, awaiting hydration
	| "reconciling" // transient: classification visits every undecided row
	| "tracking" // steady state: deltas and file events drive rows incrementally
	| "rebuilding"; // wholesale doc replacement; exits into reconciling only

// =============================================================================
// Entry states (the per-file machine)
// =============================================================================

/**
 * Per-file state paths. The intent/execution split is expressed in the
 * dotted hierarchy so invariants and capability rules can scope to
 * prefixes (`upload.` covers both children).
 */
export type EntryStatePath =
	| "unclassified" // known but undecided; the explicit waiting state
	| "synced" // local file, map entry, and content evidence agree
	| "upload.held" // publication decided; hold minted; dispatch gated
	| "upload.inFlight" // host acknowledged the upload; adopt, never re-emit
	| "download.pending" // materialization decided; not yet acknowledged
	| "download.inFlight" // host acknowledged the download
	| "trashing" // recoverable destruction instructed
	| "renaming" // local rename instructed; awaiting the platform echo
	| "delete.pending" // local deletion decided outbound; carries observed identity
	| "delete.held" // the outbound deletion policy holds the burst (a fork)
	| "parked" // publication refused, reason recorded; surfaced
	| "conflicted"; // positive evidence disagrees on both sides; surfaced

/**
 * Transition targets: a state path, or the reserved row-lifecycle
 * instruction `retired` — not a state but "remove this row and retire
 * its local record".
 */
export type EntryTarget = EntryStatePath | "retired";

// =============================================================================
// Membership context
// =============================================================================

/** Session confidence: the quality of the folder picture decisions run under. */
export type ConfidenceTier = "none" | "blind" | "confirmed";

export type AuthorizationScope = "write" | "read-only";

/**
 * Compatibility projection of an entry row for status surfaces and the
 * recovery sweep. `conflicted` is additive; all other members predate the
 * entry machine.
 */
export type Disposition =
	| "synced"
	| "pendingUpload"
	| "parked"
	| "pendingDownload"
	| "pendingTrash"
	| "pendingMapDelete"
	| "pendingRename"
	| "conflicted";

export interface MembershipEntry {
	/** Durable identity; null until a guid is minted for a pending upload. */
	guid: string | null;
	path: string;
	disposition: Disposition;
}

export type FileOrigin = "bootstrap" | "interactive";

export type LocalFileKind = "file" | "folder";

/** How the row's recorded content evidence relates to the file on disk. */
export type ContentAgreement = "unknown" | "agrees" | "stale";

/** One row of the keyed entry table: the machine's authority for one file. */
export interface EntryRow {
	/** guid when known, or a path sentinel pre-mint. */
	key: string;
	path: string;
	state: EntryStatePath;
	guid: string | null;
	origin: FileOrigin;
	kind: LocalFileKind;
	/** Confidence tier the current state was decided under. */
	decidedTier: ConfidenceTier;
	/** Whether the current intent's effect actually emitted (dispatch gate). */
	dispatched: boolean;
	/** Content evidence freshness; FILE_MODIFIED marks it stale. */
	contentAgreement: ContentAgreement;
	/** What outbound destructive intent targeted (deletes and renames). */
	observedIdentity?: { guid: string; path: string };
	/** parked / conflicted surfacing. */
	reason?: string;
}

export interface FolderContext {
	persistenceLoaded: boolean;
	/** Session confidence tier. */
	tier: ConfidenceTier;
	/** A sync claim is live this session (cleared by DISCONNECTED). */
	providerSynced: boolean;
	isOnline: boolean;
	authorization: AuthorizationScope;
	/** The keyed entry table: one row per file. */
	rows: Map<string, EntryRow>;
	/** Reverse index: path → rows key. */
	rowKeyByPath: Map<string, string>;
	/** Discovered local file tree with how each file became known. */
	localFiles: Map<string, { origin: FileOrigin; kind: LocalFileKind }>;
	/**
	 * Local deletes observed before hydration. Classification honors them
	 * as recorded local intent instead of re-downloading.
	 */
	recordedDeleteIntents: Set<string>;
	/**
	 * Classification was skipped because the folder doc held pending sync
	 * state (an undelivered deletion reads as a never-present path).
	 * Re-armed by SYNC_DRAINED.
	 */
	classificationDeferred: boolean;
	/** Bumped by every row/context mutation; drives PERSIST_STATE. */
	revision: number;
}

// =============================================================================
// Folder events (the host-facing union)
// =============================================================================

export interface MapEntrySummary {
	path: string;
	guid: string;
	type?: string;
}

export interface MapDeltaAdd {
	path: string;
	guid: string;
	type?: string;
}

export interface MapDeltaDelete {
	path: string;
	/** The removed Meta as observed live (before GC). */
	oldValue: { id: string; type?: string } | undefined;
}

export interface MapDeltaMove {
	guid: string;
	from: string;
	to: string;
}

export type FolderEvent =
	| { type: "LOAD" }
	| { type: "PERSISTENCE_LOADED" }
	/**
	 * The provider claims sync. `tier: "blind"` marks a claim derived from
	 * the persisted has-synced marker before any live exchange this
	 * session; an absent tier is a completed live exchange (confirmed).
	 */
	| { type: "PROVIDER_SYNCED"; tier?: "blind" | "confirmed" }
	| { type: "CONNECTED" }
	| { type: "DISCONNECTED" }
	/** The folder doc's pending sync state drained (host-observed). */
	| { type: "SYNC_DRAINED" }
	| { type: "AUTHORIZATION_CHANGED"; scope: AuthorizationScope }
	| {
			type: "MAP_DELTA";
			adds: MapDeltaAdd[];
			updates: MapDeltaAdd[];
			deletes: MapDeltaDelete[];
			/** Pre-paired by transaction (delete+add carrying one guid). */
			moves: MapDeltaMove[];
	}
	| {
			type: "FILE_DISCOVERED";
			path: string;
			origin: FileOrigin;
			kind?: LocalFileKind;
	}
	| { type: "FILE_CREATED"; path: string; kind?: LocalFileKind }
	| { type: "FILE_MODIFIED"; path: string }
	| { type: "FILE_DELETED"; path: string }
	| { type: "FILE_RENAMED"; from: string; to: string }
	/** The host durably accepted enqueued work (the acknowledgment). */
	| {
			type: "WORK_STARTED";
			kind: "upload" | "download";
			path: string;
			guid: string;
	}
	| { type: "UPLOAD_COMPLETE"; path: string; guid: string }
	| { type: "UPLOAD_FAILED"; path: string; guid?: string }
	| { type: "DOWNLOAD_COMPLETE"; path: string; guid: string }
	| { type: "DOWNLOAD_FAILED"; path: string; guid: string }
	| { type: "TRASH_COMPLETE"; path: string; guid: string | null }
	/** Outbound deletion policy outcomes, per burst. */
	| { type: "DELETE_HELD"; paths: string[] }
	| { type: "DELETE_REPLICATED"; paths: string[] }
	| { type: "DELETE_RESTORED"; paths: string[] }
	| { type: "UNPARK_REQUESTED"; path: string }
	| {
			type: "RESOLVE_CONFLICT";
			path: string;
			verdict: "keep-local" | "keep-remote";
	}
	| { type: "REBUILD_STARTED" }
	| { type: "REBUILD_COMPLETE" };

// =============================================================================
// Entry events (folder events routed to rows)
// =============================================================================

export type EntryEvent =
	| { type: "CLASSIFY" }
	| { type: "MAP_ADDED"; path: string; guid: string; fileType?: string }
	| { type: "MAP_UPDATED"; path: string; guid: string; fileType?: string }
	| { type: "MAP_REMOVED"; path: string; guid?: string }
	| { type: "MAP_MOVED"; guid: string; from: string; to: string }
	| {
			type: "FILE_DISCOVERED";
			path: string;
			origin: FileOrigin;
			kind?: LocalFileKind;
	}
	| { type: "FILE_CREATED"; path: string; kind?: LocalFileKind }
	| { type: "FILE_MODIFIED"; path: string }
	| { type: "FILE_DELETED"; path: string }
	| { type: "FILE_RENAMED_AWAY"; from: string; to: string }
	| { type: "FILE_RENAMED_IN"; from: string; to: string }
	| {
			type: "WORK_STARTED";
			kind: "upload" | "download";
			path: string;
			guid: string;
	}
	| { type: "UPLOAD_COMPLETE"; path: string; guid: string }
	| { type: "UPLOAD_FAILED"; path: string; guid?: string }
	| { type: "DOWNLOAD_COMPLETE"; path: string; guid: string }
	| { type: "DOWNLOAD_FAILED"; path: string; guid: string }
	| { type: "TRASH_COMPLETE"; path: string; guid: string | null }
	| { type: "DELETE_HELD"; paths: string[] }
	| { type: "DELETE_REPLICATED"; paths: string[] }
	| { type: "DELETE_RESTORED"; paths: string[] }
	| { type: "UNPARK_REQUESTED"; path: string }
	| {
			type: "RESOLVE_CONFLICT";
			path: string;
			verdict: "keep-local" | "keep-remote";
	};

export type EntryEventType = EntryEvent["type"];

// =============================================================================
// Effects (executed by the host)
// =============================================================================

export type FolderEffect =
	| { type: "ENQUEUE_UPLOAD"; path: string; origin: FileOrigin }
	| { type: "ENQUEUE_DOWNLOAD"; path: string; guid: string }
	| { type: "TRASH_LOCAL"; path: string; guid: string | null }
	| { type: "RENAME_LOCAL"; from: string; to: string; guid: string }
	| { type: "MAP_SET"; path: string; oldPath?: string; guid?: string }
	| { type: "MAP_DELETE"; path: string; guid?: string }
	/**
	 * Withdraw queued upload work. `releaseHold` distinguishes the two
	 * sanctioned forms: true also releases the persisted hold (the local
	 * file is gone, or a committed identity superseded the mint); false
	 * cancels the queued work but PRESERVES the hold — a persisted hold
	 * marks content the server does not have, and that identity is never
	 * discarded without a completed publication or an explicit user
	 * action.
	 *
	 * `supersededBy` names the committed identity when one superseded the
	 * mint AND the row is adopting it directly (no download queued): the
	 * retraction is then also a rebind instruction — the host rebuilds
	 * the path's live document on the committed history, seeding the
	 * merge base from the bytes on disk, because a bare retraction would
	 * leave the path with no canonical document at all.
	 */
	| {
			type: "RETRACT_UPLOAD";
			path: string;
			guid: string | null;
			releaseHold: boolean;
			supersededBy?: string;
	}
	| { type: "PARK"; path: string; reason: string }
	| { type: "SURFACE_STATUS" }
	/**
	 * Revision-driven snapshot stream. The host's durable write is limited
	 * to the approved fork-class subset (held deletion fork + retained-doc
	 * ledger); the machine snapshot itself is observability only.
	 */
	| { type: "PERSIST_STATE"; snapshot: FolderSerializableSnapshot };

// =============================================================================
// Snapshot / projections
// =============================================================================

export interface FolderSyncSnapshot {
	statePath: FolderStatePath;
	hydrated: boolean;
	isOnline: boolean;
	tier: ConfidenceTier;
	entries: MembershipEntry[];
	parked: Array<{ path: string; reason: string }>;
	conflicted: Array<{ path: string; reason: string }>;
}

/** Serializable whole-machine snapshot (recording/replay, PERSIST_STATE). */
export interface FolderSerializableSnapshot {
	statePath: FolderStatePath;
	revision: number;
	context: {
		persistenceLoaded: boolean;
		tier: ConfidenceTier;
		providerSynced: boolean;
		isOnline: boolean;
		authorization: AuthorizationScope;
		classificationDeferred: boolean;
		localFiles: Array<{
			path: string;
			origin: FileOrigin;
			kind: LocalFileKind;
		}>;
		recordedDeleteIntents: string[];
	};
	rows: EntryRow[];
}

// =============================================================================
// Configuration (host-injected callbacks)
// =============================================================================

/**
 * Device-local records: durable proof that some file at a path once
 * synced under a guid, plus the content evidence that ties the recorded
 * identity to the bytes now on disk. All lookups must be synchronous —
 * the host assembles its caches before hydration completes. A record's
 * existence alone never authorizes destruction; only `recordMatchesDisk`
 * lets a record condemn the current file.
 */
export interface LocalRecordSource {
	getRecordGuid: (path: string) => string | undefined;
	/** Stored content evidence agrees with the file currently on disk. */
	recordMatchesDisk: (path: string) => boolean;
	/** Retire the record when its row retires — a record never outlives its file. */
	retireRecord: (path: string) => void;
	/** Follow a rename so the record keeps describing the same file. */
	moveRecord: (from: string, to: string) => void;
}

/**
 * Upload holds: the persisted record that a path's publication was
 * decided and a guid minted, so retries after restart reuse the same
 * identity. Identity-only by design; reads and writes go through the
 * host's existing hold persistence in its current format.
 */
export interface UploadHoldSource {
	getHold: (path: string) => string | undefined;
	moveHold: (from: string, to: string) => void;
}

export interface FolderHSMConfig {
	folderGuid: string;
	/** Current committed map entries (path → Meta projection). */
	listMapEntries: () => MapEntrySummary[];
	/** Single-path map lookup; defaults to scanning listMapEntries(). */
	getMapEntry?: (path: string) => MapEntrySummary | undefined;
	/** Native tombstone query (wraps pathWasDeleted). */
	pathTombstoned: (path: string) => boolean;
	records: LocalRecordSource;
	holds: UploadHoldSource;
	/**
	 * Live trust probe: the folder docs hold received-but-unappliable sync
	 * state, so the map understates deletions and no classification may
	 * read it. Must probe the live replica, never a persisted marker.
	 */
	hasPendingSyncState?: () => boolean;
	/** Whether a file type has content-merge machinery (documents). */
	mergeableKind?: (fileType?: string) => boolean;
	onEffect: (effect: FolderEffect) => void;
	onTransition?: (
		from: FolderStatePath,
		to: FolderStatePath,
		eventType: string,
	) => void;
	/**
	 * Invariant-violation sink. Emit-time capability violations always
	 * throw; refusals and state-check violations report here.
	 */
	onInvariantViolation?: (violation: FolderInvariantViolation) => void;
}

// =============================================================================
// Declarative machine shapes (folder machine)
// =============================================================================

export type FolderTransitionCandidate = {
	target: FolderStatePath;
	guard?: string;
	actions?: string[];
	reenter?: boolean;
};

export type FolderEventHandler =
	| FolderStatePath
	| FolderTransitionCandidate
	| FolderTransitionCandidate[];

export type FolderAlwaysCandidate = {
	target: FolderStatePath;
	guard?: string;
	actions?: string[];
};

/**
 * Effect capabilities per folder posture. These encode the engine's
 * structural invariants in the machine definition itself; the emit
 * chokepoint refuses (throws) any effect whose required capability the
 * current posture does not grant.
 */
export interface FolderCapabilities {
	/** Master switch — loading/syncing/rebuilding leave it unset. */
	canEmitEffects?: boolean;
	canTrash?: boolean;
	canUploadBootstrap?: boolean;
	canUploadInteractive?: boolean;
	canDownload?: boolean;
	canRenameLocal?: boolean;
	canMutateMap?: boolean;
	canPark?: boolean;
}

export type FolderCapabilityName = keyof FolderCapabilities;

export type FolderStateNode = {
	entry?: string[];
	exit?: string[];
	on?: Record<string, FolderEventHandler>;
	always?: FolderAlwaysCandidate[];
	capabilities?: FolderCapabilities;
};

export type FolderMachineDefinition = Partial<
	Record<FolderStatePath, FolderStateNode>
>;

// =============================================================================
// Entry-machine shape (the keyed entry table's grammar)
// =============================================================================

/**
 * Default policy for (state × event) cells with no declared handler. The
 * shared interpreter silently consumes unhandled events; for per-file
 * rows that is exactly where files get lost, so every node declares what
 * an unconsidered event does:
 *
 * - `absorb` — record the event as evidence, no state change, no effect;
 * - `refuse` — no state change, no effect, logged as an invariant report;
 * - `reclassify` — return the row to `unclassified` and schedule a
 *   classification visit.
 */
export type EntryOtherwise = "absorb" | "refuse" | "reclassify";

export type EntryCandidate = {
	target: EntryTarget;
	guard?: string;
	actions?: string[];
	/**
	 * Capabilities this candidate's effects require from the current
	 * FOLDER posture (the two-level check): the transition's effects may
	 * emit only while the folder grants them.
	 */
	requires?: FolderCapabilityName[];
};

/** The explicit refuse handler (distinct from an undeclared cell). */
export type EntryRefusal = { refuse: true };

export type EntryEventHandler =
	| EntryTarget
	| EntryCandidate
	| EntryCandidate[]
	| EntryRefusal;

export type EntryStateNode = {
	/** Entry actions run when the row enters this state. */
	entry?: string[];
	otherwise: EntryOtherwise;
	on: Partial<Record<EntryEventType, EntryEventHandler>>;
};

export type EntryMachineDefinition = Record<EntryStatePath, EntryStateNode>;

// =============================================================================
// Invariants
// =============================================================================

export type FolderInvariantSeverity = "warning" | "error" | "critical";

export type FolderInvariantTrigger =
	| "on-emit"
	| "on-state"
	| "on-refuse"
	| "on-transition"
	| "periodic";

export interface FolderInvariantViolation {
	id: string;
	severity: FolderInvariantSeverity;
	message: string;
	statePath: FolderStatePath;
	entryState?: EntryStatePath;
	path?: string;
}
