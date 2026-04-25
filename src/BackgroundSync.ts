import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { LoginManager } from "./LoginManager";
import * as Y from "yjs";
import { S3RN, S3RemoteCanvas, S3RemoteDocument } from "./S3RN";
import { isDocument, type Document } from "./Document";
import { isCanvas } from "./Canvas";
import type { TimeProvider } from "./TimeProvider";
import { HasLogging, RelayInstances, metrics } from "./debug";
import type { Subscriber, Unsubscriber } from "./observable/Observable";
import { ObservableSet } from "./observable/ObservableSet";
import { ObservableMap } from "./observable/ObservableMap";
import type { SharedFolder, SharedFolders } from "./SharedFolder";
import { compareFilePaths } from "./FolderSort";
import type { ClientToken } from "./client/types";
import { Canvas } from "./Canvas";
import { areObjectsEqual } from "./areObjectsEqual";
import type { CanvasData } from "./CanvasView";
import { SyncFile, isSyncFile } from "./SyncFile";
import { isEmptyDoc } from "./merge-hsm/state-vectors";

export interface QueueItem {
	guid: string;
	path: string;
	doc: Document | Canvas | SyncFile;
	status: "pending" | "running" | "completed" | "failed";
	sharedFolder: SharedFolder;
	userVisible: boolean;
}

export interface SyncGroup {
	sharedFolder: SharedFolder;
	total: number; // Total operations (syncs + downloads)
	completed: number; // Total completed operations
	status: "pending" | "running" | "completed" | "failed";
	downloads: number;
	syncs: number;
	completedDownloads: number;
	completedSyncs: number;
	userDownloads: number;
	completedUserDownloads: number;
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

export class BackgroundSync extends HasLogging {
	public activeSync = new ObservableSet<QueueItem>();
	public activeDownloads = new ObservableSet<QueueItem>();
	public syncGroups = new ObservableMap<SharedFolder, SyncGroup>();

	private syncQueue: QueueItem[] = [];
	private downloadQueue: QueueItem[] = [];
	private isProcessingSync = false;
	private isProcessingDownloads = false;
	private isPaused = true;
	private inProgressSyncs = new Set<string>();
	private inProgressDownloads = new Set<string>();
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
		this.timeProvider.setInterval(() => {
			this.processSyncQueue();
			this.processDownloadQueue();
		}, 1000);

		// Add polling timer for disk changes (poll all folders)
		this.timeProvider.setInterval(() => {
			this.sharedFolders.forEach((folder) => {
				folder.poll();
			});
		}, 5000); // Poll every 5 seconds
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

