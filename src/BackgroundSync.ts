import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { LoginManager } from "./LoginManager";
import * as Y from "yjs";
import { S3RN, S3RemoteCanvas, S3RemoteDocument } from "./S3RN";
import { isDocument, type Document } from "./Document";
import { isCanvas } from "./Canvas";
import type { TimeProvider } from "./TimeProvider";
import { HasLogging, RelayInstances, curryLog } from "./debug";
import type { Subscriber, Unsubscriber } from "./observable/Observable";
import { diff_match_patch, type Diff } from "diff-match-patch";
import { ObservableSet } from "./observable/ObservableSet";
import { ObservableMap } from "./observable/ObservableMap";
import type { SharedFolder, SharedFolders } from "./SharedFolder";
import { compareFilePaths } from "./FolderSort";
import type { ClientToken } from "./y-sweet";
import { flags } from "./flagManager";
import { Canvas } from "./Canvas";
import { areObjectsEqual } from "./areObjectsEqual";
import type { CanvasData } from "./CanvasView";

declare const API_URL: string;

export interface QueueItem {
	guid: string;
	path: string;
	doc: Document | Canvas;
	status: "pending" | "running" | "completed" | "failed";
	sharedFolder: SharedFolder;
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
	private downloadCompletionCallbacks = new Map<
		string,
		{
			resolve: () => void;
			reject: (error: Error) => void;
		}
	>();

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
			this.activeSync.add(item);

			try {
				const doc = item.doc;
				await this.syncDocument(doc);
				item.status = "completed";

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
					}

