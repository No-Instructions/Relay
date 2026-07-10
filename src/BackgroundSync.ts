import type { RequestUrlResponse } from "obsidian";
import type { LoginManager } from "./LoginManager";
import * as Y from "yjs";
import { S3RN, S3RemoteCanvas, S3RemoteDocument } from "./S3RN";
import { isDocument, type Document } from "./Document";
import { isCanvas } from "./Canvas";
import type { TimeProvider } from "./TimeProvider";
import { HasLogging, RelayInstances, metrics } from "./debug";
import {
	Observable,
	type Subscriber,
	type Unsubscriber,
} from "./observable/Observable";
import { ObservableSet } from "./observable/ObservableSet";
import { ObservableMap } from "./observable/ObservableMap";
import type { SharedFolder, SharedFolders } from "./SharedFolder";
import { compareFilePaths } from "./FolderSort";
import type { ClientToken } from "./client/types";
import { Canvas } from "./Canvas";
import type { CanvasData } from "./CanvasView";
import { areCanvasDataEqual } from "./CanvasData";
import { SyncFile, isSyncFile } from "./SyncFile";
import { isEmptyDoc, snapshotFromDoc } from "./merge-hsm/state-vectors";
import {
	buildFolderSyncSnapshot,
	FolderSyncSnapshotSmoother,
	type FolderSyncSnapshot,
	type FolderSyncWorkItemInput,
} from "./BackgroundSyncProgress";
import { errorFromUnknown, formatUserFacingError } from "./UserFacingError";
import { getRelayRequestHeaders, requestUrlWithMetrics } from "./customFetch";
import { isRetryableS3Error } from "./S3Error";

export interface QueueItem {
	guid: string;
	path: string;
	doc: Document | Canvas | SyncFile;
	status: "pending" | "running" | "completed" | "failed";
	sharedFolder: SharedFolder;
	userVisible: boolean;
	enqueuedAt: number;
	syncIntent?: "sync" | "upload" | "lca-backfill";
	retryAttempts?: number;
	nextAttemptAt?: number;
	retryReason?: "provider" | "s3";
}

export interface BackgroundSyncFailure {
	id: string;
	guid: string;
	path: string;
	kind: "sync" | "download" | "local";
	message: string;
	sharedFolder: SharedFolder;
}

export interface SyncGroup {
	sharedFolder: SharedFolder;
	total: number; // Total operations (syncs + downloads)
	completed: number; // Successful operations
	status: "pending" | "running" | "completed" | "failed";
	downloads: number;
	syncs: number;
	completedDownloads: number;
	completedSyncs: number;
	failedDownloads: number;
	failedSyncs: number;
	skippedDownloads: number;
	skippedSyncs: number;
	userDownloads: number;
	completedUserDownloads: number;
	failedUserDownloads: number;
	skippedUserDownloads: number;
}

export interface SyncProgress {
	totalPercent: number;
	syncPercent: number;
	downloadPercent: number;
	totalItems: number;
	completedItems: number;
	syncItems: number;
	completedSyncs: number;
	downloadItems: number;
	completedDownloads: number;
}

export interface GroupProgress {
	percent: number;
	syncPercent: number;
	downloadPercent: number;
	sharedFolder: SharedFolder;
	status: "pending" | "running" | "completed" | "failed";
}

interface FolderSyncSnapshotSubscription {
	smoother: FolderSyncSnapshotSmoother;
	subscribers: Set<Subscriber<FolderSyncSnapshot>>;
	latestSnapshot: FolderSyncSnapshot | null;
	unsubscribers: Unsubscriber[];
	emit: () => void;
}

class RetryableProviderSyncError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RetryableProviderSyncError";
	}
}

const MAX_PROVIDER_SYNC_RETRIES = 5;
const BACKGROUND_SYNC_QUEUE_PUMP_INTERVAL_MS = 1000;
const BACKGROUND_SYNC_FOLDER_POLL_INTERVAL_MS = 5000;
const BACKGROUND_SYNC_DRAIN_BUDGET_MS = 8;
const LOCAL_AHEAD_RETRY_INTERVAL_MS = 5 * 60_000;
type BackgroundSyncOperation = "sync" | "download";
type BackgroundSyncSortReason = "enqueue" | "retry" | "batch" | "group";

function isRetryableProviderSyncError(
	error: unknown,
): error is RetryableProviderSyncError {
	return error instanceof RetryableProviderSyncError;
}

function isRetryableSyncError(error: unknown): error is Error {
	return isRetryableProviderSyncError(error) || isRetryableS3Error(error);
}

export interface QueueStatus {
	syncsQueued: number;
	syncsActive: number;
	downloadsQueued: number;
	downloadsActive: number;
	isPaused: boolean;
}

export class BackgroundSync extends HasLogging {
	public activeSync = new ObservableSet<QueueItem>();
	public activeDownloads = new ObservableSet<QueueItem>();
	public syncGroups = new ObservableMap<SharedFolder, SyncGroup>();
	private folderResyncs = new ObservableSet<SharedFolder>();
	private failures = new ObservableMap<string, BackgroundSyncFailure>(
		"BackgroundSync.failures",
	);
	private queueStatusChanged = new Observable<BackgroundSync>("BackgroundSync.queueStatus");

	private syncQueue: QueueItem[] = [];
	private downloadQueue: QueueItem[] = [];
	// Local-ahead docs whose sync session did not converge (e.g. the server
	// refuses the ops) stay advertised-out-of-sync forever; without a marker
	// every subdoc index sync would re-enqueue a full session for them.
	private localAheadAttempts = new Map<string, number>();
	private isProcessingSync = false;
	private isProcessingDownloads = false;
	private isPaused = true;
	private inProgressSyncs = new Set<string>();
	private inProgressDownloads = new Set<string>();
	private cancelledSyncs = new Set<string>();
	private cancelledDownloads = new Set<string>();
	private syncCompletionCallbacks = new Map<
		string,
		{
			resolve: () => void;
			reject: (error: Error) => void;
		}
	>();
	private syncPromises = new Map<string, Promise<void>>();
	private downloadCompletionCallbacks = new Map<
		string,
		{
			resolve: (result?: Uint8Array) => void;
			reject: (error: Error) => void;
		}
	>();
	private downloadPromises = new Map<string, Promise<Uint8Array | undefined>>();
	private folderSyncSnapshotSubscriptions = new Map<
		SharedFolder,
		FolderSyncSnapshotSubscription
	>();
	private folderQueueWakeups = new Map<SharedFolder, Unsubscriber>();

	// A map to track items we've already logged to avoid duplicates
	private loggedItems = new Map<string, boolean>();

	subscriptions: Unsubscriber[] = [];

	constructor(
		private loginManager: LoginManager,
		private timeProvider: TimeProvider,
		private sharedFolders: SharedFolders,
		private concurrency: number = 3,
	) {
		super();
		RelayInstances.set(this, "BackgroundSync");
		let lastQueuePumpAt = this.timeProvider.now();
		this.timeProvider.setInterval(() => {
			const now = this.timeProvider.now();
			this.recordTickDelay(
				"queue",
				lastQueuePumpAt,
				now,
				BACKGROUND_SYNC_QUEUE_PUMP_INTERVAL_MS,
			);
			lastQueuePumpAt = now;
			this.processSyncQueue();
			this.processDownloadQueue();
		}, BACKGROUND_SYNC_QUEUE_PUMP_INTERVAL_MS);

		// Add polling timer for disk changes (poll all folders)
		let lastFolderPollAt = this.timeProvider.now();
		this.timeProvider.setInterval(() => {
			const now = this.timeProvider.now();
			this.recordTickDelay(
				"folder_poll",
				lastFolderPollAt,
				now,
				BACKGROUND_SYNC_FOLDER_POLL_INTERVAL_MS,
			);
			lastFolderPollAt = now;
			this.sharedFolders.forEach((folder) => {
				folder.poll();
			});
		}, BACKGROUND_SYNC_FOLDER_POLL_INTERVAL_MS);

		this.subscriptions.push(
			this.sharedFolders.subscribe(() => {
				this.updateFolderQueueWakeups();
			}),
		);
		this.updateFolderQueueWakeups();
	}

	/**
	 * Returns items currently in the sync queue
	 */
	public get pendingSyncs(): readonly QueueItem[] {
		return this.syncQueue;
	}

	/**
	 * Returns items currently in the download queue
	 */
	public get pendingDownloads(): readonly QueueItem[] {
		return this.downloadQueue;
	}

	cancelDocumentWork(guid: string): void {
		let changed = false;

		const queuedSyncs = this.syncQueue.filter((item) => item.guid === guid);
		if (queuedSyncs.length > 0) {
			for (const item of queuedSyncs) {
				this.removeQueuedSyncFromGroup(item);
			}
			this.syncQueue = this.syncQueue.filter((item) => item.guid !== guid);
			changed = true;
		}

		const queuedDownloads = this.downloadQueue.filter((item) => item.guid === guid);
		if (queuedDownloads.length > 0) {
			for (const item of queuedDownloads) {
				this.removeQueuedDownloadFromGroup(item);
			}
			this.downloadQueue = this.downloadQueue.filter((item) => item.guid !== guid);
			changed = true;
		}

		if (this.activeSync.some((item) => item.guid === guid)) {
			this.cancelledSyncs.add(guid);
		} else {
			this.resolveSyncCancellation(guid);
		}

		if (this.activeDownloads.some((item) => item.guid === guid)) {
			this.cancelledDownloads.add(guid);
		} else {
			this.resolveDownloadCancellation(guid);
		}

		this.clearFailure(this.failureKey("sync", guid));
		this.clearFailure(this.failureKey("download", guid));

		if (changed) {
			metrics.setBgSyncQueueLength("sync", this.syncQueue.length);
			metrics.setBgSyncQueueLength("download", this.downloadQueue.length);
			this.queueStatusChanged.notifyListeners();
		}
	}

	private removeQueuedSyncFromGroup(item: QueueItem): void {
		const group = this.syncGroups.get(item.sharedFolder);
		if (!group) return;

		group.total = Math.max(0, group.total - 1);
		group.syncs = Math.max(0, group.syncs - 1);
		this.updateGroupTerminalStatus(group);
		this.syncGroups.set(item.sharedFolder, group);
	}

	private removeQueuedDownloadFromGroup(item: QueueItem): void {
		const group = this.syncGroups.get(item.sharedFolder);
		if (!group) return;

		group.total = Math.max(0, group.total - 1);
		group.downloads = Math.max(0, group.downloads - 1);
		if (item.userVisible) {
			group.userDownloads = Math.max(0, group.userDownloads - 1);
		}
		this.updateGroupTerminalStatus(group);
		this.syncGroups.set(item.sharedFolder, group);
	}

