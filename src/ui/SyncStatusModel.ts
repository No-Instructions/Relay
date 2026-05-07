import type { BackgroundSyncFailure, QueueItem } from "../BackgroundSync";
import type { SharedFolder } from "../SharedFolder";
import type { StatePath, SyncStatus, SyncStatusType } from "../merge-hsm/types";

export type FileSyncUiStatus = "synced" | "syncing" | "conflict" | "error";
export type ActionableCategory = "conflict" | "error";
export type QueueRunState = "idle" | "processing" | "stopped";
export type QueueWorkKind = "sync" | "download";
export type QueueWorkPhase = "queued" | "active";

export interface QueueWorkItem {
	guid: string;
	path: string;
	kind: QueueWorkKind;
	phase: QueueWorkPhase;
	userVisible: boolean;
}

export interface FolderQueueSnapshot {
	isPaused: boolean;
	syncsQueued: number;
	syncsActive: number;
	downloadsQueued: number;
	downloadsActive: number;
	queued: number;
	active: number;
	total: number;
	runState: QueueRunState;
	label: string;
	showSyncingCount: boolean;
	itemsByGuid: ReadonlyMap<string, QueueWorkItem>;
	itemsByPath: ReadonlyMap<string, QueueWorkItem>;
}

export interface DerivedFileSyncStatus {
	status: FileSyncUiStatus;
	category: ActionableCategory | null;
	label: string;
	actionable: boolean;
	queueItem: QueueWorkItem | null;
}

export interface ActionableSyncFile {
	id: string;
	guid: string;
	path: string;
	category: ActionableCategory;
	label: string;
	source: "hsm" | "backgroundSync";
}

export interface FolderSyncStatusModel {
	queue: FolderQueueSnapshot;
	actionableFiles: ActionableSyncFile[];
}

interface DeriveFileSyncStatusInput {
	statePath?: StatePath | string;
	syncStatus?: Pick<SyncStatus, "status"> | null;
	hasConflictData?: boolean;
	errorMessage?: string | null;
	queueItem?: QueueWorkItem | null;
}

const EMPTY_QUEUE_MAP = new Map<string, QueueWorkItem>();

export function buildFolderQueueSnapshot(
	sharedFolder: SharedFolder,
): FolderQueueSnapshot {
	const syncQueued = sharedFolder.backgroundSync.pendingSyncs.filter(
		(item) => item.sharedFolder === sharedFolder,
	);
	const downloadQueued = sharedFolder.backgroundSync.pendingDownloads.filter(
		(item) => item.sharedFolder === sharedFolder,
	);
	const syncActive = sharedFolder.backgroundSync.activeSync.filter(
		(item) => item.sharedFolder === sharedFolder,
	);
	const downloadActive = sharedFolder.backgroundSync.activeDownloads.filter(
		(item) => item.sharedFolder === sharedFolder,
	);
	const isPaused = sharedFolder.backgroundSync.getQueueStatus().isPaused;

	return summarizeFolderQueue({
		isPaused,
		syncQueued,
		syncActive,
		downloadQueued,
		downloadActive,
	});
}

export function summarizeFolderQueue(input: {
	isPaused: boolean;
	syncQueued?: readonly QueueItem[];
	syncActive?: readonly QueueItem[];
	downloadQueued?: readonly QueueItem[];
	downloadActive?: readonly QueueItem[];
}): FolderQueueSnapshot {
	const itemsByGuid = new Map<string, QueueWorkItem>();
	const itemsByPath = new Map<string, QueueWorkItem>();
	const syncQueued = input.syncQueued ?? [];
	const syncActive = input.syncActive ?? [];
	const downloadQueued = input.downloadQueued ?? [];
	const downloadActive = input.downloadActive ?? [];

	for (const item of syncQueued) {
		addQueueItem(itemsByGuid, itemsByPath, item, "sync", "queued");
	}
	for (const item of downloadQueued) {
		addQueueItem(itemsByGuid, itemsByPath, item, "download", "queued");
	}
	for (const item of syncActive) {
		addQueueItem(itemsByGuid, itemsByPath, item, "sync", "active");
	}
	for (const item of downloadActive) {
		addQueueItem(itemsByGuid, itemsByPath, item, "download", "active");
	}

	const syncsQueued = syncQueued.length;
	const syncsActive = syncActive.length;
	const downloadsQueued = downloadQueued.length;
	const downloadsActive = downloadActive.length;
	const queued = syncsQueued + downloadsQueued;
	const active = syncsActive + downloadsActive;
	const total = queued + active;
	const runState: QueueRunState = input.isPaused
		? "stopped"
		: active > 0 || queued > 0
			? "processing"
			: "idle";

	return {
		isPaused: input.isPaused,
		syncsQueued,
		syncsActive,
		downloadsQueued,
		downloadsActive,
		queued,
		active,
		total,
		runState,
		label: queueRunStateLabel(runState, active),
		showSyncingCount: runState === "processing",
		itemsByGuid,
		itemsByPath,
	};
}

