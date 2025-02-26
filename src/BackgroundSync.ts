import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { LoginManager } from "./LoginManager";
import * as Y from "yjs";
import { S3RN, S3RemoteDocument } from "./S3RN";
import type { SharedFolders } from "./SharedFolder";
import type { Document } from "./Document";
import type { TimeProvider } from "./TimeProvider";
import { RelayInstances, curryLog } from "./debug";
import type { Subscriber, Unsubscriber } from "./observable/Observable";
import { diff_match_patch, type Diff } from "diff-match-patch";
import { ObservableSet } from "./observable/ObservableSet";
import { ObservableMap } from "./observable/ObservableMap";
import type { SharedFolder } from "./SharedFolder";
import { compareFilePaths } from "./FolderSort";
import type { ClientToken } from "./y-sweet";
import { flags } from "./flagManager";

declare const API_URL: string;

export interface QueueItem {
	guid: string;
	path: string;
	doc: Document;
	status: "pending" | "running" | "completed" | "failed";
	sharedFolder: SharedFolder;
}

export interface SyncLogEntry {
	id: string;
	timestamp: number;
	path: string;
	type: "sync" | "download";
	status: "pending" | "running" | "completed" | "failed";
	guid: string;
	sharedFolderGuid: string;
	error?: string;
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

export function updateYDocFromDiskBuffer(
	ydoc: Y.Doc,
	diskBuffer: string,
): void {
	// Get the YText from the YDoc
	const ytext = ydoc.getText("contents");

	// Get the current content of the YText
	const currentContent = ytext.toString();

	// Create a new diff_match_patch object
	const dmp = new diff_match_patch();

	// Compute the diff between the current content and the disk buffer
	const diffs: Diff[] = dmp.diff_main(currentContent, diskBuffer);

	// Optimize the diff
	dmp.diff_cleanupSemantic(diffs);

	// Initialize the cursor position
	let cursor = 0;

	const log = curryLog("[updateYDocFromDiskBuffer]", "debug");

	// Log the overall change
	log("Updating YDoc:");
	log("Current content length:", currentContent.length);
	log("Disk buffer length:", diskBuffer.length);

	if (diffs.length == 0) {
		return;
	}

	// Apply the diffs as updates to the YDoc
	ydoc.transact(() => {
		for (const [operation, text] of diffs) {
			switch (operation) {
				case 1: // Insert
					log(`Inserting "${text}" at position ${cursor}`);
					ytext.insert(cursor, text);
					cursor += text.length;
					break;
				case 0: // Equal
					log(`Keeping "${text}" (length: ${text.length})`);
					cursor += text.length;
					break;
				case -1: // Delete
					log(`Deleting "${text}" at position ${cursor}`);
					ytext.delete(cursor, text.length);
					break;
			}
		}
	});

	// Log the final state
	log("Update complete. New content length:", ytext.toString().length);
}

export class BackgroundSync {
	public activeSync = new ObservableSet<QueueItem>();
	public activeDownloads = new ObservableSet<QueueItem>();
	public syncGroups = new ObservableMap<SharedFolder, SyncGroup>();
	public syncLog = new ObservableSet<SyncLogEntry>();

	private syncQueue: QueueItem[] = [];
	private downloadQueue: QueueItem[] = [];
	private isProcessingSync = false;
	private isProcessingDownloads = false;
	private isPaused = false;
	private inProgressSyncs = new Set<string>();
	private inProgressDownloads = new Set<string>();
	private syncCompletionCallbacks = new Map<
		string,
		{
			resolve: () => void;
			reject: (error: Error) => void;
		}
	>();
	private downloadCompletionCallbacks = new Map<
		string,
		{
			resolve: () => void;
			reject: (error: Error) => void;
		}
	>();

	// A map to track items we've already logged to avoid duplicates
	private loggedItems = new Map<string, boolean>();
	// Maximum number of log entries to keep
	private maxLogEntries = 100;

	subscriptions: Unsubscriber[] = [];
	log = curryLog("[BackgroundSync]", "log");
	debug = curryLog("[BackgroundSync]", "debug");
	error = curryLog("[BackgroundSync]", "error");

