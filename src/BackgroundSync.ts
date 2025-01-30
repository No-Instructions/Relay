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

			try {
				const doc = item.doc as Document;
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

			try {
				await this.getDocument(item.doc);
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
		if (this.downloadQueue.length > 0) {
			this.processDownloadQueue();
		}
	}

	async enqueueSync(item: Document): Promise<void> {
		// Check if item is already in progress
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
		group.syncs++;
		group.total++;
		this.syncGroups.set(sharedFolder, group);

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
				resolve: () => {
					resolve();
				},
				reject: (error) => {
					reject(error);
				},
			});
		});

		this.syncQueue.push(queueItem);
		this.syncQueue.sort(compareFilePaths);
		this.processSyncQueue();

		return syncPromise;
	}

	enqueueDownload(item: Document): Promise<void> {
		// Check if item is already in progress
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
		group.downloads++;
		group.total++;
		this.syncGroups.set(sharedFolder, group);

		const queueItem: QueueItem = {
			guid: item.guid,
			path: sharedFolder.getPath(item.path),
			doc: item,
			status: "pending",
			sharedFolder,
		};

		this.inProgressDownloads.add(item.guid);

		const downloadPromise = new Promise<void>((resolve, reject) => {
			this.downloadCompletionCallbacks.set(item.guid, {
				resolve: () => {
					resolve();
				},
				reject: (error) => {
					reject(error);
				},
			});
		});

		this.downloadQueue.push(queueItem);
		this.downloadQueue.sort(compareFilePaths);
		this.processDownloadQueue();

		return downloadPromise;
	}

	enqueueSharedFolderSync(sharedFolder: SharedFolder) {
		// Get all documents in the shared folder
		const docs = [...sharedFolder.docs.values()];

		// Create sync group to track progress
		const group: SyncGroup = {
			sharedFolder,
			total: 0,
			completed: 0,
			status: "pending",
			downloads: 0,
			syncs: docs.length,
			completedDownloads: 0,
			completedSyncs: 0,
		};

		// Set the group before enqueueing items
		this.syncGroups.set(sharedFolder, group);

		// Sort items by path for consistent sync order
		const sortedDocs = [...docs].sort(compareFilePaths);

		// Enqueue all items
		for (const doc of sortedDocs) {
			this.enqueueSync(doc);
		}

		// Update group status to running
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);
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
		await promise;
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

	private async getDocument(doc: Document) {
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
				);
				// Hack for better compat with < 0.4.2.
				this.timeProvider.setTimeout(() => {
					this.getDocument(doc);
				}, 3000);
				return;
			}

			this.log("[getDocument] got content from server");
			Y.applyUpdate(doc.ydoc, updateBytes);

			if (hasContents && !contentsMatch) {
				this.log("Skipping flush - file requires merge conflict resolution.");
				return;
			}
			doc.sharedFolder.flush(doc, doc.text);
			this.log("[getDocument] flushed");
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

	pause() {
		this.isPaused = true;
	}

	resume() {
		this.isPaused = false;
		this.processSyncQueue();
		this.processDownloadQueue();
	}

	getQueueStatus() {
		return {
			syncsQueued: this.syncQueue.length,
			syncsActive: this.activeSync.size,
			downloadsQueued: this.downloadQueue.length,
			downloadsActive: this.activeDownloads.size,
			isPaused: this.isPaused,
		};
	}

	destroy() {
		for (const [guid, callback] of this.syncCompletionCallbacks) {
			callback.reject(new Error("BackgroundSync destroyed"));
			this.syncCompletionCallbacks.delete(guid);
		}

		for (const [guid, callback] of this.downloadCompletionCallbacks) {
			callback.reject(new Error("BackgroundSync destroyed"));
			this.downloadCompletionCallbacks.delete(guid);
		}

		this.activeSync.destroy();
		this.activeDownloads.destroy();
		this.syncGroups.destroy();
		this.syncQueue = [];
		this.downloadQueue = [];
		this.inProgressSyncs.clear();
		this.inProgressDownloads.clear();
		this.loginManager = null as any;
		this.sharedFolders = null as any;
		this.timeProvider = null as any;
		this.subscriptions.forEach((off) => off());
	}
}
