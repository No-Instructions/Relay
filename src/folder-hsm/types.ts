/**
 * FolderHSM Types
 *
 * Type definitions for the per-shared-folder membership state machine.
 * Where MergeHSM reconciles three representations of one
 * document's content, FolderHSM reconciles two representations of the
 * folder's membership (the local file tree and the map) plus local
 * records.
 *
 * The declarative machine shape (StateNode / TransitionCandidate /
 * EventHandler) mirrors merge-hsm/types.ts so the same interpreter can
 * drive both machines.
 */

// =============================================================================
// States
// =============================================================================

export type FolderStatePath =
	| "loading" // persistence loading; observations absorbed, no effects
	| "syncing" // persistence loaded, awaiting first provider sync (hydration)
	| "reconciling" // bootstrap: the provenance ladder, exactly once per connect
	| "tracking" // steady state: map deltas and vault events applied incrementally
	| "rebuilding"; // wholesale doc replacement; exits into reconciling only

// =============================================================================
// Membership context
// =============================================================================

export type Disposition =
	| "synced"
	| "pendingUpload"
	| "parked"
	| "pendingDownload"
	| "pendingTrash"
	| "pendingMapDelete"
	| "pendingRename";

export interface MembershipEntry {
	/** Durable identity; null until a guid is minted for a pending upload. */
	guid: string | null;
	path: string;
	disposition: Disposition;
}

export type FileOrigin = "bootstrap" | "interactive";

export type LocalFileKind = "file" | "folder";

export interface FolderContext {
	persistenceLoaded: boolean;
	providerSynced: boolean;
	isOnline: boolean;
	/** Membership table keyed by guid (or a path sentinel pre-mint). */
	entries: Map<string, MembershipEntry>;
	/** Reverse index: path → entries key. */
	entryKeyByPath: Map<string, string>;
	/** Discovered local file tree with how each file became known. */
	localFiles: Map<string, { origin: FileOrigin; kind: LocalFileKind }>;
	/**
	 * Interactive deletes observed before hydration. The ladder honors them
	 * as recorded local intent (MAP_DELETE) instead of re-downloading.
	 */
	locallyDeleted: Set<string>;
	/** Parked paths with a human-readable reason. */
	parked: Map<string, string>;
	/** Bumped by every context mutation; drives PERSIST_STATE emission. */
	revision: number;
}

// =============================================================================
// Events
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
	| { type: "PROVIDER_SYNCED" }
	| { type: "CONNECTED" }
	| { type: "DISCONNECTED" }
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
	| { type: "UPLOAD_COMPLETE"; path: string; guid: string }
	| { type: "UPLOAD_FAILED"; path: string; guid?: string }
	| { type: "DOWNLOAD_COMPLETE"; path: string; guid: string }
	| { type: "DOWNLOAD_FAILED"; path: string; guid: string }
	| { type: "TRASH_COMPLETE"; path: string; guid: string | null }
	| { type: "REBUILD_STARTED" }
	| { type: "REBUILD_COMPLETE" };

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
	| { type: "PARK"; path: string; reason: string }
	| { type: "SURFACE_STATUS" }
	| { type: "PERSIST_STATE"; snapshot: FolderSyncSnapshot };

// =============================================================================
// Snapshot / projections
// =============================================================================

export interface FolderSyncSnapshot {
	statePath: FolderStatePath;
	hydrated: boolean;
	isOnline: boolean;
	entries: MembershipEntry[];
	parked: Array<{ path: string; reason: string }>;
}

// =============================================================================
// Configuration (host-injected callbacks, mirroring merge-hsm)
// =============================================================================

export interface FolderHSMConfig {
	folderGuid: string;
	/** Current committed map entries (path → Meta projection). */
	listMapEntries: () => MapEntrySummary[];
	/** Single-path map lookup; defaults to scanning listMapEntries(). */
	getMapEntry?: (path: string) => MapEntrySummary | undefined;
	/** Persisted pendingUpload lookup (guid minted at placeHold time). */
	getPendingUploadGuid: (path: string) => string | undefined;
	/**
	 * Durable local proof that a file synced before: HSM persisted state
	 * (documents), hash-store entries with guids (attachments), per-doc
	 * CRDT store metadata. Must be synchronous — the host assembles its
	 * cache before hydration completes.
	 */
	getLocalRecordGuid: (path: string) => string | undefined;
	/** Native tombstone query (wraps pathWasDeleted). */
	pathTombstoned: (path: string) => boolean;
	onEffect: (effect: FolderEffect) => void;
	onTransition?: (
		from: FolderStatePath,
		to: FolderStatePath,
		eventType: string,
	) => void;
}

// =============================================================================
// Declarative machine shape (structurally mirrors merge-hsm/types.ts)
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
 * Effect capabilities per state. These encode the engine's structural
 * invariants in the machine definition itself; FolderHSM refuses (throws)
 * to emit an effect from a state whose node does not grant the capability.
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

export type FolderGuardFn = (event: FolderEvent) => boolean;
export type FolderActionFn = (event: FolderEvent) => void;
