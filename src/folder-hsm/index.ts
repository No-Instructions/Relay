export { FolderHSM } from "./FolderHSM";
export { FOLDER_MACHINE } from "./machine-definition";
export {
	ENTRY_MACHINE,
	ENTRY_EVENT_TYPES,
	ENTRY_STATE_PATHS,
} from "./entry-machine";
export { FOLDER_INVARIANTS } from "./invariants";
export { pathWasDeleted } from "./tombstones";
export { docsHavePendingSyncState, observeSyncDrain } from "./pending-sync";
export {
	FolderDocBridge,
	BRIDGE_IN_ORIGIN,
	BRIDGE_OUT_ORIGIN,
	FOLDER_LOCAL_DELETE_ORIGIN,
	type FolderMapName,
	type OutboundDelete,
} from "./bridge";
export {
	DeleteCollector,
	type DeletionGateSnapshot,
	type DeleteCollectorOptions,
	type DeletePolicyMode,
	type GateResolution,
	type HeldDelete,
	type SerializedCollectorState,
} from "./delete-collector";
export {
	FolderHSMStore,
	deleteFolderHSMDatabase,
	sanitizeFolderState,
	type FolderFork,
	type FolderForkDelete,
	type PersistedFolderState,
	type RemoteIndexCache,
	type RetainedDoc,
} from "./persistence/FolderHSMStore";
export {
	deriveRecoveryDelta,
	isEmptyRecoveryDelta,
	type RecoveryDelta,
} from "./recovery";
export type {
	AuthorizationScope,
	ConfidenceTier,
	Disposition,
	EntryEvent,
	EntryRow,
	EntryStatePath,
	FileOrigin,
	LocalFileKind,
	FolderEffect,
	FolderEvent,
	FolderHSMConfig,
	FolderInvariantViolation,
	FolderSerializableSnapshot,
	FolderStatePath,
	FolderSyncSnapshot,
	LocalRecordSource,
	MapDeltaAdd,
	MapDeltaDelete,
	MapDeltaMove,
	MapEntrySummary,
	MembershipEntry,
	UploadHoldSource,
} from "./types";