export function buildFolderSyncStatusModel(
	sharedFolder: SharedFolder,
	dismissedErrors: ReadonlySet<string> = new Set(),
): FolderSyncStatusModel {
	const queue = buildFolderQueueSnapshot(sharedFolder);
	const actionableFiles: ActionableSyncFile[] = [];

	for (const [guid, file] of sharedFolder.files) {
		const doc = file as any;
		const hsm = doc.hsm;
		const statePath = hsm?.statePath as StatePath | undefined;
		const syncStatus = hsm?.getSyncStatus?.() as SyncStatus | undefined;
		const derived = deriveFileSyncStatus({
			statePath,
			syncStatus,
			hasConflictData:
				typeof hsm?.getConflictData === "function" && !!hsm.getConflictData(),
			errorMessage: getHsmErrorMessage(hsm),
			queueItem:
				queue.itemsByGuid.get(guid) ??
				queue.itemsByPath.get(sharedFolder.getPath(file.path)) ??
				null,
		});

		if (!derived.category) continue;
		if (derived.category === "error" && dismissedErrors.has(guid)) continue;
		actionableFiles.push({
			id: guid,
			guid,
			path: file.path,
			category: derived.category,
			label: derived.label,
			source: "hsm",
		});
	}

	for (const failure of getBackgroundSyncFailures(sharedFolder)) {
		if (dismissedErrors.has(failure.id)) continue;
		if (
			actionableFiles.some(
				(file) => file.guid === failure.guid || file.path === failure.path,
			)
		) {
			continue;
		}
		actionableFiles.push({
			id: failure.id,
			guid: failure.guid,
			path: failure.path,
			category: "error",
			label: failure.message,
			source: "backgroundSync",
		});
	}

	actionableFiles.sort((a, b) => a.path.localeCompare(b.path));
	return { queue, actionableFiles };
}

export function deriveFileSyncStatus(
	input: DeriveFileSyncStatusInput,
): DerivedFileSyncStatus {
	const statePath = input.statePath ?? "";
	const syncStatus = input.syncStatus?.status;
	const queueItem = input.queueItem ?? null;

	if (
		input.hasConflictData ||
		syncStatus === "conflict" ||
		statePath.includes("conflict")
	) {
		return {
			status: "conflict",
			category: "conflict",
			label:
				statePath === "active.conflict.resolving"
					? "Resolving"
					: "Open to resolve",
			actionable: true,
			queueItem,
		};
	}

	if (syncStatus === "error" || statePath === "idle.error" || input.errorMessage) {
		return {
			status: "error",
			category: "error",
			label: input.errorMessage?.trim() || "Unable to continue sync",
			actionable: true,
			queueItem,
		};
	}

	if (queueItem) {
		return {
			status: "syncing",
			category: null,
			label: queueItem.phase === "active" ? queueActiveLabel(queueItem.kind) : "Queued",
			actionable: false,
			queueItem,
		};
	}

	return {
		status: "synced",
		category: null,
		label: "Synced",
		actionable: false,
		queueItem: null,
	};
}

export function shouldShowRecentActivity(status: string, author: string): boolean {
	if (author === "you") return false;
	const uiStatus = normalizeActivityStatus(status);
	return uiStatus === "synced";
}

export function normalizeActivityStatus(status: string): FileSyncUiStatus {
	switch (status as SyncStatusType | string) {
		case "conflict":
			return "conflict";
		case "error":
			return "error";
		case "pending":
			return "syncing";
		case "synced":
		default:
			return "synced";
	}
}

function addQueueItem(
	itemsByGuid: Map<string, QueueWorkItem>,
	itemsByPath: Map<string, QueueWorkItem>,
	item: QueueItem,
	kind: QueueWorkKind,
	phase: QueueWorkPhase,
): void {
	const queueItem: QueueWorkItem = {
		guid: item.guid,
		path: item.path,
		kind,
		phase,
		userVisible: item.userVisible,
	};
	upsertQueueItem(itemsByGuid, item.guid, queueItem);
	upsertQueueItem(itemsByPath, item.path, queueItem);
}

function upsertQueueItem(
	map: Map<string, QueueWorkItem>,
	key: string,
	item: QueueWorkItem,
): void {
	const existing = map.get(key);
	if (!existing || queueItemRank(item) >= queueItemRank(existing)) {
		map.set(key, item);
	}
}

function queueItemRank(item: QueueWorkItem): number {
	return item.phase === "active" ? 2 : 1;
}

function queueRunStateLabel(runState: QueueRunState, active: number): string {
	if (runState === "stopped") return "Paused";
	if (runState === "processing") return active > 0 ? "Syncing" : "Queued";
	return "Synced";
}

function queueActiveLabel(kind: QueueWorkKind): string {
	return kind === "download" ? "Downloading" : "Syncing";
}

function getHsmErrorMessage(hsm: any): string | null {
	const error = hsm?.state?.error;
	if (!error) return null;
	return error instanceof Error ? error.message : String(error);
}

function getBackgroundSyncFailures(
	sharedFolder: SharedFolder,
): BackgroundSyncFailure[] {
	const getFailures = sharedFolder.backgroundSync.getFailures;
	if (typeof getFailures !== "function") return [];
	return getFailures.call(sharedFolder.backgroundSync, sharedFolder);
}

export const EMPTY_FOLDER_QUEUE_SNAPSHOT: FolderQueueSnapshot = {
	isPaused: false,
	syncsQueued: 0,
	syncsActive: 0,
	downloadsQueued: 0,
	downloadsActive: 0,
	queued: 0,
	active: 0,
	total: 0,
	runState: "idle",
	label: "Synced",
	showSyncingCount: false,
	itemsByGuid: EMPTY_QUEUE_MAP,
	itemsByPath: EMPTY_QUEUE_MAP,
};