	getOverallProgress(): SyncProgress {
		let totalItems = 0;
		let completedItems = 0;
		let syncItems = 0;
		let completedSyncs = 0;
		let downloadItems = 0;
		let completedDownloads = 0;

		this.syncGroups.forEach((group) => {
			totalItems += group.total;
			completedItems += group.completed;
			syncItems += group.syncs;
			completedSyncs += group.completedSyncs;
			downloadItems += group.downloads;
			completedDownloads += group.completedDownloads;
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

		const percent = group.total > 0 ? (group.completed / group.total) * 100 : 0;
		const syncPercent =
			group.syncs > 0 ? (group.completedSyncs / group.syncs) * 100 : 0;
		const downloadPercent =
			group.downloads > 0
				? (group.completedDownloads / group.downloads) * 100
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
	 * Used when enableNewSyncStatus is on to show only user-visible downloads.
	 */
	getUserVisibleProgress(sharedFolder: SharedFolder): GroupProgress | null {
		const group = this.syncGroups.get(sharedFolder);
		if (!group) return null;

		const total = group.userDownloads;
		const completed = group.completedUserDownloads;
		const percent = total > 0 ? (completed / total) * 100 : 0;
		const status =
			total === 0
				? group.status
				: completed === total
					? "completed"
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

	private async processSyncQueue() {
		if (this.isPaused || this.isProcessingSync) return;
		this.isProcessingSync = true;

		// Evict destroyed documents from the queue and clean up their inProgress entries
		const destroyed = this.syncQueue.filter((item) => item.doc.destroyed);
		for (const item of destroyed) {
			this.inProgressSyncs.delete(item.guid);
			const callback = this.syncCompletionCallbacks.get(item.guid);
			if (callback) callback.reject(new Error("Document destroyed"));
			this.syncCompletionCallbacks.delete(item.guid);
			this.syncPromises.delete(item.guid);
		}
		this.syncQueue = this.syncQueue.filter((item) => !item.doc.destroyed);

		metrics.setBgSyncQueueLength("sync", this.syncQueue.length);

		// Filter for items with connected folders
		const connectableItems = this.syncQueue.filter(
			(item) => item.sharedFolder.connected,
		);

		while (
			connectableItems.length > 0 &&
			this.activeSync.size < this.concurrency
		) {
			const item = connectableItems.shift();
			if (!item) break;

			// Remove this item from the main queue
			this.syncQueue = this.syncQueue.filter((i) => i.guid !== item.guid);

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

						const group = this.syncGroups.get(item.sharedFolder);
						if (group) {
							this.debug(
								`[Sync Progress] Before: completed=${group.completed}, total=${group.total}, ` +
									`syncs=${group.syncs}, completedSyncs=${group.completedSyncs}`,
							);

							group.completedSyncs++;
							group.completed++;

							this.debug(
								`[Sync Progress] After: completed=${group.completed}, total=${group.total}, ` +
									`syncs=${group.syncs}, completedSyncs=${group.completedSyncs}`,
							);

							if (group.completed === group.total) {
								group.status = "completed";
								this.debug("[Sync Progress] Group completed!");
							}

							this.syncGroups.set(item.sharedFolder, group);
						}
					})
					.catch((error) => {
						item.status = "failed";
						metrics.incBgSyncOps("sync", "failed");

						const callback = this.syncCompletionCallbacks.get(item.guid);
						if (callback) {
							callback.reject(
								error instanceof Error ? error : new Error(String(error)),
							);
							this.syncCompletionCallbacks.delete(item.guid);
							this.syncPromises.delete(item.guid);
						}

						const group = this.syncGroups.get(item.sharedFolder);
						if (group) {
							this.error("[Sync Failed]", error);
							group.status = "failed";
							this.syncGroups.set(item.sharedFolder, group);
						}
					})
					.finally(() => {
						metrics.observeBgSyncOp("sync", (performance.now() - opStart) / 1000);
						this.activeSync.delete(item);
						metrics.setBgSyncActive("sync", this.activeSync.size);
						this.inProgressSyncs.delete(item.guid);

						// Unwind the call stack before checking for more work
						this.timeProvider.setTimeout(() => {
							this.processSyncQueue();
						}, 0);
					});
			} catch (error) {
				item.status = "failed";
				metrics.incBgSyncOps("sync", "failed");
				metrics.observeBgSyncOp("sync", (performance.now() - opStart) / 1000);

				const callback = this.syncCompletionCallbacks.get(item.guid);
				if (callback) {
					callback.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
					this.syncCompletionCallbacks.delete(item.guid);
					this.syncPromises.delete(item.guid);
				}

				const group = this.syncGroups.get(item.sharedFolder);
				if (group) {
					this.error("[Sync Startup Failed]", error);
					group.status = "failed";
					this.syncGroups.set(item.sharedFolder, group);
				}

				this.activeSync.delete(item);
				metrics.setBgSyncActive("sync", this.activeSync.size);
				this.inProgressSyncs.delete(item.guid);
			}
		}

		this.isProcessingSync = false;
	}

	private async processDownloadQueue() {
		if (this.isPaused || this.isProcessingDownloads) return;
		this.isProcessingDownloads = true;

		// Evict destroyed documents from the queue and clean up their inProgress entries
		const destroyedDownloads = this.downloadQueue.filter((item) => item.doc.destroyed);
		for (const item of destroyedDownloads) {
			this.inProgressDownloads.delete(item.guid);
			const callback = this.downloadCompletionCallbacks.get(item.guid);
			if (callback) callback.reject(new Error("Document destroyed"));
			this.downloadCompletionCallbacks.delete(item.guid);
			this.downloadPromises.delete(item.guid);
		}
		this.downloadQueue = this.downloadQueue.filter((item) => !item.doc.destroyed);

		metrics.setBgSyncQueueLength("download", this.downloadQueue.length);

		// Filter for items with connected folders
		const connectableItems = this.downloadQueue.filter(
			(item) => item.sharedFolder.connected,
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

						const group = this.syncGroups.get(item.sharedFolder);
						if (group) {
							group.completedDownloads++;
							group.completed++;
							if (item.userVisible) {
								group.completedUserDownloads++;
							}
							if (group.completed === group.total) {
								group.status = "completed";
							}
							this.syncGroups.set(item.sharedFolder, group);
						}
					})
					.catch((error) => {
						item.status = "failed";
						metrics.incBgSyncOps("download", "failed");

						const callback = this.downloadCompletionCallbacks.get(item.guid);
						if (callback) {
							callback.reject(
								error instanceof Error ? error : new Error(String(error)),
							);
							this.downloadCompletionCallbacks.delete(item.guid);
							this.downloadPromises.delete(item.guid);
						}

						const group = this.syncGroups.get(item.sharedFolder);
						if (group) {
							group.status = "failed";
							this.syncGroups.set(item.sharedFolder, group);
						}
						this.error("[processDownloadQueue]", error);
					})
					.finally(() => {
						metrics.observeBgSyncOp("download", (performance.now() - opStart) / 1000);
						this.activeDownloads.delete(item);
						metrics.setBgSyncActive("download", this.activeDownloads.size);
						this.inProgressDownloads.delete(item.guid);

						// Unwind the call stack before checking for more work
						this.timeProvider.setTimeout(() => {
							this.processDownloadQueue();
						}, 0);
					});
			} catch (error) {
				item.status = "failed";
				metrics.incBgSyncOps("download", "failed");
				metrics.observeBgSyncOp("download", (performance.now() - opStart) / 1000);

				const callback = this.downloadCompletionCallbacks.get(item.guid);
				if (callback) {
					callback.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
					this.downloadCompletionCallbacks.delete(item.guid);
					this.downloadPromises.delete(item.guid);
				}

				const group = this.syncGroups.get(item.sharedFolder);
				if (group) {
					this.error("[Download Startup Failed]", error);
					group.status = "failed";
					this.syncGroups.set(item.sharedFolder, group);
				}

				this.activeDownloads.delete(item);
				metrics.setBgSyncActive("download", this.activeDownloads.size);
				this.inProgressDownloads.delete(item.guid);
			}
		}