	private resolveSyncCancellation(guid: string): void {
		const callback = this.syncCompletionCallbacks.get(guid);
		if (callback) callback.resolve();
		this.syncCompletionCallbacks.delete(guid);
		this.syncPromises.delete(guid);
		this.inProgressSyncs.delete(guid);
		this.cancelledSyncs.delete(guid);
	}

	private resolveDownloadCancellation(guid: string): void {
		const callback = this.downloadCompletionCallbacks.get(guid);
		if (callback) callback.resolve(undefined);
		this.downloadCompletionCallbacks.delete(guid);
		this.downloadPromises.delete(guid);
		this.inProgressDownloads.delete(guid);
		this.cancelledDownloads.delete(guid);
	}

	private isSyncCancelled(item: QueueItem): boolean {
		return item.doc.destroyed || this.cancelledSyncs.has(item.guid);
	}

	private isSyncCancelledForDoc(doc: Document | Canvas | SyncFile): boolean {
		return doc.destroyed || this.cancelledSyncs.has(doc.guid);
	}

	private isDownloadCancelled(item: QueueItem): boolean {
		return item.doc.destroyed || this.cancelledDownloads.has(item.guid);
	}

	private shouldSkipDocumentSync(item: Document | Canvas | SyncFile): boolean {
		return isDocument(item) && item.hsm?.getSyncStatus().status === "conflict";
	}

	/**
	 * A queued item is drainable only when its folder is connected and the
	 * user hasn't asked it to pause. Items for disconnected folders stay in
	 * the queue — enqueues made while offline (pending uploads, remaps) must
	 * survive until reconnect, when the folder-state subscription wakes the
	 * queues — rather than being dropped at enqueue time.
	 */
	private isDrainable(item: QueueItem): boolean {
		return (
			item.sharedFolder.connected &&
			item.sharedFolder.intent !== "disconnected"
		);
	}

	getOverallProgress(): SyncProgress {
		let totalItems = 0;
		let completedItems = 0;
		let syncItems = 0;
		let completedSyncs = 0;
		let downloadItems = 0;
		let completedDownloads = 0;

		this.syncGroups.forEach((group) => {
			totalItems += group.total;
			completedItems += this.groupFinishedTotal(group);
			syncItems += group.syncs;
			completedSyncs += this.groupFinishedSyncs(group);
			downloadItems += group.downloads;
			completedDownloads += this.groupFinishedDownloads(group);
		});

		const totalPercent =
			totalItems > 0 ? (completedItems / totalItems) * 100 : 0;
		const syncPercent = syncItems > 0 ? (completedSyncs / syncItems) * 100 : 0;
		const downloadPercent =
			downloadItems > 0 ? (completedDownloads / downloadItems) * 100 : 0;

		return {
			totalPercent: Math.round(totalPercent),
			syncPercent: Math.round(syncPercent),
			downloadPercent: Math.round(downloadPercent),
			totalItems,
			completedItems,
			syncItems,
			completedSyncs,
			downloadItems,
			completedDownloads,
		};
	}

	getGroupProgress(sharedFolder: SharedFolder): GroupProgress | null {
		const group = this.syncGroups.get(sharedFolder);
		if (!group) return null;

		const percent =
			group.total > 0 ? (this.groupFinishedTotal(group) / group.total) * 100 : 0;
		const syncPercent =
			group.syncs > 0
				? (this.groupFinishedSyncs(group) / group.syncs) * 100
				: 0;
		const downloadPercent =
			group.downloads > 0
				? (this.groupFinishedDownloads(group) / group.downloads) * 100
				: 0;

		return {
			percent: Math.round(percent),
			syncPercent: Math.round(syncPercent),
			downloadPercent: Math.round(downloadPercent),
			sharedFolder,
			status: group.status,
		};
	}

	/**
	 * Returns download-only progress for a shared folder.
	 * Used to show only user-visible downloads in folder progress indicators.
	 */
	getUserVisibleProgress(sharedFolder: SharedFolder): GroupProgress | null {
		const group = this.syncGroups.get(sharedFolder);
		if (!group) return null;

		const total = group.userDownloads;
		const finished =
			group.completedUserDownloads +
			group.failedUserDownloads +
			group.skippedUserDownloads;
		const percent = total > 0 ? (finished / total) * 100 : 0;
		const status =
			total === 0
				? group.status
				: finished === total
					? group.failedUserDownloads > 0
						? "failed"
						: "completed"
					: group.status === "failed"
						? "failed"
						: "running";

		return {
			percent: Math.round(percent),
			syncPercent: 0,
			downloadPercent: Math.round(percent),
			sharedFolder,
			status,
		};
	}

	private groupFinishedSyncs(group: SyncGroup): number {
		return Math.min(
			group.syncs,
			group.completedSyncs + group.failedSyncs + group.skippedSyncs,
		);
	}

	private groupFinishedDownloads(group: SyncGroup): number {
		return Math.min(
			group.downloads,
			group.completedDownloads + group.failedDownloads + group.skippedDownloads,
		);
	}

	private groupFinishedTotal(group: SyncGroup): number {
		return Math.min(
			group.total,
			this.groupFinishedSyncs(group) + this.groupFinishedDownloads(group),
		);
	}

	private groupFailureCount(group: SyncGroup): number {
		return group.failedSyncs + group.failedDownloads;
	}

	private updateGroupTerminalStatus(group: SyncGroup): void {
		if (this.groupFinishedTotal(group) >= group.total) {
			group.status = this.groupFailureCount(group) > 0 ? "failed" : "completed";
		} else if (this.groupFailureCount(group) > 0) {
			group.status = "failed";
		} else if (group.total > 0) {
			group.status = "running";
		} else {
			group.status = "completed";
		}
	}

	private markSyncTerminal(
		sharedFolder: SharedFolder,
		outcome: "completed" | "failed" | "skipped",
	): void {
		const group = this.syncGroups.get(sharedFolder);
		if (!group) return;
		if (outcome === "completed") {
			group.completedSyncs++;
			group.completed++;
		} else if (outcome === "failed") {
			group.failedSyncs++;
		} else {
			group.skippedSyncs++;
		}
		this.updateGroupTerminalStatus(group);
		this.syncGroups.set(sharedFolder, group);
	}

	private markDownloadTerminal(
		item: QueueItem,
		outcome: "completed" | "failed" | "skipped",
	): void {
		const group = this.syncGroups.get(item.sharedFolder);
		if (!group) return;
		if (outcome === "completed") {
			group.completedDownloads++;
			group.completed++;
			if (item.userVisible) {
				group.completedUserDownloads++;
			}
		} else if (outcome === "failed") {
			group.failedDownloads++;
			if (item.userVisible) {
				group.failedUserDownloads++;
			}
		} else {
			group.skippedDownloads++;
			if (item.userVisible) {
				group.skippedUserDownloads++;
			}
		}
		this.updateGroupTerminalStatus(group);
		this.syncGroups.set(item.sharedFolder, group);
	}

	private requeueRetryableSync(
		item: QueueItem,
		error: Error,
	): boolean {
		const retries = (item.retryAttempts ?? 0) + 1;
		item.retryAttempts = retries;
		if (retries > MAX_PROVIDER_SYNC_RETRIES) {
			item.nextAttemptAt = undefined;
			item.retryReason = undefined;
			this.warn(
				`[sync] retryable sync failed after ${MAX_PROVIDER_SYNC_RETRIES} retries for ${item.path}: ${error.message}`,
			);
			return false;
		}

		const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(retries - 1, 5));
		const reason = this.retryReason(error);
		item.status = "pending";
		item.nextAttemptAt = this.timeProvider.now() + delayMs;
		item.retryReason = reason;
		metrics.recordBgSyncRetry("sync", reason, retries, delayMs / 1000);