					this.syncGroups.set(item.sharedFolder, group);
				}
			} catch (error) {
				item.status = "failed";

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
				}
			} finally {
				this.activeSync.delete(item);
				this.inProgressSyncs.delete(item.guid);
			}
		}

		this.isProcessingSync = false;
		// Only continue if there are items AND at least one is processable
		if (this.syncQueue.length > 0 && !this.isPaused) {
			const hasConnectedItems = this.syncQueue.some(
				(item) => item.sharedFolder.connected,
			);
			if (hasConnectedItems) {
				this.processSyncQueue();
			}
		}
	}

	private async processDownloadQueue() {
		if (this.isPaused || this.isProcessingDownloads) return;
		this.isProcessingDownloads = true;

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
			this.activeDownloads.add(item);

			try {
				// Choose the appropriate download method based on the document type
				if (item.doc instanceof Canvas) {
					await this.getCanvas(item.doc);
				} else {
					await this.getDocument(item.doc);
				}
				
				item.status = "completed";

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
					}
					this.syncGroups.set(item.sharedFolder, group);
				}
			} catch (error) {
				item.status = "failed";

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
				}
				this.error("[processDownloadQueue]", error);
			} finally {
				this.activeDownloads.delete(item);
				this.inProgressDownloads.delete(item.guid);
			}
		}

		this.isProcessingDownloads = false;
		// Only continue if there are items AND at least one is processable
		if (this.downloadQueue.length > 0 && !this.isPaused) {
			const hasConnectedItems = this.downloadQueue.some(
				(item) => item.sharedFolder.connected,
			);
			if (hasConnectedItems) {
				this.processDownloadQueue();
			}
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
	async enqueueSync(item: Document | Canvas): Promise<void> {
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
			this.processSyncQueue();
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
	enqueueDownload(item: Document | Canvas): Promise<void> {
		// Skip if already in progress
		if (this.inProgressDownloads.has(item.guid)) {
			this.debug(
				`[enqueueDownload] Item ${item.guid} already in progress, skipping`,
			);

			// Return existing promise if already processing
			const existingCallback = this.downloadCompletionCallbacks.get(item.guid);
			if (existingCallback) {
				this.processDownloadQueue();
				return new Promise<void>((resolve, reject) => {
					existingCallback.resolve = resolve;
					existingCallback.reject = reject;
				});
			}
			this.processDownloadQueue();
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
		const allItems = [...docs, ...canvases];

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
		};

		// Register the group before enqueueing items
		this.syncGroups.set(sharedFolder, group);

		// Sort items by path for consistent sync order
		const sortedDocs = [...docs].sort(compareFilePaths);
		const sortedCanvases = [...canvases].sort(compareFilePaths);

		// Enqueue all items for sync without incrementing counters
		for (const doc of sortedDocs) {
			this.enqueueDocumentForGroupSync(doc);
		}
		
		// Enqueue all canvases for sync
		for (const canvas of sortedCanvases) {
			this.enqueueCanvasForGroupSync(canvas, sharedFolder);
		}

		// Update group status to running
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);
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
				this.processSyncQueue();
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

		if (flags().enableDocumentServer) {
			return baseUrl;
		} else if (entity instanceof S3RemoteDocument) {
			return `${API_URL}/relay/${entity.relayId}/doc/${entity.documentId}`;
		} else if (entity instanceof S3RemoteCanvas) {
			return `${API_URL}/relay/${entity.relayId}/doc/${entity.canvasId}`;
		}
		throw new Error("unexpected case");
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
			throw new Error("Unable to decode S3RN");
		}

		const clientToken = await item.getProviderToken();
		const headers = this.getAuthHeader(clientToken);
		const baseUrl = this.getBaseUrl(clientToken, entity);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrl({
			url: url,
			method: "GET",
			headers: headers,
		});

		if (response.status === 200) {
			this.debug("[downloadItem]", getId(entity), response.status);
		} else {
			this.error(
				"[downloadItem]",
				getId(entity),
				baseUrl,
				response.status,
				response.text,
			);
		}
		return response;
	}

	async syncDocumentWebsocket(doc: Document | Canvas): Promise<boolean> {
		// if the local file is synced, then we do the two step process
		// check if file is tracking
		let currentFileContents = "";
		
		// Handle different document types
		let currentTextStr = "";
		let currentCanvasData: CanvasData | null = null;

		if (isCanvas(doc)) {
			// Store the exported canvas data rather than a stringified version
			currentCanvasData = Canvas.exportCanvasData(doc.ydoc);
			currentTextStr = JSON.stringify(currentCanvasData);
		} else if (isDocument(doc)) {
			currentTextStr = doc.text;
		}
		try {
			currentFileContents = await doc.sharedFolder.read(doc);
		} catch (e) {
			// File does not exist
		}

		// Only proceed with update if file matches current ydoc state
		let contentsMatch = false;
		if (isCanvas(doc) && currentCanvasData) {
			// For canvas, use deep object comparison instead of string equality
			const currentFileJson = currentFileContents ? JSON.parse(currentFileContents) : { nodes: [], edges: [] };
			contentsMatch = areObjectsEqual(currentCanvasData, currentFileJson);
		} else {
			contentsMatch = currentTextStr === currentFileContents;
		}

		if (!contentsMatch && currentFileContents) {
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

	async uploadItem(item: Document | Canvas): Promise<RequestUrlResponse> {
		const entity = item.s3rn;
		this.log("[uploadItem]", `${S3RN.encode(entity)}`);
		if (!(entity instanceof S3RemoteDocument) && !(entity instanceof S3RemoteCanvas)) {
			throw new Error("Unable to decode S3RN");
		}

		if (!this.loginManager.loggedIn) {
			throw new Error("Not logged in");
		}

		const clientToken = await item.getProviderToken();
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
				entity instanceof S3RemoteCanvas ? entity.canvasId : entity.documentId,
				response.status,
				response.text,
			);
		} else {
			this.error(
				"[uploadItem]",
				entity instanceof S3RemoteCanvas ? entity.canvasId : entity.documentId,
				updateUrl,
				response.status,
				response.text,
			);
		}
		return response;
	}

	/**
	 * Enqueues a document to be downloaded from the server
	 * @param canvas The canvas to download
	 * @returns A promise that resolves when the download completes
	 */
	enqueueCanvasDownload(canvas: Canvas): Promise<void> {
		return this.enqueueDownload(canvas);
	}
	
	/**
	 * Enqueues a canvas for group synchronization
	 * This is used as part of the shared folder sync process
	 */
	private async enqueueCanvasForGroupSync(
		canvas: Canvas,
		sharedFolder: SharedFolder,
	): Promise<void> {
		try {
			// Skip this canvas if it's not in the sync store
			if (!sharedFolder.syncStore.has(canvas.path)) {
				this.debug(
					"[enqueueCanvasForGroupSync] Skipping canvas, not in sync list",
					canvas.path,
				);
				return;
			}
			
			await this.enqueueDownload(canvas);
		} catch (e) {
			this.error("[enqueueCanvasForGroupSync]", e);
		}
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

			if (contents === "") {
				if (users.size === 0) {
					// Hack for better compat with < 0.4.2.
					this.log(
						"[getDocument] Server contains uninitialized document. Waiting for peer to upload.",
						users.size,
						retry,
						wait,
					);
					if (retry > 0) {
						this.timeProvider.setTimeout(() => {
							this.getDocument(doc, retry - 1, wait * 2);
						}, wait);
					}
					return;
				}
				if (doc.text) {
					this.log(
						"[getDocument] local crdt has contents, but remote is empty",
					);
					this.enqueueSync(doc);
					return;
				}
			}

			this.log("[getDocument] applying content from server");
			Y.applyUpdate(doc.ydoc, updateBytes);

			if (hasContents && !contentsMatch) {
				this.log("Skipping flush - file requires merge conflict resolution.");
				return;
			}
			if (doc.sharedFolder.syncStore.has(doc.path)) {
				doc.sharedFolder.flush(doc, doc.text);
				this.log("[getDocument] flushed");
			}
		} catch (e) {
			this.error(e);
			throw e;
		}
	}

	private async syncItem(doc: Document | Canvas): Promise<boolean> {
		// if the local file is synced, then we do the two step process
		// check if file is tracking
		let currentFileContents = "";
		
		// Handle different document types
		let currentTextStr = "";
		let currentCanvasData: CanvasData | null = null;

		if (isCanvas(doc)) {
			// Store the exported canvas data rather than a stringified version
			currentCanvasData = Canvas.exportCanvasData(doc.ydoc);
			currentTextStr = JSON.stringify(currentCanvasData);
		} else if (isDocument(doc)) {
			currentTextStr = doc.text;
		}
		try {
			currentFileContents = await doc.sharedFolder.read(doc);
		} catch (e) {
			// File does not exist
		}

		// Only proceed with update if file matches current ydoc state
		let contentsMatch = false;
		if (isCanvas(doc) && currentCanvasData) {
			// For canvas, use deep object comparison instead of string equality
			const currentFileJson = currentFileContents ? JSON.parse(currentFileContents) : { nodes: [], edges: [] };
			contentsMatch = areObjectsEqual(currentCanvasData, currentFileJson);
		} else {
			contentsMatch = currentTextStr === currentFileContents;
		}

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
		const users = newDoc.getMap("users");
		
		let isAlreadySynced = false;
		if (isCanvas(doc) && currentCanvasData) {
			const remoteCanvasData = Canvas.exportCanvasData(newDoc);
			// Use deep object comparison for canvas data
			isAlreadySynced = users.size > 0 && areObjectsEqual(remoteCanvasData, currentCanvasData);
		} else {
			const remoteContent = newDoc.getText("contents").toString();
			isAlreadySynced = users.size > 0 && remoteContent === currentTextStr;
		}

		if (isAlreadySynced) {
			// already synced
			return true;
		}

		Y.applyUpdate(doc.ydoc, updateBytes);

		// apply edits to local file
		if (isCanvas(doc)) {
			doc.sharedFolder.flush(doc, doc.json);
		} else if (isDocument(doc)) {
			doc.sharedFolder.flush(doc, doc.text);
		}

		// now upload our state
		this.uploadItem(doc);

		return true;
	}

	private async syncDocument(doc: Document | Canvas) {
		try {
			if (flags().enableHTTPSync && doc.sharedFolder.remote?.relay.provider) {
				await this.syncItem(doc);
			} else {
				this.debug("fallback to websocket sync");
				if (isDocument(doc)) {
					await this.syncDocumentWebsocket(doc);
				} else if (isCanvas(doc)) {
					await this.syncDocumentWebsocket(doc);
				}
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
		this.loggedItems.clear();

		// Clean up references
		this.loginManager = null as any;
		this.timeProvider = null as any;

		// Unsubscribe from all subscriptions
		this.subscriptions.forEach((off) => off());
	}
}