	constructor(
		private loginManager: LoginManager,
		private timeProvider: TimeProvider,
		private sharedFolders: SharedFolders,
		private concurrency: number = 1,
	) {
		RelayInstances.set(this, "BackgroundSync");
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

		while (
			this.syncQueue.length > 0 &&
			this.activeSync.size < this.concurrency
		) {
			const item = this.syncQueue.shift();
			if (!item) break;

			item.status = "running";
			this.activeSync.add(item);

			// Log the item status change to running
			this.addToLog({
				guid: item.guid,
				path: item.path,
				type: "sync",
				status: "running",
				sharedFolderGuid: item.sharedFolder.guid,
			});

			try {
				const doc = item.doc as Document;
				await this.syncDocument(doc);
				item.status = "completed";

				// Log the successful completion
				this.addToLog({
					guid: item.guid,
					path: item.path,
					type: "sync",
					status: "completed",
					sharedFolderGuid: item.sharedFolder.guid,
				});

				const callback = this.syncCompletionCallbacks.get(item.guid);
				if (callback) {
					callback.resolve();
					this.syncCompletionCallbacks.delete(item.guid);
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

						// Log group completion
						this.addToLog({
							guid: group.sharedFolder.guid,
							path: `${group.sharedFolder.path} (group)`,
							type: "sync",
							status: "completed",
							sharedFolderGuid: group.sharedFolder.guid,
						});
					}

					this.syncGroups.set(item.sharedFolder, group);
				}
			} catch (error) {
				item.status = "failed";

				// Log the failure with error details
				this.addToLog({
					guid: item.guid,
					path: item.path,
					type: "sync",
					status: "failed",
					sharedFolderGuid: item.sharedFolder.guid,
					error: error instanceof Error ? error.message : String(error),
				});

				const callback = this.syncCompletionCallbacks.get(item.guid);
				if (callback) {
					callback.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
					this.syncCompletionCallbacks.delete(item.guid);
				}

				const group = this.syncGroups.get(item.sharedFolder);
				if (group) {
					this.error("[Sync Failed]", error);
					group.status = "failed";
					this.syncGroups.set(item.sharedFolder, group);

					// Log group failure
					this.addToLog({
						guid: group.sharedFolder.guid,
						path: `${group.sharedFolder.path} (group)`,
						type: "sync",
						status: "failed",
						sharedFolderGuid: group.sharedFolder.guid,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			} finally {
				this.activeSync.delete(item);
				this.inProgressSyncs.delete(item.guid);
			}
		}

		this.isProcessingSync = false;
		if (this.syncQueue.length > 0) {
			this.processSyncQueue();
		}
	}

	private async processDownloadQueue() {
		if (this.isPaused || this.isProcessingDownloads) return;
		this.isProcessingDownloads = true;

		while (
			this.downloadQueue.length > 0 &&
			this.activeDownloads.size < this.concurrency
		) {
			const item = this.downloadQueue.shift();
			if (!item) break;

			item.status = "running";
			this.activeDownloads.add(item);

			// Log the item status change to running
			this.addToLog({
				guid: item.guid,
				path: item.path,
				type: "download",
				status: "running",
				sharedFolderGuid: item.sharedFolder.guid,
			});

			try {
				await this.getDocument(item.doc);
				item.status = "completed";

				// Log the successful completion
				this.addToLog({
					guid: item.guid,
					path: item.path,
					type: "download",
					status: "completed",
					sharedFolderGuid: item.sharedFolder.guid,
				});

				const callback = this.downloadCompletionCallbacks.get(item.guid);
				if (callback) {
					callback.resolve();
					this.downloadCompletionCallbacks.delete(item.guid);
				}

				const group = this.syncGroups.get(item.sharedFolder);
				if (group) {
					group.completedDownloads++;
					group.completed++;
					if (group.completed === group.total) {
						group.status = "completed";

						// Log group completion
						this.addToLog({
							guid: group.sharedFolder.guid,
							path: `${group.sharedFolder.path} (group)`,
							type: "download",
							status: "completed",
							sharedFolderGuid: group.sharedFolder.guid,
						});
					}
					this.syncGroups.set(item.sharedFolder, group);
				}
			} catch (error) {
				item.status = "failed";

				// Log the failure with error details
				this.addToLog({
					guid: item.guid,
					path: item.path,
					type: "download",
					status: "failed",
					sharedFolderGuid: item.sharedFolder.guid,
					error: error instanceof Error ? error.message : String(error),
				});

				const callback = this.downloadCompletionCallbacks.get(item.guid);
				if (callback) {
					callback.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
					this.downloadCompletionCallbacks.delete(item.guid);
				}

				const group = this.syncGroups.get(item.sharedFolder);
				if (group) {
					group.status = "failed";
					this.syncGroups.set(item.sharedFolder, group);

					// Log group failure
					this.addToLog({
						guid: group.sharedFolder.guid,
						path: `${group.sharedFolder.path} (group)`,
						type: "download",
						status: "failed",
						sharedFolderGuid: group.sharedFolder.guid,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				this.error("[processDownloadQueue]", error);
			} finally {
				this.activeDownloads.delete(item);
				this.inProgressDownloads.delete(item.guid);
			}
		}

		this.isProcessingDownloads = false;
		if (this.downloadQueue.length > 0) {
			this.processDownloadQueue();
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
	async enqueueSync(item: Document): Promise<void> {
		// Skip if already in progress
		if (this.inProgressSyncs.has(item.guid)) {
			this.debug(
				`[enqueueSync] Item ${item.guid} already in progress, skipping`,
			);

			// Return existing promise if already processing
			const existingCallback = this.syncCompletionCallbacks.get(item.guid);
			if (existingCallback) {
				return new Promise<void>((resolve, reject) => {
					existingCallback.resolve = resolve;
					existingCallback.reject = reject;
				});
			}
			return Promise.resolve();
		}

		const sharedFolder = item.sharedFolder;
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
		};

		// Get or create the sync group
		let group = this.syncGroups.get(sharedFolder);
		if (!group) {
			group = {
				sharedFolder,
				total: 1,
				completed: 0,
				status: "pending",
				downloads: 0,
				syncs: 1,
				completedDownloads: 0,
				completedSyncs: 0,
			};
		} else {
			group.total++;
			group.syncs++;
		}
		this.syncGroups.set(sharedFolder, group);

		// Log the enqueued item
		this.addToLog({
			guid: item.guid,
			path: queueItem.path,
			type: "sync",
			status: "pending",
			sharedFolderGuid: sharedFolder.guid,
		});

		this.inProgressSyncs.add(item.guid);

		const syncPromise = new Promise<void>((resolve, reject) => {
			this.syncCompletionCallbacks.set(item.guid, {
				resolve,
				reject,
			});
		});

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
	enqueueDownload(item: Document): Promise<void> {
		// Skip if already in progress
		if (this.inProgressDownloads.has(item.guid)) {
			this.debug(
				`[enqueueDownload] Item ${item.guid} already in progress, skipping`,
			);

			// Return existing promise if already processing
			const existingCallback = this.downloadCompletionCallbacks.get(item.guid);
			if (existingCallback) {
				return new Promise<void>((resolve, reject) => {
					existingCallback.resolve = resolve;
					existingCallback.reject = reject;
				});
			}
			return Promise.resolve();
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
			};
		}

		// Update the counters for individual document download
		group.downloads++;
		group.total++;
		this.syncGroups.set(sharedFolder, group);

		// Create the queue item
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
		};

		// Log the enqueued item
		this.addToLog({
			guid: item.guid,
			path: queueItem.path,
			type: "download",
			status: "pending",
			sharedFolderGuid: sharedFolder.guid,
		});

		// Mark as in progress
		this.inProgressDownloads.add(item.guid);

		// Create a promise that will resolve when the download completes
		const downloadPromise = new Promise<void>((resolve, reject) => {
			this.downloadCompletionCallbacks.set(item.guid, { resolve, reject });
		});

		// Add to the queue and start processing
		this.downloadQueue.push(queueItem);
		this.downloadQueue.sort(compareFilePaths);
		this.processDownloadQueue();

		return downloadPromise;
	}

	/**
	 * Enqueues all documents in a shared folder for synchronization
	 *
	 * This method creates a sync group to track the progress of synchronizing
	 * all documents in a shared folder, then enqueues each document for sync.
	 * It handles counter initialization correctly to avoid double-counting.
	 *
	 * @param sharedFolder The shared folder to synchronize
	 */
	enqueueSharedFolderSync(sharedFolder: SharedFolder): void {
		// Get all documents in the shared folder
		const docs = [...sharedFolder.docs.values()];

		// Create sync group with properly initialized counters
		const group: SyncGroup = {
			sharedFolder,
			total: docs.length,
			completed: 0,
			status: "pending",
			downloads: 0,
			syncs: docs.length,
			completedDownloads: 0,
			completedSyncs: 0,
		};

		// Register the group before enqueueing items
		this.syncGroups.set(sharedFolder, group);

		// Log the group sync beginning
		this.addToLog({
			guid: sharedFolder.guid,
			path: `${sharedFolder.path} (group sync started)`,
			type: "sync",
			status: "pending",
			sharedFolderGuid: sharedFolder.guid,
		});

		// Sort items by path for consistent sync order
		const sortedDocs = [...docs].sort(compareFilePaths);

		// Enqueue all documents for sync without incrementing counters
		for (const doc of sortedDocs) {
			this.enqueueDocumentForGroupSync(doc);
		}

		// Update group status to running
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);

		// Log the group status change
		this.addToLog({
			guid: sharedFolder.guid,
			path: `${sharedFolder.path} (group sync running)`,
			type: "sync",
			status: "running",
			sharedFolderGuid: sharedFolder.guid,
		});
	}

	/**
	 * Enqueues a document for synchronization as part of a group sync operation
	 *
	 * This method is similar to enqueueSync() but doesn't increment any counters
	 * since they're already properly initialized in enqueueSharedFolderSync().
	 * This prevents double-counting of operations in progress tracking.
	 *
	 * @param item The document to synchronize
	 * @returns A promise that resolves when the sync completes
	 * @private Used internally by enqueueSharedFolderSync
	 */
	private async enqueueDocumentForGroupSync(item: Document): Promise<void> {
		// Skip if already in progress
		if (this.inProgressSyncs.has(item.guid)) {
			this.debug(
				`[enqueueDocumentForGroupSync] Item ${item.guid} already in progress, skipping`,
			);

			// Return existing promise if already processing
			const existingCallback = this.syncCompletionCallbacks.get(item.guid);
			if (existingCallback) {
				return new Promise<void>((resolve, reject) => {
					existingCallback.resolve = resolve;
					existingCallback.reject = reject;
				});
			}
			return Promise.resolve();
		}

		const sharedFolder = item.sharedFolder;
		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
		};

		// Log the enqueued item
		this.addToLog({
			guid: item.guid,
			path: queueItem.path,
			type: "sync",
			status: "pending",
			sharedFolderGuid: sharedFolder.guid,
		});

		this.inProgressSyncs.add(item.guid);

		const syncPromise = new Promise<void>((resolve, reject) => {
			this.syncCompletionCallbacks.set(item.guid, {
				resolve,
				reject,
			});
		});

		this.syncQueue.push(queueItem);
		this.syncQueue.sort(compareFilePaths);
		this.processSyncQueue();

		return syncPromise;
	}

	private getAuthHeader(clientToken: ClientToken) {
		return {
			Authorization: flags().enableDocumentServer
				? `Bearer ${clientToken.token}`
				: `Bearer ${this.loginManager.user?.token}`,
		};
	}

	private getBaseUrl(
		clientToken: ClientToken,
		entity: S3RemoteDocument,
	): string {
		const urlObj = new URL(clientToken.url);
		urlObj.protocol = "https:";
		const parts = urlObj.pathname.split("/");
		parts.pop();
		parts.push(clientToken.docId);
		urlObj.pathname = parts.join("/");
		const baseUrl =
			clientToken.baseUrl?.replace(/\/$/, "") || urlObj.toString();

		if (flags().enableDocumentServer) {
			return baseUrl;
		} else {
			return `${API_URL}/relay/${entity.relayId}/doc/${entity.documentId}`;
		}
	}

	async downloadItem(item: Document): Promise<RequestUrlResponse> {
		const entity = item.s3rn;
		this.log("[downloadItem]", item.path, `${S3RN.encode(entity)}`);

		if (!(entity instanceof S3RemoteDocument)) {
			throw new Error("Unable to decode S3RN");
		}

		const clientToken = await item.getProviderToken(0);
		const headers = this.getAuthHeader(clientToken);
		const baseUrl = this.getBaseUrl(clientToken, entity);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrl({
			url: url,
			method: "GET",
			headers: headers,
		});

		if (response.status === 200) {
			this.debug("[downloadItem]", entity.documentId, response.status);
		} else {
			this.error(
				"[downloadItem]",
				entity.documentId,
				baseUrl,
				response.status,
				response.text,
			);
		}
		return response;
	}

	async syncDocumentWebsocket(doc: Document): Promise<boolean> {
		// if the local file is synced, then we do the two step process
		// check if file is tracking
		const currentText = doc.text;
		let currentFileContents = "";
		try {
			currentFileContents = await doc.sharedFolder.read(doc);
		} catch (e) {
			// File does not exist
		}

		// Only proceed with update if file matches current ydoc state
		const contentsMatch = currentText === currentFileContents;

		if (!contentsMatch) {
			this.log(
				"file is not tracking local disk. resolve merge conflicts before syncing.",
			);
			return false;
		}

		const promise = doc.onceProviderSynced();
		const intent = doc.intent;
		doc.connect();
		if (intent === "disconnected" && !doc.userLock) {
			await promise;
		}

		// promise can take some time
		if (intent === "disconnected" && !doc.userLock) {
			doc.disconnect();
			doc.sharedFolder.tokenStore.removeFromRefreshQueue(S3RN.encode(doc.s3rn));
		}
		return true;
	}

	async uploadItem(item: Document): Promise<RequestUrlResponse> {
		const entity = item.s3rn;
		this.log("[uploadItem]", `${S3RN.encode(entity)}`);
		if (!(entity instanceof S3RemoteDocument)) {
			throw new Error("Unable to decode S3RN");
		}

		if (!this.loginManager.loggedIn) {
			throw new Error("Not logged in");
		}

		const clientToken = await item.getProviderToken(0);
		const headers = {
			"Content-Type": "application/octet-stream",
			...this.getAuthHeader(clientToken),
		};
		const update = Y.encodeStateAsUpdate(item.ydoc);

		const baseUrl = this.getBaseUrl(clientToken, entity);
		const updateUrl = `${baseUrl}/update`;
		const response = await requestUrl({
			url: updateUrl,
			method: "POST",
			headers: headers,
			body: update.buffer,
			throw: false,
		});
		if (response.status === 200) {
			this.debug(
				"[uploadItem]",
				entity.documentId,
				response.status,
				response.text,
			);
		} else {
			this.error(
				"[uploadItem]",
				entity.documentId,
				updateUrl,
				response.status,
				response.text,
			);
		}
		return response;
	}

	private async getDocument(doc: Document, retry = 3, wait = 3000) {
		try {
			// Get the current contents before applying the update
			const currentText = doc.text;
			let currentFileContents = "";
			try {
				currentFileContents = await doc.sharedFolder.read(doc);
			} catch (e) {
				// File doesn't exist
			}

			// Only proceed with update if file matches current ydoc state
			const contentsMatch = currentText === currentFileContents;
			const hasContents = currentFileContents !== "";

			const response = await this.downloadItem(doc);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			// Check for newly created documents without content, and reject them
			const newDoc = new Y.Doc();
			Y.applyUpdate(newDoc, updateBytes);
			const users = newDoc.getMap("users");
			const contents = newDoc.getText("contents").toString();
			if (users.size === 0 && contents === "") {
				this.log(
					"[getDocument] Server contains uninitialized document. Waiting for peer to upload.",
					users.size,
					retry,
					wait,
				);
				// Hack for better compat with < 0.4.2.
				if (retry > 0) {
					this.timeProvider.setTimeout(() => {
						this.getDocument(doc, retry - 1, wait * 2);
					}, wait);
				}
				return;
			}

			this.log("[getDocument] got content from server");
			Y.applyUpdate(doc.ydoc, updateBytes);

			if (hasContents && !contentsMatch) {
				this.log("Skipping flush - file requires merge conflict resolution.");
				return;
			}
			if (doc.sharedFolder.ids.has(doc.path)) {
				doc.sharedFolder.flush(doc, doc.text);
				this.log("[getDocument] flushed");
			}
		} catch (e) {
			this.error(e);
			throw e;
		}
	}

	private async syncItem(doc: Document): Promise<boolean> {
		// if the local file is synced, then we do the two step process
		// check if file is tracking
		const currentText = doc.text;
		let currentFileContents = "";
		try {
			currentFileContents = await doc.sharedFolder.read(doc);
		} catch (e) {
			// File does not exist
		}

		// Only proceed with update if file matches current ydoc state
		const contentsMatch = currentText === currentFileContents;

		if (!contentsMatch) {
			this.log(
				"file is not tracking local disk. resolve merge conflicts before syncing.",
			);
			return false;
		}

		// get the server updates
		const response = await this.downloadItem(doc);
		if (response.status !== 200) {
			this.log("server returned an error.");
			return false;
		}
		const rawUpdate = response.arrayBuffer;
		const updateBytes = new Uint8Array(rawUpdate);

		// Check for newly created documents without content
		const newDoc = new Y.Doc();
		Y.applyUpdate(newDoc, updateBytes);
		const contents = newDoc.getText("contents").toString();
		const users = newDoc.getMap("users");

		if (users.size > 0 && contents === currentText) {
			// already synced
			return true;
		}

		Y.applyUpdate(doc.ydoc, updateBytes);

		// apply edits to local file
		doc.sharedFolder.flush(doc, doc.text);

		// now upload our state
		this.uploadItem(doc);

		return true;
	}

	private async syncDocument(doc: Document) {
		try {
			if (flags().enableHTTPSync && doc.sharedFolder.remote?.relay.provider) {
				await this.syncItem(doc);
			} else {
				this.debug("fallback to websocket sync");
				await this.syncDocumentWebsocket(doc);
			}
		} catch (e) {
			console.error(e);
			return;
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
	 * Adds an entry to the sync operation log
	 *
	 * This method adds a new entry to the sync log with the current timestamp.
	 * It prevents duplicate entries for the same item+status combination and
	 * automatically trims the log if it exceeds the maximum size.
	 *
	 * @param entry The partial log entry to add
	 */
	addToLog(entry: Partial<SyncLogEntry>): void {
		const timestamp = Date.now();
		const id =
			entry.id ||
			`log-${entry.type}-${entry.guid}-${entry.status}-${timestamp}`;

		// Check if we've already logged this exact item+status
		const logKey = `${entry.type}-${entry.guid}-${entry.status}`;

		// Only add if we haven't seen this exact item with this status before
		if (!this.loggedItems.has(logKey)) {
			this.loggedItems.set(logKey, true);

			// Create the complete log entry
			const logEntry: SyncLogEntry = {
				id,
				timestamp,
				path: entry.path || "",
				type: entry.type || "sync",
				status: entry.status || "pending",
				guid: entry.guid || id,
				sharedFolderGuid: entry.sharedFolderGuid || "",
				error: entry.error,
			};

			// Add to the observable set
			this.syncLog.add(logEntry);

			// Trim the log if it exceeds the maximum size
			this.trimLog();
		}
	}

	/**
	 * Gets all sync log entries, sorted by timestamp (newest first)
	 *
	 * @returns Array of log entries sorted by timestamp (newest first)
	 */
	getSyncLog(): SyncLogEntry[] {
		// Convert the set to an array
		const entries: SyncLogEntry[] = [];
		this.syncLog.forEach((entry) => entries.push(entry));

		// Sort by timestamp (newest first)
		return entries.sort((a, b) => b.timestamp - a.timestamp);
	}

	/**
	 * Clears the sync log
	 *
	 * This method removes all entries from the sync log and resets
	 * the logged items tracking.
	 */
	clearSyncLog(): void {
		this.syncLog.clear();
		this.loggedItems.clear();
	}

	/**
	 * Trims the log to the maximum number of entries
	 *
	 * This method keeps only the most recent entries up to the maximum
	 * number configured in maxLogEntries.
	 *
	 * @private Used internally by addToLog
	 */
	private trimLog(): void {
		const entries = this.getSyncLog();
		if (entries.length > this.maxLogEntries) {
			// Remove oldest entries beyond the limit
			const entriesToKeep = entries.slice(0, this.maxLogEntries);

			// Clear the log and re-add only the entries to keep
			this.syncLog.clear();
			entriesToKeep.forEach((entry) => {
				this.syncLog.add(entry);
			});
		}
	}

	/**
	 * Retries a failed sync or download operation
	 *
	 * This method attempts to retry a previously failed operation by
	 * re-enqueueing the document for sync or download.
	 *
	 * @param logEntry The log entry to retry
	 * @returns A promise that resolves to true if retry was successful, false otherwise
	 */
	async retryLogItem(logEntry: SyncLogEntry): Promise<boolean> {
		try {
			// Get all shared folders
			const foldersArray: SharedFolder[] = [];
			this.sharedFolders.forEach((folder) => foldersArray.push(folder));

			// Find the matching folder by guid
			const sharedFolder = foldersArray.find(
				(folder) => folder.guid === logEntry.sharedFolderGuid,
			);

			if (!sharedFolder) {
				this.log("Retry failed: Shared folder not found");
				return false;
			}

			// Find the document in the shared folder
			const doc = sharedFolder.docs.get(logEntry.guid);
			if (!doc) {
				this.log("Retry failed: Document not found");
				return false;
			}

			// Add entry to log showing retry attempt
			this.addToLog({
				guid: logEntry.guid,
				path: logEntry.path,
				type: logEntry.type,
				status: "pending",
				sharedFolderGuid: logEntry.sharedFolderGuid,
			});

			// Add to appropriate queue
			if (logEntry.type === "sync") {
				await this.enqueueSync(doc);
				this.log(`Retrying sync for ${logEntry.path}`);
			} else {
				await this.enqueueDownload(doc);
				this.log(`Retrying download for ${logEntry.path}`);
			}

			return true;
		} catch (error) {
			this.error("Error retrying item:", error);

			// Log the error
			this.addToLog({
				guid: logEntry.guid,
				path: logEntry.path,
				type: logEntry.type,
				status: "failed",
				sharedFolderGuid: logEntry.sharedFolderGuid,
				error: error instanceof Error ? error.message : String(error),
			});

			return false;
		}
	}

	/**
	 * Subscribes to sync log updates
	 *
	 * @param callback The function to call when the sync log changes
	 * @returns A function to unsubscribe
	 */
	subscribeToSyncLog(
		callback: Subscriber<ObservableSet<SyncLogEntry>>,
	): Unsubscriber {
		return this.syncLog.subscribe(callback);
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
		this.isPaused = false;
		this.processSyncQueue();
		this.processDownloadQueue();
	}

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
		this.syncLog.destroy();

		// Clear queues and tracking
		this.syncQueue = [];
		this.downloadQueue = [];
		this.inProgressSyncs.clear();
		this.inProgressDownloads.clear();
		this.loggedItems.clear();

		// Clean up references
		this.loginManager = null as any;
		this.sharedFolders = null as any;
		this.timeProvider = null as any;

		// Unsubscribe from all subscriptions
		this.subscriptions.forEach((off) => off());
	}
}
