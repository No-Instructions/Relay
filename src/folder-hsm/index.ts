export { FolderHSM } from "./FolderHSM";
export { FOLDER_MACHINE } from "./machine-definition";
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
	deriveRecoveryDelta,
	isEmptyRecoveryDelta,
	type RecoveryDelta,
} from "./recovery";
export type {
	Disposition,
	FileOrigin,
	LocalFileKind,
	FolderEffect,
	FolderEvent,
	FolderHSMConfig,
	FolderStatePath,
	FolderSyncSnapshot,
	MapDeltaAdd,
	MapDeltaDelete,
	MapDeltaMove,
	MapEntrySummary,
	MembershipEntry,
} from "./types";