		this.clearFailure(this.failureKey("sync", item.guid));
		if (!this.syncQueue.some((queued) => queued.guid === item.guid)) {
			this.syncQueue.push(item);
			this.sortByPath(this.syncQueue, "sync", "retry");
		}
		this.debug(
			`[sync] retryable sync failure for ${item.path}: ${error.message}; retrying in ${delayMs}ms`,
		);
		metrics.setBgSyncQueueLength("sync", this.syncQueue.length);
		this.queueStatusChanged.notifyListeners();
		return true;
	}

	private retryReason(error: Error): "provider" | "s3" {
		return isRetryableProviderSyncError(error) ? "provider" : "s3";
	}

	private recordTickDelay(
		tick: "queue" | "folder_poll",
		lastTickAt: number,
		now: number,
		intervalMs: number,
	): void {
		const delayMs = Math.max(0, now - lastTickAt - intervalMs);
		metrics.observeBgSyncTickDelay(tick, delayMs / 1000);
	}

	private sortByPath<T extends { path: string }>(
		items: T[],
		operation: BackgroundSyncOperation,
		reason: BackgroundSyncSortReason,
	): T[] {
		if (items.length < 2) return items;
		const sortStart = performance.now();
		items.sort(compareFilePaths);
		metrics.observeBgSyncSort(
			operation,
			reason,
			items.length,
			(performance.now() - sortStart) / 1000,
		);
		return items;
	}

	private recordDrain(
		operation: BackgroundSyncOperation,
		startedAt: number,
		itemsStarted: number,
	): void {
		metrics.observeBgSyncDrain(
			operation,
			(performance.now() - startedAt) / 1000,
			itemsStarted,
			BACKGROUND_SYNC_DRAIN_BUDGET_MS,
		);
	}

	private observeItemStart(
		operation: BackgroundSyncOperation,
		item: QueueItem,
		now: number,
	): void {
		const intent = operation === "download"
			? "download"
			: item.syncIntent ?? "sync";
		metrics.observeBgSyncItemAge(
			operation,
			intent,
			Math.max(0, now - item.enqueuedAt) / 1000,
		);
		if (item.nextAttemptAt !== undefined && item.retryReason) {
			metrics.observeBgSyncRetryLateness(
				operation,
				item.retryReason,
				Math.max(0, now - item.nextAttemptAt) / 1000,
			);
		}
	}

	getFolderPillProgress(sharedFolder: SharedFolder): GroupProgress | null {
		const group = this.syncGroups.get(sharedFolder);
		if (!group) return null;

		const snapshot = this.getFolderSyncSnapshot(sharedFolder);
		return {
			percent: snapshot.percent,
			syncPercent: snapshot.syncPercent,
			downloadPercent: snapshot.downloadPercent,
			sharedFolder,
			status: snapshot.progressStatus,
		};
	}

	getFolderSyncSnapshot(sharedFolder: SharedFolder): FolderSyncSnapshot {
		const activeDownloads = this.activeDownloads.filter(
			(item) => item.sharedFolder === sharedFolder,
		);
		const activeSync = this.activeSync.filter(
			(item) => item.sharedFolder === sharedFolder,
		);
		const queuedDownloads = this.downloadQueue.filter(
			(item) => item.sharedFolder === sharedFolder,
		);
		const queuedSyncs = this.syncQueue.filter(
			(item) => item.sharedFolder === sharedFolder,
		);
		const folderResyncActive = this.folderResyncs.has(sharedFolder) ? 1 : 0;
		const activeItem = this.activeItemForSnapshot(activeDownloads, activeSync);
		const queuedReason = this.queuedReasonForSnapshot(
			sharedFolder,
			activeDownloads.length + activeSync.length,
			queuedDownloads.length + queuedSyncs.length,
		);

		return buildFolderSyncSnapshot({
			group: this.syncGroups.get(sharedFolder) ?? null,
			queued: queuedDownloads.length + queuedSyncs.length,
			active: activeDownloads.length + activeSync.length + folderResyncActive,
			isPaused: this.isPaused,
			failureCount: this.getFailures(sharedFolder).length,
			canResync: sharedFolder.connected && !sharedFolder.localOnly,
			folderActivity: folderResyncActive ? "checking" : null,
			activeItem,
			queuedReason,
		});
	}

	private activeItemForSnapshot(
		activeDownloads: QueueItem[],
		activeSync: QueueItem[],
	): FolderSyncWorkItemInput | null {
		const download = activeDownloads[0];
		if (download) return { kind: "download", path: download.path };
		const sync = activeSync[0];
		if (sync) return { kind: "sync", path: sync.path };
		return null;
	}

	private queuedReasonForSnapshot(
		sharedFolder: SharedFolder,
		active: number,
		queued: number,
	): "connection" | "reconnecting" | null {
		if (active > 0 || queued === 0) return null;
		if (!sharedFolder.connected) {
			return sharedFolder.state.status === "connecting"
				? "reconnecting"
				: "connection";
		}
		return null;
	}

	getFailures(sharedFolder: SharedFolder): BackgroundSyncFailure[] {
		return this.failures
			.values()
			.filter((failure) => failure.sharedFolder === sharedFolder)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	clearFailure(id: string): void {
		this.failures.delete(id);
	}

	clearFailuresForFolder(sharedFolder: SharedFolder): void {
		for (const failure of this.failures.values()) {
			if (failure.sharedFolder === sharedFolder) {
				this.clearFailure(failure.id);
			}
		}
	}

	beginFolderResync(sharedFolder: SharedFolder): Unsubscriber {
		this.clearFailuresForFolder(sharedFolder);
		this.folderResyncs.add(sharedFolder);
		return () => {
			this.folderResyncs.delete(sharedFolder);
		};
	}

	async refreshLocalFileFailures(sharedFolder: SharedFolder): Promise<void> {
		const liveLocalFailureIds = new Set<string>();
		for (const file of sharedFolder.files.values()) {
			if (!isCanvas(file)) continue;
			const id = this.failureKey("local", file.guid);
			liveLocalFailureIds.add(id);
			const message = await this.getCanvasLocalStateFailure(file);
			if (message) {
				this.setFailure({
					id,
					guid: file.guid,
					path: file.path,
					kind: "local",
					message,
					sharedFolder,
				});
			} else {
				this.clearFailure(id);
			}
		}

		for (const failure of this.failures.values()) {
			if (
				failure.sharedFolder === sharedFolder &&
				failure.kind === "local" &&
				!liveLocalFailureIds.has(failure.id)
			) {
				this.clearFailure(failure.id);
			}
		}
	}

	private async getCanvasLocalStateFailure(
		canvas: Canvas,
	): Promise<string | null> {
		await canvas.whenSynced();
		let currentFileContents: string;
		try {
			currentFileContents = await canvas.sharedFolder.read(canvas);
		} catch (e) {
			return null;
		}
		if (!currentFileContents) return null;

		let currentFileJson: CanvasData;
		try {
			currentFileJson = JSON.parse(currentFileContents) as CanvasData;
		} catch (e) {
			return "Canvas file contains invalid JSON. Open the canvas and repair it before syncing.";
		}

		const currentCanvasData = Canvas.exportCanvasData(canvas.ydoc);
		if (areCanvasDataEqual(currentCanvasData, currentFileJson)) {
			return null;
		}
		if (await this.repairStaleCanvasText(canvas, currentFileJson)) {
			return null;
		}
		return "Canvas file does not match local sync state. Open the canvas and resolve the local changes before syncing.";
	}

	private async repairStaleCanvasText(
		canvas: Canvas,
		currentFileJson: CanvasData,
	): Promise<boolean> {
		const currentCanvasMapData = Canvas.exportCanvasMapData(canvas.ydoc);
		if (!areCanvasDataEqual(currentCanvasMapData, currentFileJson)) {
			return false;
		}

		await canvas.applyData(currentFileJson);
		return areCanvasDataEqual(
			Canvas.exportCanvasData(canvas.ydoc),
			currentFileJson,
		);
	}

	getAllGroupsProgress(): GroupProgress[] {
		const progress: GroupProgress[] = [];
		this.syncGroups.forEach((group, sharedFolder) => {
			const groupProgress = this.getGroupProgress(sharedFolder);
			if (groupProgress) {
				progress.push(groupProgress);
			}
		});
		return progress;
	}

	private updateFolderQueueWakeups(): void {
		const currentFolders = new Set(this.sharedFolders.items());

		for (const [folder, unsubscribe] of this.folderQueueWakeups) {
			if (!currentFolders.has(folder)) {
				unsubscribe();
				this.folderQueueWakeups.delete(folder);
			}
		}

		for (const folder of currentFolders) {
			if (this.folderQueueWakeups.has(folder)) continue;

			const subscriptionKey = {
				type: "background-sync-queue-wakeup",
				folder,
			};
			const unsubscribe = folder.subscribe(subscriptionKey, () => {
				this.wakeQueues();
			});
			this.folderQueueWakeups.set(folder, unsubscribe);
		}

		this.wakeQueues();
	}

	private wakeQueues(): void {
		if (!this.timeProvider) return;
		this.processSyncQueue();
		this.processDownloadQueue();
	}

	private async processSyncQueue() {
		if (this.isPaused || this.isProcessingSync) return;
		const drainStart = performance.now();
		let itemsStarted = 0;
		this.isProcessingSync = true;
		try {
			// Evict destroyed documents from the queue and clean up their inProgress entries
			const destroyed = this.syncQueue.filter((item) => item.doc.destroyed);
			for (const item of destroyed) {
				this.markSyncTerminal(item.sharedFolder, "skipped");
				this.inProgressSyncs.delete(item.guid);
				const callback = this.syncCompletionCallbacks.get(item.guid);
				if (callback) callback.reject(new Error("Document destroyed"));
				this.syncCompletionCallbacks.delete(item.guid);
				this.syncPromises.delete(item.guid);
			}
			this.syncQueue = this.syncQueue.filter((item) => !item.doc.destroyed);

			metrics.setBgSyncQueueLength("sync", this.syncQueue.length);

			// Filter for items with connected folders
			const now = this.timeProvider.now();
			const connectableItems = this.syncQueue.filter(
				(item) =>
					this.isDrainable(item) &&
					(item.nextAttemptAt === undefined || item.nextAttemptAt <= now),
			);

			while (
				connectableItems.length > 0 &&
				this.activeSync.size < this.concurrency
			) {
				const item = connectableItems.shift();
				if (!item) break;

				// Remove this item from the main queue
				this.syncQueue = this.syncQueue.filter((i) => i.guid !== item.guid);

				this.observeItemStart("sync", item, this.timeProvider.now());
				item.nextAttemptAt = undefined;
				item.retryReason = undefined;
				itemsStarted++;
				item.status = "running";
				const opStart = performance.now();
				this.activeSync.add(item);
				metrics.setBgSyncActive("sync", this.activeSync.size);
				metrics.setBgSyncQueueLength("sync", this.syncQueue.length);

				try {
					const doc = item.doc;
					let syncPromise: Promise<any>;

					if (doc instanceof SyncFile) {
						syncPromise = this.syncFile(doc);
					} else if (item.syncIntent === "upload") {
						syncPromise = this.syncDocumentUpload(doc);
					} else if (item.syncIntent === "lca-backfill" && isDocument(doc)) {
						syncPromise = this.syncDocumentLCABackfill(doc);
					} else {
						syncPromise = this.syncDocument(doc);
					}

					syncPromise
						.then(() => {
							item.status = "completed";
							metrics.incBgSyncOps("sync", "completed");
							const callback = this.syncCompletionCallbacks.get(item.guid);
							if (callback) {
								callback.resolve();
								this.syncCompletionCallbacks.delete(item.guid);
								this.syncPromises.delete(item.guid);
							}

							this.markSyncTerminal(item.sharedFolder, "completed");
						})
						.catch((error) => {
							if (this.isSyncCancelled(item)) {
								item.status = "completed";
								this.markSyncTerminal(item.sharedFolder, "skipped");
								this.resolveSyncCancellation(item.guid);
								return;
							}

							if (
								isRetryableSyncError(error) &&
								this.requeueRetryableSync(item, error)
							) {
								return;
							}

							item.status = "failed";
							metrics.incBgSyncOps("sync", "failed");

							const callback = this.syncCompletionCallbacks.get(item.guid);
							if (callback) {
								callback.reject(errorFromUnknown(error));
								this.syncCompletionCallbacks.delete(item.guid);
								this.syncPromises.delete(item.guid);
							}

							this.logError("[Sync Failed]", error);
							this.recordFailure("sync", item, error);
							this.markSyncTerminal(item.sharedFolder, "failed");
						})
						.finally(() => {
							metrics.observeBgSyncOp("sync", (performance.now() - opStart) / 1000);
							this.activeSync.delete(item);
							metrics.setBgSyncActive("sync", this.activeSync.size);
							if (!this.syncQueue.some((queued) => queued.guid === item.guid)) {
								this.inProgressSyncs.delete(item.guid);
								this.cancelledSyncs.delete(item.guid);
							}

							// Continue queue draining without relying on throttled timers.
							queueMicrotask(() => {
								if (!this.timeProvider) return;
								this.processSyncQueue();
							});
						});
				} catch (error) {
					if (this.isSyncCancelled(item)) {
						item.status = "completed";
						metrics.observeBgSyncOp("sync", (performance.now() - opStart) / 1000);
						this.markSyncTerminal(item.sharedFolder, "skipped");
						this.resolveSyncCancellation(item.guid);
						this.activeSync.delete(item);
						metrics.setBgSyncActive("sync", this.activeSync.size);
						this.inProgressSyncs.delete(item.guid);
						this.cancelledSyncs.delete(item.guid);
						continue;
					}

					if (
						isRetryableSyncError(error) &&
						this.requeueRetryableSync(item, error)
					) {
						metrics.observeBgSyncOp("sync", (performance.now() - opStart) / 1000);
						this.activeSync.delete(item);
						metrics.setBgSyncActive("sync", this.activeSync.size);
						continue;
					}

					item.status = "failed";
					metrics.incBgSyncOps("sync", "failed");
					metrics.observeBgSyncOp("sync", (performance.now() - opStart) / 1000);

					const callback = this.syncCompletionCallbacks.get(item.guid);
					if (callback) {
						callback.reject(errorFromUnknown(error));
						this.syncCompletionCallbacks.delete(item.guid);
						this.syncPromises.delete(item.guid);
					}

					this.logError("[Sync Startup Failed]", error);
					this.recordFailure("sync", item, error);
					this.markSyncTerminal(item.sharedFolder, "failed");

					this.activeSync.delete(item);
					metrics.setBgSyncActive("sync", this.activeSync.size);
					this.inProgressSyncs.delete(item.guid);
				}
			}

		} finally {
			this.isProcessingSync = false;
			this.recordDrain("sync", drainStart, itemsStarted);
		}
	}

	private async processDownloadQueue() {
		if (this.isPaused || this.isProcessingDownloads) return;
		const drainStart = performance.now();
		let itemsStarted = 0;
		this.isProcessingDownloads = true;
		try {
			// Evict destroyed documents from the queue and clean up their inProgress entries
			const destroyedDownloads = this.downloadQueue.filter((item) => item.doc.destroyed);
			for (const item of destroyedDownloads) {
				this.markDownloadTerminal(item, "skipped");
				this.inProgressDownloads.delete(item.guid);
				const callback = this.downloadCompletionCallbacks.get(item.guid);
				if (callback) callback.reject(new Error("Document destroyed"));
				this.downloadCompletionCallbacks.delete(item.guid);
				this.downloadPromises.delete(item.guid);
			}
			this.downloadQueue = this.downloadQueue.filter((item) => !item.doc.destroyed);

			metrics.setBgSyncQueueLength("download", this.downloadQueue.length);

			// Filter for items with connected folders
			const connectableItems = this.downloadQueue.filter((item) =>
				this.isDrainable(item),
			);

			while (
				connectableItems.length > 0 &&
				this.activeDownloads.size < this.concurrency
			) {
				const item = connectableItems.shift();
				if (!item) break;

				// Remove this item from the main queue
				this.downloadQueue = this.downloadQueue.filter(
					(i) => i.guid !== item.guid,
				);

				this.observeItemStart("download", item, this.timeProvider.now());
				itemsStarted++;
				item.status = "running";
				const opStart = performance.now();
				this.activeDownloads.add(item);
				metrics.setBgSyncActive("download", this.activeDownloads.size);
				metrics.setBgSyncQueueLength("download", this.downloadQueue.length);

				try {
					let downloadPromise: Promise<any>;

					// Choose the appropriate download method based on the document type
					if (item.doc instanceof Canvas) {
						downloadPromise = this.getCanvas(item.doc);
					} else if (item.doc instanceof SyncFile) {
						downloadPromise = this.getSyncFile(item.doc);
					} else {
						downloadPromise = this.getDocument(item.doc);
					}

					downloadPromise
						.then((result) => {
							item.status = "completed";
							metrics.incBgSyncOps("download", "completed");

							const callback = this.downloadCompletionCallbacks.get(item.guid);
							if (callback) {
								callback.resolve(result as Uint8Array | undefined);
								this.downloadCompletionCallbacks.delete(item.guid);
								this.downloadPromises.delete(item.guid);
							}

							this.markDownloadTerminal(item, "completed");
						})
						.catch((error) => {
							if (this.isDownloadCancelled(item)) {
								item.status = "completed";
								this.markDownloadTerminal(item, "skipped");
								this.resolveDownloadCancellation(item.guid);
								return;
							}

							item.status = "failed";
							metrics.incBgSyncOps("download", "failed");

							const callback = this.downloadCompletionCallbacks.get(item.guid);
							if (callback) {
								callback.reject(errorFromUnknown(error));
								this.downloadCompletionCallbacks.delete(item.guid);
								this.downloadPromises.delete(item.guid);
							}

							this.recordFailure("download", item, error);
							this.logError("[processDownloadQueue]", error);
							this.markDownloadTerminal(item, "failed");
						})
						.finally(() => {
							metrics.observeBgSyncOp("download", (performance.now() - opStart) / 1000);
							this.activeDownloads.delete(item);
							metrics.setBgSyncActive("download", this.activeDownloads.size);
							this.inProgressDownloads.delete(item.guid);
							this.cancelledDownloads.delete(item.guid);

							// Continue queue draining without relying on throttled timers.
							queueMicrotask(() => {
								if (!this.timeProvider) return;
								this.processDownloadQueue();
							});
						});
				} catch (error) {
					if (this.isDownloadCancelled(item)) {
						item.status = "completed";
						metrics.observeBgSyncOp("download", (performance.now() - opStart) / 1000);
						this.markDownloadTerminal(item, "skipped");
						this.resolveDownloadCancellation(item.guid);
						this.activeDownloads.delete(item);
						metrics.setBgSyncActive("download", this.activeDownloads.size);
						this.inProgressDownloads.delete(item.guid);
						this.cancelledDownloads.delete(item.guid);
						continue;
					}

					item.status = "failed";
					metrics.incBgSyncOps("download", "failed");
					metrics.observeBgSyncOp("download", (performance.now() - opStart) / 1000);

					const callback = this.downloadCompletionCallbacks.get(item.guid);
					if (callback) {
						callback.reject(errorFromUnknown(error));
						this.downloadCompletionCallbacks.delete(item.guid);
						this.downloadPromises.delete(item.guid);
					}

					this.logError("[Download Startup Failed]", error);
					this.recordFailure("download", item, error);
					this.markDownloadTerminal(item, "failed");

					this.activeDownloads.delete(item);
					metrics.setBgSyncActive("download", this.activeDownloads.size);
					this.inProgressDownloads.delete(item.guid);
				}
			}

		} finally {
			this.isProcessingDownloads = false;
			this.recordDrain("download", drainStart, itemsStarted);
		}
	}

	/**
	 * Enqueues a document for synchronization
	 *
	 * This method adds a document to the sync queue and creates/updates
	 * the associated sync group to track progress.
	 *
	 * @param item The document to synchronize
	 * @returns A promise that resolves when the sync completes
	 */
	async enqueueSync(item: SyncFile | Document | Canvas): Promise<void> {
		if (this.shouldSkipDocumentSync(item)) {
			this.clearFailure(this.failureKey("sync", item.guid));
			return Promise.resolve();
		}

		// Skip if already in progress — return the same promise all callers share
		if (this.inProgressSyncs.has(item.guid)) {
			this.debug(
				`[enqueueSync] Item ${item.guid} already in progress, sharing promise`,
			);
			return this.syncPromises.get(item.guid) ?? Promise.resolve();
		}

		const sharedFolder = item.sharedFolder;
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
			userVisible: false,
			enqueuedAt: this.timeProvider.now(),
		};
		this.clearFailure(this.failureKey("sync", item.guid));

		// Get or create the sync group
		let group = this.syncGroups.get(sharedFolder);
		if (!group) {
			group = {
				sharedFolder,
				total: 0,
				completed: 0,
				status: "pending",
				downloads: 0,
				syncs: 0,
				completedDownloads: 0,
				completedSyncs: 0,
				failedDownloads: 0,
				failedSyncs: 0,
				skippedDownloads: 0,
				skippedSyncs: 0,
				userDownloads: 0,
				completedUserDownloads: 0,
				failedUserDownloads: 0,
				skippedUserDownloads: 0,
			};
		}
		group.total++;
		group.syncs++;
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);

		this.inProgressSyncs.add(item.guid);

		const syncPromise = new Promise<void>((resolve, reject) => {
			this.syncCompletionCallbacks.set(item.guid, {
				resolve,
				reject,
			});
		});
		this.syncPromises.set(item.guid, syncPromise);

		this.syncQueue.push(queueItem);
		this.sortByPath(this.syncQueue, "sync", "enqueue");
		this.queueStatusChanged.notifyListeners();
		this.processSyncQueue();

		return syncPromise;
	}

	async enqueueRetryableSync(
		item: SyncFile | Document | Canvas,
		error: Error,
	): Promise<void> {
		if (this.shouldSkipDocumentSync(item)) {
			this.clearFailure(this.failureKey("sync", item.guid));
			return Promise.resolve();
		}

		if (this.inProgressSyncs.has(item.guid)) {
			return this.syncPromises.get(item.guid) ?? Promise.resolve();
		}

		const sharedFolder = item.sharedFolder;
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
			userVisible: false,
			enqueuedAt: this.timeProvider.now(),
		};

		let group = this.syncGroups.get(sharedFolder);
		if (!group) {
			group = {
				sharedFolder,
				total: 0,
				completed: 0,
				status: "pending",
				downloads: 0,
				syncs: 0,
				completedDownloads: 0,
				completedSyncs: 0,
				failedDownloads: 0,
				failedSyncs: 0,
				skippedDownloads: 0,
				skippedSyncs: 0,
				userDownloads: 0,
				completedUserDownloads: 0,
				failedUserDownloads: 0,
				skippedUserDownloads: 0,
			};
		}
		group.total++;
		group.syncs++;
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);

		this.inProgressSyncs.add(item.guid);
		const syncPromise = new Promise<void>((resolve, reject) => {
			this.syncCompletionCallbacks.set(item.guid, {
				resolve,
				reject,
			});
		});
		this.syncPromises.set(item.guid, syncPromise);

		if (!this.requeueRetryableSync(queueItem, error)) {
			this.inProgressSyncs.delete(item.guid);
			this.syncCompletionCallbacks.delete(item.guid);
			this.syncPromises.delete(item.guid);
			return Promise.reject(error);
		}

		return syncPromise;
	}

	/**
	 * Enqueue a local-authoritative upload before markUploaded(). For documents,
	 * this seeds remoteDoc from the enrolled local CRDT before provider sync
	 * resolves; other file types use their normal sync mechanics.
	 */
	async enqueueUpload(item: SyncFile | Document | Canvas): Promise<void> {
		if (this.shouldSkipDocumentSync(item)) {
			this.clearFailure(this.failureKey("sync", item.guid));
			return Promise.resolve();
		}

		if (this.inProgressSyncs.has(item.guid)) {
			const queued = this.syncQueue.find((queued) => queued.guid === item.guid);
			if (queued) {
				queued.syncIntent = "upload";
				return this.syncPromises.get(item.guid) ?? Promise.resolve();
			}

			const active = this.activeSync.find((active) => active.guid === item.guid);
			if (active?.syncIntent === "upload") {
				return this.syncPromises.get(item.guid) ?? Promise.resolve();
			}

			return this.enqueueUploadAfterCurrentSync(item);
		}

		const sharedFolder = item.sharedFolder;
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
			userVisible: false,
			enqueuedAt: this.timeProvider.now(),
			syncIntent: "upload",
		};
		this.clearFailure(this.failureKey("sync", item.guid));

		let group = this.syncGroups.get(sharedFolder);
		if (!group) {
			group = {
				sharedFolder,
				total: 0,
				completed: 0,
				status: "pending",
				downloads: 0,
				syncs: 0,
				completedDownloads: 0,
				completedSyncs: 0,
				failedDownloads: 0,
				failedSyncs: 0,
				skippedDownloads: 0,
				skippedSyncs: 0,
				userDownloads: 0,
				completedUserDownloads: 0,
				failedUserDownloads: 0,
				skippedUserDownloads: 0,
			};
		}
		group.total++;
		group.syncs++;
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);

		this.inProgressSyncs.add(item.guid);

		const syncPromise = new Promise<void>((resolve, reject) => {
			this.syncCompletionCallbacks.set(item.guid, {
				resolve,
				reject,
			});
		});
		this.syncPromises.set(item.guid, syncPromise);

		this.syncQueue.push(queueItem);
		this.sortByPath(this.syncQueue, "sync", "enqueue");
		this.queueStatusChanged.notifyListeners();
		this.processSyncQueue();

		return syncPromise;
	}

	private async enqueueUploadAfterCurrentSync(
		item: SyncFile | Document | Canvas,
	): Promise<void> {
		try {
			await (this.syncPromises.get(item.guid) ?? Promise.resolve());
		} catch {
			// The upload request is the stronger follow-up operation. Let it run
			// even if the weaker sync attempt failed.
		}
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		if (!this.timeProvider) return;
		return this.enqueueUpload(item);
	}

	/**
	 * Enqueues a document for download
	 *
	 * This method adds a document to the download queue and creates/updates
	 * the associated sync group to track progress.
	 *
	 * @param item The document to download
	 * @returns A promise that resolves when the download completes
	 */
	enqueueDownload(
		item: SyncFile | Document | Canvas,
		userVisible = true,
	): Promise<Uint8Array | undefined> {
		// Skip if already in progress — return the same promise all callers share
		if (this.inProgressDownloads.has(item.guid)) {
			this.debug(
				`[enqueueDownload] Item ${item.guid} already in progress, sharing promise`,
			);
			return this.downloadPromises.get(item.guid) ?? Promise.resolve(undefined);
		}

		const sharedFolder = item.sharedFolder;

		// Get or create the sync group for this folder
		let group = this.syncGroups.get(sharedFolder);
		if (!group) {
			group = {
				sharedFolder,
				total: 0,
				completed: 0,
				status: "pending",
				downloads: 0,
				syncs: 0,
				completedDownloads: 0,
				completedSyncs: 0,
				failedDownloads: 0,
				failedSyncs: 0,
				skippedDownloads: 0,
				skippedSyncs: 0,
				userDownloads: 0,
				completedUserDownloads: 0,
				failedUserDownloads: 0,
				skippedUserDownloads: 0,
			};
		}

		// Update the counters for individual document download
		group.downloads++;
		group.total++;
		if (userVisible) {
			group.userDownloads++;
		}
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);

		// Create the queue item
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
			userVisible,
			enqueuedAt: this.timeProvider.now(),
		};
		this.clearFailure(this.failureKey("download", item.guid));

		// Mark as in progress
		this.inProgressDownloads.add(item.guid);

		// Create a promise that will resolve when the download completes
		const downloadPromise = new Promise<Uint8Array | undefined>(
			(resolve, reject) => {
				this.downloadCompletionCallbacks.set(item.guid, { resolve, reject });
			},
		);
		this.downloadPromises.set(item.guid, downloadPromise);

		// Add to the queue and start processing
		this.downloadQueue.push(queueItem);
		this.sortByPath(this.downloadQueue, "download", "enqueue");
		this.queueStatusChanged.notifyListeners();
		this.processDownloadQueue();

		return downloadPromise;
	}

	/**
	 * Enqueues all documents and canvases in a shared folder for synchronization
	 *
	 * This method creates a sync group to track the progress of synchronizing
	 * all documents and canvases in a shared folder, then enqueues each item for sync.
	 * It handles counter initialization correctly to avoid double-counting.
	 *
	 * @param sharedFolder The shared folder to synchronize
	 */
	enqueueSharedFolderSync(sharedFolder: SharedFolder): void {
		// Get all documents and canvases in the shared folder
		const docs = [...sharedFolder.files.values()].filter(isDocument);
		const canvases = [...sharedFolder.files.values()].filter(isCanvas);
		const syncFiles = [...sharedFolder.files.values()].filter(isSyncFile);
		const allItems = [...docs, ...canvases, ...syncFiles].filter((item) =>
			this.shouldEnqueueForSharedFolderSync(item),
		);

		// Create sync group with properly initialized counters
		const group: SyncGroup = {
			sharedFolder,
			total: allItems.length,
			completed: 0,
			status: allItems.length > 0 ? "pending" : "completed",
			downloads: 0,
			syncs: allItems.length,
			completedDownloads: 0,
			completedSyncs: 0,
			failedDownloads: 0,
			failedSyncs: 0,
			skippedDownloads: 0,
			skippedSyncs: 0,
			userDownloads: 0,
			completedUserDownloads: 0,
			failedUserDownloads: 0,
			skippedUserDownloads: 0,
		};

		// Register the group before enqueueing items
		this.syncGroups.set(sharedFolder, group);
		if (allItems.length === 0) return;

		// Sort items by path for consistent sync order
		const sortedDocs = this.sortByPath(allItems, "sync", "group");
		const queueLengthBefore = this.syncQueue.length;

		for (const doc of sortedDocs) {
			this.enqueueForGroupSync(doc);
		}

		if (this.syncQueue.length > queueLengthBefore) {
			this.sortByPath(this.syncQueue, "sync", "group");
			this.queueStatusChanged.notifyListeners();
			this.processSyncQueue();
		}

		this.updateGroupTerminalStatus(group);
		this.syncGroups.set(sharedFolder, group);
	}

	enqueueLCABackfill(sharedFolder: SharedFolder): number {
		if (!sharedFolder.connected) return 0;

		const docs = [...sharedFolder.files.values()]
			.filter(isDocument)
			.filter((doc) => this.shouldEnqueueForLCABackfill(doc))
			.filter((doc) => !this.inProgressSyncs.has(doc.guid));

		if (docs.length === 0) return 0;

		for (const doc of this.sortByPath(docs, "sync", "batch")) {
			void this.enqueueLCABackfillDoc(doc);
		}
		return docs.length;
	}

	private async enqueueLCABackfillDoc(doc: Document): Promise<void> {
		if (this.shouldSkipDocumentSync(doc)) {
			this.clearFailure(this.failureKey("sync", doc.guid));
			return Promise.resolve();
		}

		if (this.inProgressSyncs.has(doc.guid)) {
			this.debug(
				`[enqueueLCABackfillDoc] Item ${doc.guid} already in progress, sharing promise`,
			);
			return this.syncPromises.get(doc.guid) ?? Promise.resolve();
		}

		const sharedFolder = doc.sharedFolder;
		const queueItem: QueueItem = {
			guid: doc.guid,
			path: sharedFolder.getPath(doc.path),
			doc,
			status: "pending",
			sharedFolder,
			userVisible: false,
			enqueuedAt: this.timeProvider.now(),
			syncIntent: "lca-backfill",
		};
		this.clearFailure(this.failureKey("sync", doc.guid));

		let group = this.syncGroups.get(sharedFolder);
		if (!group) {
			group = {
				sharedFolder,
				total: 0,
				completed: 0,
				status: "pending",
				downloads: 0,
				syncs: 0,
				completedDownloads: 0,
				completedSyncs: 0,
				failedDownloads: 0,
				failedSyncs: 0,
				skippedDownloads: 0,
				skippedSyncs: 0,
				userDownloads: 0,
				completedUserDownloads: 0,
				failedUserDownloads: 0,
				skippedUserDownloads: 0,
			};
		}
		group.total++;
		group.syncs++;
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);

		this.inProgressSyncs.add(doc.guid);

		const syncPromise = new Promise<void>((resolve, reject) => {
			this.syncCompletionCallbacks.set(doc.guid, {
				resolve,
				reject,
			});
		});
		this.syncPromises.set(doc.guid, syncPromise);

		this.syncQueue.push(queueItem);
		this.sortByPath(this.syncQueue, "sync", "enqueue");
		this.queueStatusChanged.notifyListeners();
		this.processSyncQueue();

		return syncPromise;
	}

	enqueueRemoteHeadSyncs(
		sharedFolder: SharedFolder,
		guids: Iterable<string>,
	): number {
		if (!sharedFolder.connected) return 0;

		const advertisedGuids = new Set(guids);
		if (advertisedGuids.size === 0) return 0;

		const docs = [...sharedFolder.files.values()]
			.filter(isDocument)
			.filter((doc) => advertisedGuids.has(doc.guid))
			.filter((doc) => !this.inProgressSyncs.has(doc.guid))
			.filter((doc) => this.shouldEnqueueForRemoteHeadSync(doc));

		for (const doc of this.sortByPath(docs, "sync", "batch")) {
			void this.enqueueSync(doc);
		}

		// Canvases have no HSM sync session; an advertised head that is
		// ahead of the local ydoc downloads through getCanvas, which applies
		// the update and flushes to disk when the local copy is untouched.
		// An open view carries its own connection and save path.
		const canvases = [...sharedFolder.files.values()]
			.filter(isCanvas)
			.filter((canvas) => advertisedGuids.has(canvas.guid))
			.filter((canvas) => !canvas.userLock)
			.filter((canvas) => !this.downloadPromises.has(canvas.guid))
			.filter((canvas) => {
				const mergeManager = sharedFolder.mergeManager;
				if (!mergeManager) return true;
				return !mergeManager.isServerAdvertisedInSync(
					canvas.guid,
					snapshotFromDoc(canvas.ydoc).snapshot,
				);
			});
		for (const canvas of canvases) {
			void this.enqueueCanvasDownload(canvas, false);
		}

		return docs.length + canvases.length;
	}

	enqueueAdvertisedLCABackfills(
		sharedFolder: SharedFolder,
		guids: Iterable<string>,
	): number {
		if (!sharedFolder.connected) return 0;

		const advertisedGuids = new Set(guids);
		if (advertisedGuids.size === 0) return 0;

		const docs = [...sharedFolder.files.values()]
			.filter(isDocument)
			.filter((doc) => advertisedGuids.has(doc.guid))
			.filter((doc) => !this.inProgressSyncs.has(doc.guid))
			.filter((doc) => this.shouldEnqueueForLCABackfill(doc));

		for (const doc of this.sortByPath(docs, "sync", "batch")) {
			void this.enqueueLCABackfillDoc(doc);
		}
		return docs.length;
	}

	private shouldEnqueueForSharedFolderSync(
		item: Document | Canvas | SyncFile,
	): boolean {
		if (isCanvas(item)) {
			const mergeManager = item.sharedFolder.mergeManager;
			if (!mergeManager) return true;
			return !mergeManager.isServerAdvertisedInSync(
				item.guid,
				snapshotFromDoc(item.ydoc).snapshot,
			);
		}
		if (!isDocument(item)) return true;

		const hsm = item.hsm;
		if (!hsm) return true;
		if (hsm.getSyncStatus().status === "conflict") return false;
		if (!hsm.state.lca) return true;
		if (hsm.getSyncStatus().status !== "synced") return true;

		const mergeManager = item.sharedFolder.mergeManager;
		if (!mergeManager) return true;

		return !mergeManager.isServerAdvertisedInSync(item.guid);
	}

	private shouldEnqueueForRemoteHeadSync(doc: Document): boolean {
		if (this.shouldSkipDocumentSync(doc)) return false;
		if (doc.hsm?.hasFork()) return false;
		const mergeManager = doc.sharedFolder.mergeManager;
		if (!mergeManager) return false;
		if (mergeManager.isServerAdvertisedRemoteAhead(doc.guid)) return true;
		// A document edited in the editor while offline and closed before
		// reconnect holds local ops the server lacks. It has no fork and no
		// open editor, so no other path pushes those ops — run a sync
		// session to flush them. Skip docs with an open editor or a live
		// provider: their own connection already carries local ops.
		if (doc.userLock || mergeManager.isActive(doc.guid)) return false;
		if (doc.intent === "connected") return false;
		if (!mergeManager.isServerAdvertisedOutOfSync(doc.guid)) {
			this.localAheadAttempts.delete(doc.guid);
			return false;
		}
		const lastAttempt = this.localAheadAttempts.get(doc.guid);
		const now = this.timeProvider.now();
		if (
			lastAttempt !== undefined &&
			now - lastAttempt < LOCAL_AHEAD_RETRY_INTERVAL_MS
		) {
			return false;
		}
		this.localAheadAttempts.set(doc.guid, now);
		return true;
	}

	private shouldEnqueueForLCABackfill(doc: Document): boolean {
		const hsm = doc.hsm;
		if (!hsm) return false;
		if (doc.sharedFolder.isPendingUpload(doc.path)) return false;
		if (hsm.isActive()) return false;
		if (hsm.state.lca) return false;
		if (hsm.hasFork()) return false;
		if (hsm.getSyncStatus().status === "pending") return true;
		return doc.sharedFolder.mergeManager?.isServerAdvertisedOutOfSync(doc.guid)
			?? false;
	}

	/**
	 * Enqueues an item for synchronization as part of a group sync operation
	 *
	 * This method is similar to enqueueSync() but doesn't increment any counters
	 * since they're already properly initialized in enqueueSharedFolderSync().
	 * This prevents double-counting of operations in progress tracking.
	 *
	 * @param item The item to synchronize (Document, Canvas, or SyncFile)
	 * @returns A promise that resolves when the sync completes
	 * @private Used internally by enqueueSharedFolderSync
	 */
	private async enqueueForGroupSync(
		item: Document | Canvas | SyncFile,
	): Promise<void> {
		if (this.shouldSkipDocumentSync(item)) {
			this.clearFailure(this.failureKey("sync", item.guid));
			return Promise.resolve();
		}

		// Skip if already in progress — return the same promise all callers share
		if (this.inProgressSyncs.has(item.guid)) {
			this.debug(
				`[enqueueForGroupSync] Item ${item.guid} already in progress, sharing promise`,
			);
			return this.syncPromises.get(item.guid) ?? Promise.resolve();
		}

		const sharedFolder = item.sharedFolder;
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
			userVisible: false,
			enqueuedAt: this.timeProvider.now(),
		};
		this.clearFailure(this.failureKey("sync", item.guid));

		this.inProgressSyncs.add(item.guid);

		const syncPromise = new Promise<void>((resolve, reject) => {
			this.syncCompletionCallbacks.set(item.guid, {
				resolve,
				reject,
			});
		});
		this.syncPromises.set(item.guid, syncPromise);

		this.syncQueue.push(queueItem);

		return syncPromise;
	}

	private getAuthHeader(clientToken: ClientToken) {
		return {
			Authorization: `Bearer ${clientToken.token}`,
			...getRelayRequestHeaders(),
		};
	}

	private getBaseUrl(
		clientToken: ClientToken,
		entity: S3RemoteDocument | S3RemoteCanvas,
	): string {
		const urlObj = new URL(clientToken.url);
		urlObj.protocol = "https:";
		const parts = urlObj.pathname.split("/");
		parts.pop();
		parts.push(clientToken.docId);
		urlObj.pathname = parts.join("/");
		const baseUrl =
			clientToken.baseUrl?.replace(/\/$/, "") || urlObj.toString();

		return baseUrl;
	}

	async downloadItem(item: Document | Canvas): Promise<RequestUrlResponse> {
		const getId = (entity: S3RemoteCanvas | S3RemoteDocument) => {
			if (entity instanceof S3RemoteCanvas) {
				return entity.canvasId;
			}
			return entity.documentId;
		};
		const entity = item.s3rn;
		this.log("[downloadItem]", item.path, `${S3RN.encode(entity)}`);

		if (
			!(entity instanceof S3RemoteDocument || entity instanceof S3RemoteCanvas)
		) {
			throw new Error(`Unable to decode S3RN: ${S3RN.encode(entity)}`);
		}

		const clientToken = await item.getProviderToken();
		const headers = this.getAuthHeader(clientToken);
		const baseUrl = this.getBaseUrl(clientToken, entity);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrlWithMetrics({
			url: url,
			method: "GET",
			headers: headers,
			throw: false,
			relayNetworkDomain: "relay",
		});

		if (response.status === 200) {
			this.debug("[downloadItem]", getId(entity), response.status);
		} else {
			this.error(
				"[downloadItem]",
				getId(entity),
				url,
				response.status,
				response.text,
			);
			throw new Error(`Unable to download item: ${S3RN.encode(entity)}`);
		}
		return response;
	}

	/**
	 * Download raw CRDT bytes for a document by guid, without needing a
	 * Document instance. Used by the SharedFolder guid-remap path, where
	 * the server's content must be fetched *before* the old Document is
	 * destroyed — a failure here leaves old state intact and retriable.
	 *
	 * Does not participate in the download queue, syncGroups, or
	 * in-progress tracking. It is a bare HTTP fetch.
	 *
	 * Returns undefined if the server has the guid registered but no
	 * peer has uploaded content yet (empty contents, empty users map).
	 */
	async downloadByGuid(
		sharedFolder: SharedFolder,
		guid: string,
		path: string,
	): Promise<Uint8Array | undefined> {
		const entity = new S3RemoteDocument(
			sharedFolder.relayId!,
			sharedFolder.guid,
			guid,
		);
		this.log("[downloadByGuid]", path, S3RN.encode(entity));

		const clientToken = await sharedFolder.tokenStore.getToken(
			S3RN.encode(entity),
			path,
			() => {},
		);
		const headers = this.getAuthHeader(clientToken);
		const baseUrl = this.getBaseUrl(clientToken, entity);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrlWithMetrics({
			url,
			method: "GET",
			headers,
			throw: false,
			relayNetworkDomain: "relay",
		});

		if (response.status !== 200) {
			this.error(
				"[downloadByGuid]",
				path,
				url,
				response.status,
				response.text,
			);
			throw new Error(
				`downloadByGuid: status ${response.status} for ${S3RN.encode(entity)}`,
			);
		}

		const updateBytes = new Uint8Array(response.arrayBuffer);

		// Peek at the update in a throwaway doc to detect empty-server.
		const tmpDoc = new Y.Doc();
		Y.applyUpdate(tmpDoc, updateBytes);
		if (isEmptyDoc(tmpDoc)) {
			this.log(
				"[downloadByGuid] server has guid registered but no content",
				path,
			);
			return undefined;
		}
		return updateBytes;
	}

	async syncDocumentWebsocket(doc: Document | Canvas): Promise<boolean> {
		if (doc.destroyed) return false;
		this.log(`[syncDocWS] start: ${doc.path} guid=${doc.guid} intent=${doc.intent} connected=${doc.connected}`);
		if (this.isSyncCancelledForDoc(doc)) return false;
		// if the local file is synced, then we do the two step process
		if (isCanvas(doc)) {
			// Store the exported canvas data rather than a stringified version
			const currentCanvasData = Canvas.exportCanvasData(doc.ydoc);
			let canvasContentsMismatch = false;
			try {
				const currentFileContents = await doc.sharedFolder.read(doc);

				// Only proceed with update if file matches current ydoc state
				let contentsMatch = false;
				if (isCanvas(doc) && currentCanvasData) {
					// For canvas, use deep object comparison instead of string equality
					const currentFileJson = currentFileContents
						? JSON.parse(currentFileContents)
						: { nodes: [], edges: [] };
					contentsMatch = areCanvasDataEqual(currentCanvasData, currentFileJson);
					if (
						!contentsMatch &&
						await this.repairStaleCanvasText(doc, currentFileJson)
					) {
						contentsMatch = true;
					}
					if (!contentsMatch && currentFileContents) {
						canvasContentsMismatch = true;
					}
				}
			} catch (e) {
				// File does not exist
			}
			if (canvasContentsMismatch) {
				throw new Error(
					"Canvas file does not match local sync state. Open the canvas and resolve the local changes before syncing.",
				);
			}
		}
		const sharedFolder = doc.sharedFolder;
		const refreshQueueKey = S3RN.encode(doc.s3rn);
		const isActive = doc.userLock || sharedFolder?.mergeManager?.isActive(doc.guid);
		const startedDisconnected = doc.intent === "disconnected";
		const hadProviderIntegration = isDocument(doc) && doc.hasProviderIntegration();
		const acquiredIdleIntegration =
			isDocument(doc) && !isActive
				? doc.ensureIdleProviderIntegration({
						freshRemoteDoc: !!doc.hsm?.hasFork(),
					})
				: false;
		const shouldCleanupIdleSession = () =>
			startedDisconnected &&
			!(doc.userLock || sharedFolder?.mergeManager?.isActive(doc.guid));
		const cleanupIdleSession = () => {
			if (isDocument(doc)) {
				if (acquiredIdleIntegration) {
					doc.destroyIdleProviderIntegration();
					if (shouldCleanupIdleSession()) {
						sharedFolder?.tokenStore.removeFromRefreshQueue(refreshQueueKey);
					}
					return;
				}
				if (!shouldCleanupIdleSession()) return;
				if (hadProviderIntegration || doc.hasProviderIntegration()) {
					return;
				}
			}
			if (!shouldCleanupIdleSession()) return;
			doc.disconnect();
			sharedFolder?.tokenStore.removeFromRefreshQueue(refreshQueueKey);
		};
		if (doc.destroyed) return false;
		const connected = await doc.connect();
		if (!connected) {
			if (shouldCleanupIdleSession()) {
				cleanupIdleSession();
			}
			if (this.isSyncCancelledForDoc(doc)) return false;
			throw new RetryableProviderSyncError(
				`Provider connection is not ready for ${this.fileName(doc.path)}`,
			);
		}
		if (this.isSyncCancelledForDoc(doc)) {
			if (shouldCleanupIdleSession()) {
				cleanupIdleSession();
			}
			return false;
		}
		// Always wait for provider sync — _providerSynced fast-path resolves
		// immediately if already synced.  Connected does not imply synced.
		// Timeout prevents hanging the sync queue if the connection drops.
		const SYNC_TIMEOUT_MS = 10_000;
		let timerId: number | undefined;
		let cancelTimerId: number | undefined;
		let providerSyncFailure: unknown;
		const synced = await Promise.race([
			doc.onceProviderSynced().then(
				() => true,
				(e) => {
					providerSyncFailure = e;
					return false;
				},
			),
			new Promise<false>((resolve) => {
				timerId = this.timeProvider.setTimeout(
					() => resolve(false),
					SYNC_TIMEOUT_MS,
				);
			}),
			new Promise<false>((resolve) => {
				cancelTimerId = this.timeProvider.setInterval(() => {
					if (this.isSyncCancelledForDoc(doc)) resolve(false);
				}, 100);
			}),
		]);
		if (timerId !== undefined) this.timeProvider.clearTimeout(timerId);
		if (cancelTimerId !== undefined) this.timeProvider.clearInterval(cancelTimerId);
		if (!synced) {
			if (shouldCleanupIdleSession()) {
				cleanupIdleSession();
			}
			if (this.isSyncCancelledForDoc(doc)) return false;
			if (providerSyncFailure) {
				this.warn(
					`[syncDocWS] provider sync failed: ${doc.path} guid=${doc.guid}: ${this.errorMessage(providerSyncFailure)}`,
				);
				throw new RetryableProviderSyncError(
					`Provider sync is not ready for ${this.fileName(doc.path)}: ${this.errorMessage(providerSyncFailure)}`,
				);
			} else {
				this.warn(`[syncDocWS] provider sync timed out: ${doc.path} guid=${doc.guid}`);
				throw new RetryableProviderSyncError(
					`Provider sync timed out for ${this.fileName(doc.path)}`,
				);
			}
		}

		if (isDocument(doc)) {
			await this.maybeBootstrapDocumentLCA(doc);
		}

		// promise can take some time
		if (shouldCleanupIdleSession()) {
			cleanupIdleSession();
		}
		return true;
	}

	/**
	 * Enqueues a document to be downloaded from the server
	 * @param canvas The canvas to download
	 * @returns A promise that resolves when the download completes
	 */
	enqueueCanvasDownload(
		canvas: Canvas,
		userVisible = true,
	): Promise<Uint8Array | undefined> {
		return this.enqueueDownload(canvas, userVisible);
	}

	async getCanvas(canvas: Canvas, retry = 3, wait = 3000) {
		try {
			// The pre-download export identifies a disk file that simply
			// trails the server: matching it counts as untouched when
			// deciding whether the flush is safe.
			const preUpdate = Canvas.exportCanvasData(canvas.ydoc);

			const response = await this.downloadItem(canvas);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			this.log("[getCanvas] applying content from server");
			Y.applyUpdate(canvas.ydoc, updateBytes);

			const outcome = await canvas.flushIfClean(preUpdate);
			if (outcome === "diverged") {
				this.log("Skipping flush - file requires merge conflict resolution.");
			} else if (outcome === "flushed") {
				this.log("[getCanvas] flushed");
			}
		} catch (e) {
			this.logError("[getCanvas] failed", e);
			throw e;
		}
	}

	private async getDocument(doc: Document): Promise<Uint8Array | undefined> {
		if (doc.sharedFolder.serverEmptyTerminal(doc.guid)) {
			this.debug(
				`[getDocument] skipped ${doc.path}: server has no content for guid; awaiting server evidence`,
			);
			return undefined;
		}
		try {
			const response = await this.downloadItem(doc);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			// Validate: reject uninitialized documents.
			const newDoc = new Y.Doc();
			Y.applyUpdate(newDoc, updateBytes);

			if (isEmptyDoc(newDoc)) {
				if (doc.text) {
					this.log(
						"[getDocument] server CRDT empty, local has content — uploading",
					);
					this.enqueueSync(doc);
					return undefined;
				}
				// The server pushes a document.updated event once a peer
				// uploads content, which re-enables downloads for the guid —
				// no timer-based retry needed.
				doc.sharedFolder.recordServerEmpty(doc.guid);
				this.log(
					"[getDocument] Server contains uninitialized document. Waiting for peer to upload.",
				);
				return undefined;
			}

			this.log("[getDocument] applying content from server");
			Y.applyUpdate(doc.ydoc, updateBytes);
			doc.hsm?.setRemoteDoc(doc.ydoc);
			await this.maybeBootstrapDocumentLCA(doc);
			this.notifyDownloadedRemoteHead(doc);
			return updateBytes;
		} catch (e) {
			this.logError("[getDocument] failed", e);
			throw e;
		}
	}

	private notifyDownloadedRemoteHead(doc: Document): void {
		const hsm = doc.hsm;
		if (!hsm) return;

		hsm.send({ type: "PROVIDER_SYNCED" });
	}

	private async maybeBootstrapDocumentLCA(doc: Document): Promise<void> {
		const hsm = doc.hsm;
		if (!hsm || hsm.state.lca || hsm.isActive()) return;

		// A first download has not written the file yet — the applied server
		// content materializes it through the WRITE_DISK effect. With no file
		// on disk there is no on-disk content to reconcile, so there is no
		// last-common-ancestor to recover from disk. Skip rather than read,
		// which would throw for the absent TFile and fail the download for a
		// doc that is simply arriving for the first time. The LCA is
		// established once the file lands, through the idle-merge path.
		if (!doc.tfile) {
			this.debug(
				`[bootstrapLCA] skipped for ${doc.path}: file not yet materialized`,
			);
			return;
		}

		let releaseLease: () => void = () => {};
		try {
			const mergeManager = doc.sharedFolder.mergeManager;
			if (mergeManager?.getHibernationState(doc.guid) === "hibernated") {
				releaseLease =
					mergeManager.wake(doc.guid, doc.ensureRemoteDoc(), {
						lease: true,
					}) ?? releaseLease;
				await hsm.awaitPersistenceReady();
			}

			const diskState = await doc.readDiskContent();
			const repaired = await hsm.bootstrapLCAFromDisk(diskState);
			if (!repaired && hsm.getSyncStatus().status === "pending") {
				if (!hsm.hasPersistenceUserData()) {
					this.debug(
						`[bootstrapLCA] deferred for ${doc.path}: awaiting local CRDT enrollment`,
					);
					return;
				}
				this.debug(
					`[bootstrapLCA] skipped for ${doc.path}: local CRDT is not enrolled or remote state is not ready`,
				);
			}
		} catch (e) {
			this.warn(
				`[bootstrapLCA] failed for ${doc.path}: ${this.errorMessage(e)}`,
				e,
			);
			throw e;
		} finally {
			releaseLease();
		}
	}

	private async syncFile(file: SyncFile) {
		await file.sync();
	}

	private async getSyncFile(file: SyncFile) {
		await file.pull();
	}

	private async syncDocument(doc: Document | Canvas): Promise<void> {
		if (doc.destroyed) {
			return;
		}
		if (this.shouldSkipDocumentSync(doc)) {
			return;
		}
		try {
			if (isDocument(doc) || isCanvas(doc)) {
				const synced = await this.syncDocumentWebsocket(doc);
				if (!synced) {
					if (this.isSyncCancelledForDoc(doc)) return;
					throw new Error(`Unable to sync ${this.fileName(doc.path)}`);
				}
			}
		} catch (e) {
			if (!isRetryableSyncError(e)) {
				this.logError("[syncDocument] failed", e);
			}
			throw e;
		}
	}

	private async syncDocumentUpload(doc: Document | Canvas): Promise<void> {
		// The lease from upload preparation must survive the websocket sync
		// and the final content assert: hibernation mid-upload detaches the
		// remoteDoc, which surfaces as an empty remote after preparation.
		let releaseLease: () => void = () => {};
		try {
			if (isDocument(doc) && doc.hsm) {
				releaseLease = await this.prepareDocumentUpload(doc);
			}
			await this.syncDocument(doc);
			if (isDocument(doc) && doc.hsm) {
				this.assertUploadedDocumentHasRemoteContent(doc);
			}
		} finally {
			releaseLease();
		}
	}

	private async syncDocumentLCABackfill(doc: Document): Promise<void> {
		if (doc.destroyed || this.shouldSkipDocumentSync(doc)) {
			return;
		}

		const hsm = doc.hsm;
		if (!hsm || hsm.state.lca || hsm.isActive() || hsm.hasFork()) {
			return;
		}

		let updateBytes: Uint8Array | undefined;
		try {
			updateBytes = await this.downloadByGuid(
				doc.sharedFolder,
				doc.guid,
				doc.path,
			);
		} catch (error) {
			throw new RetryableProviderSyncError(
				`LCA backfill download failed for ${this.fileName(doc.path)}: ${this.errorMessage(error)}`,
			);
		}
		if (!updateBytes) {
			throw new RetryableProviderSyncError(
				`Remote document is empty while backfilling LCA: ${this.fileName(doc.path)}`,
			);
		}

		const validationDoc = new Y.Doc();
		try {
			Y.applyUpdate(validationDoc, updateBytes);
			if (isEmptyDoc(validationDoc)) {
				throw new RetryableProviderSyncError(
					`Remote document is empty while backfilling LCA: ${this.fileName(doc.path)}`,
				);
			}
		} finally {
			validationDoc.destroy();
		}

		const remoteDoc = doc.ensureRemoteDoc();
		Y.applyUpdate(remoteDoc, updateBytes, remoteDoc);
		const mergeManager = doc.sharedFolder.mergeManager;
		let releaseLease: () => void = () => {};
		if (mergeManager) {
			releaseLease =
				mergeManager.wake(doc.guid, remoteDoc, { lease: true }) ??
				releaseLease;
		} else {
			hsm.setRemoteDoc(remoteDoc);
		}
		try {
			const diskState = await doc.readDiskContent();
			const settled = await hsm.bootstrapLCAFromDisk(diskState);
			if (!settled && hsm.getSyncStatus().status === "pending") {
				if (!hsm.hasPersistenceUserData()) {
					this.debug(
						`[lca-backfill] deferred for ${doc.path}: awaiting local enrollment`,
					);
					return;
				}
				this.debug(
					`[lca-backfill] deferred for ${doc.path}: local or remote state is not ready`,
				);
			}
		} finally {
			releaseLease();
		}
	}

	/**
	 * Wake the doc and encode its localDoc into the remoteDoc for upload.
	 * Returns the warm-lease release; the caller holds it until the upload
	 * resolves so hibernation cannot tear the doc down mid-pipeline.
	 */
	private async prepareDocumentUpload(doc: Document): Promise<() => void> {
		const hsm = doc.hsm;
		if (!hsm) return () => {};
		if (hsm.hasFork()) {
			throw new Error(`Cannot upload ${this.fileName(doc.path)} while a fork exists`);
		}

		const remoteDoc = doc.ensureRemoteDoc();
		const mergeManager = doc.sharedFolder.mergeManager;
		let releaseLease: () => void = () => {};
		if (!doc.userLock && !mergeManager?.isActive(doc.guid)) {
			if (mergeManager) {
				releaseLease =
					mergeManager.wake(doc.guid, remoteDoc, {
						lease: true,
					}) ?? releaseLease;
			}
		} else {
			hsm.setRemoteDoc(remoteDoc);
		}
		try {
			await hsm.awaitPersistenceReady();

			if (hsm.hasFork()) {
				throw new Error(`Cannot upload ${this.fileName(doc.path)} while a fork exists`);
			}
			const localDoc = hsm.getLocalDoc();
			if (!localDoc) {
				throw new RetryableProviderSyncError(
					`Local document is not ready for upload: ${this.fileName(doc.path)}`,
				);
			}

			Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc), hsm);
			hsm.setRemoteDoc(remoteDoc);
			this.assertUploadedDocumentHasRemoteContent(doc);
			return releaseLease;
		} catch (e) {
			releaseLease();
			throw e;
		}
	}

	private assertUploadedDocumentHasRemoteContent(doc: Document): void {
		const remoteDoc = doc.hsm?.getRemoteDoc() ?? doc.remoteDocOrNull;
		if (!remoteDoc || isEmptyDoc(remoteDoc)) {
			throw new RetryableProviderSyncError(
				`Remote document is empty after upload preparation: ${this.fileName(doc.path)}`,
			);
		}
	}

	subscribeToSync(
		callback: Subscriber<ObservableSet<QueueItem>>,
	): Unsubscriber {
		return this.activeSync.subscribe(callback);
	}

	subscribeToDownloads(
		callback: Subscriber<ObservableSet<QueueItem>>,
	): Unsubscriber {
		return this.activeDownloads.subscribe(callback);
	}

	subscribeToSyncGroups(
		callback: Subscriber<ObservableMap<SharedFolder, SyncGroup>>,
	): Unsubscriber {
		return this.syncGroups.subscribe(callback);
	}

	subscribeToProgress(callback: Subscriber<SyncProgress>): Unsubscriber {
		const handler = () => {
			callback(this.getOverallProgress());
		};

		const unsub1 = this.activeSync.subscribe(() => handler());
		const unsub2 = this.activeDownloads.subscribe(() => handler());
		const unsub3 = this.syncGroups.subscribe(() => handler());

		return () => {
			unsub1();
			unsub2();
			unsub3();
		};
	}

	/**
	 * Subscribes to progress updates for a specific shared folder
	 *
	 * @param sharedFolder The shared folder to monitor
	 * @param callback The function to call when progress changes
	 * @returns A function to unsubscribe
	 */
	subscribeToGroupProgress(
		sharedFolder: SharedFolder,
		callback: Subscriber<GroupProgress | null>,
	): Unsubscriber {
		return this.syncGroups.subscribe(() => {
			callback(this.getGroupProgress(sharedFolder));
		});
	}

	subscribeToFolderSyncSnapshot(
		sharedFolder: SharedFolder,
		callback: Subscriber<FolderSyncSnapshot>,
	): Unsubscriber {
		const state = this.getFolderSyncSnapshotSubscription(sharedFolder);
		state.subscribers.add(callback);
		if (state.latestSnapshot) callback(state.latestSnapshot);

		return () => {
			state.subscribers.delete(callback);
			if (state.subscribers.size === 0) {
				this.disposeFolderSyncSnapshotSubscription(sharedFolder, state);
			}
		};
	}

	private getFolderSyncSnapshotSubscription(
		sharedFolder: SharedFolder,
	): FolderSyncSnapshotSubscription {
		const existing = this.folderSyncSnapshotSubscriptions.get(sharedFolder);
		if (existing) return existing;

		const state: FolderSyncSnapshotSubscription = {
			smoother: null as any,
			subscribers: new Set(),
			latestSnapshot: null,
			unsubscribers: [],
			emit: () => {},
		};
		state.smoother = new FolderSyncSnapshotSmoother(
			this.timeProvider,
			(snapshot) => {
				state.latestSnapshot = snapshot;
				for (const subscriber of state.subscribers) {
					subscriber(snapshot);
				}
			},
		);
		state.emit = () => {
			state.smoother.update(this.getFolderSyncSnapshot(sharedFolder));
		};
		const folderStateKey = { type: "folder-sync-snapshot", sharedFolder };
		state.unsubscribers = [
			this.activeSync.on(state.emit),
			this.activeDownloads.on(state.emit),
			this.syncGroups.on(state.emit),
			this.failures.on(state.emit),
			this.folderResyncs.on(state.emit),
			this.queueStatusChanged.on(state.emit),
			sharedFolder.subscribe(folderStateKey, state.emit),
		];
		this.folderSyncSnapshotSubscriptions.set(sharedFolder, state);
		state.emit();
		return state;
	}

	private disposeFolderSyncSnapshotSubscription(
		sharedFolder: SharedFolder,
		state: FolderSyncSnapshotSubscription,
	): void {
		if (this.folderSyncSnapshotSubscriptions.get(sharedFolder) !== state) return;
		this.folderSyncSnapshotSubscriptions.delete(sharedFolder);
		state.unsubscribers.forEach((unsubscribe) => unsubscribe());
		state.smoother.destroy();
		state.subscribers.clear();
		state.latestSnapshot = null;
	}

	/**
	 * Pauses all sync and download queue processing
	 *
	 * This method temporarily halts processing of sync and download queues.
	 * The queues can be resumed by calling resume().
	 */
	pause(): void {
		this.isPaused = true;
		this.queueStatusChanged.notifyListeners();
	}

	/**
	 * Resumes sync and download queue processing
	 *
	 * This method resumes processing of sync and download queues after
	 * they have been paused.
	 */
	resume(): void {
		this.debug("starting");
		this.isPaused = false;
		this.queueStatusChanged.notifyListeners();
		this.processSyncQueue();
		this.processDownloadQueue();
	}
	start = this.resume;

	/**
	 * Gets the current status of sync and download queues
	 *
	 * @returns An object with queue statistics
	 */
	getQueueStatus(): QueueStatus {
		return {
			syncsQueued: this.syncQueue.length,
			syncsActive: this.activeSync.size,
			downloadsQueued: this.downloadQueue.length,
			downloadsActive: this.activeDownloads.size,
			isPaused: this.isPaused,
		};
	}

	subscribeToQueueStatus(callback: Subscriber<QueueStatus>): Unsubscriber {
		const emit = () => callback(this.getQueueStatus());
		const unsubscribers = [
			this.activeSync.subscribe(emit),
			this.activeDownloads.subscribe(emit),
			this.syncGroups.subscribe(emit),
			this.failures.subscribe(emit),
			this.queueStatusChanged.subscribe(emit),
		];

		return () => {
			unsubscribers.forEach((unsubscribe) => unsubscribe());
		};
	}

	/**
	 * Destroys this instance and cleans up all resources
	 *
	 * This method cleans up all resources used by this instance,
	 * including rejecting pending promises, destroying observable
	 * collections, and clearing queues.
	 */
	destroy(): void {
		// Reject all pending sync promises
		for (const [guid, callback] of this.syncCompletionCallbacks) {
			callback.reject(new Error("BackgroundSync destroyed"));
			this.syncCompletionCallbacks.delete(guid);
		}

		// Reject all pending download promises
		for (const [guid, callback] of this.downloadCompletionCallbacks) {
			callback.reject(new Error("BackgroundSync destroyed"));
			this.downloadCompletionCallbacks.delete(guid);
		}

		for (const [sharedFolder, state] of [
			...this.folderSyncSnapshotSubscriptions.entries(),
		]) {
			this.disposeFolderSyncSnapshotSubscription(sharedFolder, state);
		}

		for (const unsubscribe of this.folderQueueWakeups.values()) {
			unsubscribe();
		}
		this.folderQueueWakeups.clear();

		// Destroy observable collections
		this.activeSync.destroy();
		this.activeDownloads.destroy();
		this.folderResyncs.destroy();
		this.syncGroups.destroy();
		this.failures.destroy();
		this.queueStatusChanged.destroy();

		// Clear queues and tracking
		this.syncQueue = [];
		this.downloadQueue = [];
		this.inProgressSyncs.clear();
		this.inProgressDownloads.clear();
		this.syncPromises.clear();
		this.downloadPromises.clear();
		this.loggedItems.clear();

		// Clean up references
		this.loginManager = null as any;
		this.timeProvider = null as any;

		// Unsubscribe from all subscriptions
		this.subscriptions.forEach((off) => off());
	}

	private recordFailure(
		kind: BackgroundSyncFailure["kind"],
		item: QueueItem,
		error: unknown,
	): void {
		const id = this.failureKey(kind, item.guid);
		this.setFailure({
			id,
			guid: item.guid,
			path: item.doc.path,
			kind,
			message: this.errorMessage(error),
			sharedFolder: item.sharedFolder,
		});
	}

	private setFailure(failure: BackgroundSyncFailure): void {
		const existing = this.failures.get(failure.id);
		if (
			existing &&
			existing.guid === failure.guid &&
			existing.path === failure.path &&
			existing.kind === failure.kind &&
			existing.message === failure.message &&
			existing.sharedFolder === failure.sharedFolder
		) {
			return;
		}
		this.failures.set(failure.id, failure);
	}

	private failureKey(kind: BackgroundSyncFailure["kind"], guid: string): string {
		return `${kind}:${guid}`;
	}

	private errorMessage(error: unknown): string {
		return formatUserFacingError(error);
	}

	private logError(context: string, error: unknown): void {
		this.error(`${context}: ${this.errorMessage(error)}`, error);
	}

	private fileName(path: string): string {
		const normalized = path.replace(/\\/g, "/");
		const parts = normalized.split("/").filter(Boolean);
		return parts[parts.length - 1] || "file";
	}
}