		this.isProcessingDownloads = false;
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
		};

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
			userDownloads: 0,
			completedUserDownloads: 0,
			};
		}
		group.total++;
		group.syncs++;
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
		this.syncQueue.sort(compareFilePaths);
		this.processSyncQueue();

		return syncPromise;
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
			userDownloads: 0,
			completedUserDownloads: 0,
			};
		}

		// Update the counters for individual document download
		group.downloads++;
		group.total++;
		if (userVisible) {
			group.userDownloads++;
		}
		this.syncGroups.set(sharedFolder, group);

		// Create the queue item
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
			userVisible,
		};

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
		this.downloadQueue.sort(compareFilePaths);
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
		const allItems = [...docs, ...canvases, ...syncFiles];

		// Create sync group with properly initialized counters
		const group: SyncGroup = {
			sharedFolder,
			total: allItems.length,
			completed: 0,
			status: "pending",
			downloads: 0,
			syncs: allItems.length,
			completedDownloads: 0,
			completedSyncs: 0,
			userDownloads: 0,
			completedUserDownloads: 0,
		};

		// Register the group before enqueueing items
		this.syncGroups.set(sharedFolder, group);

		// Sort items by path for consistent sync order
		const sortedDocs = [...docs, ...canvases, ...syncFiles].sort(
			compareFilePaths,
		);

		for (const doc of sortedDocs) {
			this.enqueueForGroupSync(doc);
		}

		// Update group status to running
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);
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
		};

		this.inProgressSyncs.add(item.guid);

		const syncPromise = new Promise<void>((resolve, reject) => {
			this.syncCompletionCallbacks.set(item.guid, {
				resolve,
				reject,
			});
		});
		this.syncPromises.set(item.guid, syncPromise);

		this.syncQueue.push(queueItem);
		this.syncQueue.sort(compareFilePaths);
		this.processSyncQueue();

		return syncPromise;
	}

	private getAuthHeader(clientToken: ClientToken) {
		return {
			Authorization: `Bearer ${clientToken.token}`,
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

		const response = await requestUrl({
			url: url,
			method: "GET",
			headers: headers,
			throw: false,
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

		const response = await requestUrl({
			url,
			method: "GET",
			headers,
			throw: false,
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
		// if the local file is synced, then we do the two step process
		if (isCanvas(doc)) {
			// Store the exported canvas data rather than a stringified version
			const currentCanvasData = Canvas.exportCanvasData(doc.ydoc);
			try {
				const currentFileContents = await doc.sharedFolder.read(doc);

				// Only proceed with update if file matches current ydoc state
				let contentsMatch = false;
				if (isCanvas(doc) && currentCanvasData) {
					// For canvas, use deep object comparison instead of string equality
					const currentFileJson = currentFileContents
						? JSON.parse(currentFileContents)
						: { nodes: [], edges: [] };
					contentsMatch = areObjectsEqual(currentCanvasData, currentFileJson);
					if (!contentsMatch && currentFileContents) {
						this.log(
							"file is not tracking local disk. resolve merge conflicts before syncing.",
						);
						return false;
					}
				}
			} catch (e) {
				// File does not exist
			}
		}
		const isActive = doc.userLock || doc.sharedFolder?.mergeManager?.isActive(doc.guid);
		const startedDisconnected = doc.intent === "disconnected";
		const hadProviderIntegration = isDocument(doc) && doc.hasProviderIntegration();
		const createdIdleIntegration =
			isDocument(doc) && !isActive
				? doc.ensureIdleProviderIntegration({
						freshRemoteDoc: !!doc.hsm?.hasFork(),
					})
				: false;
		const shouldCleanupIdleSession = () =>
			startedDisconnected &&
			!(doc.userLock || doc.sharedFolder?.mergeManager?.isActive(doc.guid));
		const cleanupIdleSession = () => {
			if (!shouldCleanupIdleSession()) return;
			if (isDocument(doc)) {
				if (createdIdleIntegration) {
					doc.destroyIdleProviderIntegration();
					doc.sharedFolder.tokenStore.removeFromRefreshQueue(S3RN.encode(doc.s3rn));
					return;
				}
				if (hadProviderIntegration || doc.hasProviderIntegration()) {
					return;
				}
			}
			doc.disconnect();
			doc.sharedFolder.tokenStore.removeFromRefreshQueue(S3RN.encode(doc.s3rn));
		};
		if (doc.destroyed) return false;
		const connected = await doc.connect();
		if (!connected) {
			if (shouldCleanupIdleSession()) {
				cleanupIdleSession();
			}
			this.warn(`[syncDocWS] failed to connect provider: ${doc.path} guid=${doc.guid}`);
			return false;
		}
		// Always wait for provider sync — _providerSynced fast-path resolves
		// immediately if already synced.  Connected does not imply synced.
		// Timeout prevents hanging the sync queue if the connection drops.
		const SYNC_TIMEOUT_MS = 10_000;
		let timerId: number | undefined;
		const synced = await Promise.race([
			doc.onceProviderSynced().then(() => true),
			new Promise<false>((resolve) => {
				timerId = this.timeProvider.setTimeout(
					() => resolve(false),
					SYNC_TIMEOUT_MS,
				);
			}),
		]);
		if (timerId !== undefined) this.timeProvider.clearTimeout(timerId);
		if (!synced) {
			if (shouldCleanupIdleSession()) {
				cleanupIdleSession();
			}
			this.warn(`[syncDocWS] provider sync timed out: ${doc.path} guid=${doc.guid}`);
			return false;
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
	enqueueCanvasDownload(canvas: Canvas): Promise<Uint8Array | undefined> {
		return this.enqueueDownload(canvas);
	}

	async getCanvas(canvas: Canvas, retry = 3, wait = 3000) {
		try {
			// Get the current contents before applying the update
			const currentJson = Canvas.exportCanvasData(canvas.ydoc);
			let currentFileContents: CanvasData = { edges: [], nodes: [] };
			try {
				const stringContents = await canvas.sharedFolder.read(canvas);
				currentFileContents = JSON.parse(stringContents) as CanvasData;
			} catch (e) {
				// File doesn't exist
			}

			// Only proceed with update if file matches current ydoc state
			const contentsMatch =
				areObjectsEqual(currentJson.edges, currentFileContents.edges) &&
				areObjectsEqual(currentJson.nodes, currentFileContents.nodes);
			const hasContents = currentFileContents.nodes.length > 0;

			const response = await this.downloadItem(canvas);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			this.log("[getCanvas] applying content from server");
			Y.applyUpdate(canvas.ydoc, updateBytes);

			if (hasContents && !contentsMatch) {
				this.log("Skipping flush - file requires merge conflict resolution.");
				return;
			}
			if (canvas.sharedFolder.syncStore.has(canvas.path)) {
				canvas.sharedFolder.flush(canvas, canvas.json);
				this.log("[getCanvas] flushed");
			}
		} catch (e) {
			this.error(e);
			throw e;
		}
	}

	private async getDocument(
		doc: Document,
		retry = 3,
		wait = 3000,
	): Promise<Uint8Array | undefined> {
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
				this.log(
					"[getDocument] Server contains uninitialized document. Waiting for peer to upload.",
					retry,
					wait,
				);
				if (retry > 0) {
					this.timeProvider.setTimeout(() => {
						this.getDocument(doc, retry - 1, wait * 2);
					}, wait);
				}
				return undefined;
			}

			this.log("[getDocument] applying content from server");
			Y.applyUpdate(doc.ydoc, updateBytes);
			return updateBytes;
		} catch (e) {
			this.error(e);
			throw e;
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
			throw new Error(`[syncDocument] Document destroyed before sync: ${doc.guid}`);
		}
		try {
			if (isDocument(doc) || isCanvas(doc)) {
				const synced = await this.syncDocumentWebsocket(doc);
				if (!synced) {
					throw new Error(
						`[syncDocument] Document sync failed: ${doc.path} (${doc.guid})`,
					);
				}
			}
		} catch (e) {
			this.error(e);
			throw e;
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

	/**
	 * Pauses all sync and download queue processing
	 *
	 * This method temporarily halts processing of sync and download queues.
	 * The queues can be resumed by calling resume().
	 */
	pause(): void {
		this.isPaused = true;
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
		this.processSyncQueue();
		this.processDownloadQueue();
	}
	start = this.resume;

	/**
	 * Gets the current status of sync and download queues
	 *
	 * @returns An object with queue statistics
	 */
	getQueueStatus(): {
		syncsQueued: number;
		syncsActive: number;
		downloadsQueued: number;
		downloadsActive: number;
		isPaused: boolean;
	} {
		return {
			syncsQueued: this.syncQueue.length,
			syncsActive: this.activeSync.size,
			downloadsQueued: this.downloadQueue.length,
			downloadsActive: this.activeDownloads.size,
			isPaused: this.isPaused,
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

		// Destroy observable collections
		this.activeSync.destroy();
		this.activeDownloads.destroy();
		this.syncGroups.destroy();

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
}
