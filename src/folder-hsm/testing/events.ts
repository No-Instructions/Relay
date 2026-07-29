/**
 * Event helpers for the folder membership engine: factory functions
 * returning plain event objects, shared between tests and the recorder.
 */

import type {
	AuthorizationScope,
	FileOrigin,
	FolderEvent,
	LocalFileKind,
	MapDeltaAdd,
	MapDeltaDelete,
	MapDeltaMove,
} from "../types";

export const load = (): FolderEvent => ({ type: "LOAD" });

export const persistenceLoaded = (): FolderEvent => ({
	type: "PERSISTENCE_LOADED",
});

export const providerSynced = (tier?: "blind" | "confirmed"): FolderEvent => ({
	type: "PROVIDER_SYNCED",
	...(tier !== undefined ? { tier } : {}),
});

export const connected = (): FolderEvent => ({ type: "CONNECTED" });

export const disconnected = (): FolderEvent => ({ type: "DISCONNECTED" });

export const syncDrained = (): FolderEvent => ({ type: "SYNC_DRAINED" });

export const authorizationChanged = (
	scope: AuthorizationScope,
): FolderEvent => ({ type: "AUTHORIZATION_CHANGED", scope });

export const mapDelta = (
	delta: Partial<{
		adds: MapDeltaAdd[];
		updates: MapDeltaAdd[];
		deletes: MapDeltaDelete[];
		moves: MapDeltaMove[];
	}> = {},
): FolderEvent => ({
	type: "MAP_DELTA",
	adds: delta.adds ?? [],
	updates: delta.updates ?? [],
	deletes: delta.deletes ?? [],
	moves: delta.moves ?? [],
});

export const fileDiscovered = (
	path: string,
	origin: FileOrigin = "bootstrap",
	kind?: LocalFileKind,
): FolderEvent => ({
	type: "FILE_DISCOVERED",
	path,
	origin,
	...(kind !== undefined ? { kind } : {}),
});

export const fileCreated = (
	path: string,
	kind?: LocalFileKind,
): FolderEvent => ({
	type: "FILE_CREATED",
	path,
	...(kind !== undefined ? { kind } : {}),
});

export const fileModified = (path: string): FolderEvent => ({
	type: "FILE_MODIFIED",
	path,
});

export const fileDeleted = (path: string): FolderEvent => ({
	type: "FILE_DELETED",
	path,
});

export const fileRenamed = (from: string, to: string): FolderEvent => ({
	type: "FILE_RENAMED",
	from,
	to,
});

export const workStarted = (
	kind: "upload" | "download",
	path: string,
	guid: string,
): FolderEvent => ({ type: "WORK_STARTED", kind, path, guid });

export const uploadComplete = (path: string, guid: string): FolderEvent => ({
	type: "UPLOAD_COMPLETE",
	path,
	guid,
});

export const uploadFailed = (path: string, guid?: string): FolderEvent => ({
	type: "UPLOAD_FAILED",
	path,
	...(guid !== undefined ? { guid } : {}),
});

export const downloadComplete = (path: string, guid: string): FolderEvent => ({
	type: "DOWNLOAD_COMPLETE",
	path,
	guid,
});

export const downloadFailed = (path: string, guid: string): FolderEvent => ({
	type: "DOWNLOAD_FAILED",
	path,
	guid,
});

export const trashComplete = (
	path: string,
	guid: string | null,
): FolderEvent => ({ type: "TRASH_COMPLETE", path, guid });

export const deleteHeld = (paths: string[]): FolderEvent => ({
	type: "DELETE_HELD",
	paths,
});

export const deleteReplicated = (paths: string[]): FolderEvent => ({
	type: "DELETE_REPLICATED",
	paths,
});

export const deleteRestored = (paths: string[]): FolderEvent => ({
	type: "DELETE_RESTORED",
	paths,
});

export const unparkRequested = (path: string): FolderEvent => ({
	type: "UNPARK_REQUESTED",
	path,
});

export const resolveConflict = (
	path: string,
	verdict: "keep-local" | "keep-remote",
): FolderEvent => ({ type: "RESOLVE_CONFLICT", path, verdict });

export const rebuildStarted = (): FolderEvent => ({ type: "REBUILD_STARTED" });

export const rebuildComplete = (): FolderEvent => ({
	type: "REBUILD_COMPLETE",
});
