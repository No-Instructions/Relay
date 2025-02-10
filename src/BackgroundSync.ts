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
	merge: boolean;
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
	}, diskBuffer);

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
				await this.syncDocument(doc, item.merge);
				item.status = "completed";

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
				const group = this.syncGroups.get(item.sharedFolder);
				if (group) {
					this.error("[Sync Failed]", error);
					group.status = "failed";
					this.syncGroups.set(item.sharedFolder, group);
				}
			} finally {
				this.activeSync.delete(item);
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
				const group = this.syncGroups.get(item.sharedFolder);
				if (group) {
					group.status = "failed";
					this.syncGroups.set(item.sharedFolder, group);
				}
				this.error("[processDownloadQueue]", error);
			} finally {
				this.activeDownloads.delete(item);
			}
		}

		this.isProcessingDownloads = false;
		if (this.downloadQueue.length > 0) {
			this.processDownloadQueue();
		}
	}

	enqueueSync(item: Document, merge: boolean = true) {
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
			merge,
			sharedFolder,
		};

		this.syncQueue.push(queueItem);
		this.syncQueue.sort(compareFilePaths);
		this.processSyncQueue();
	}

	enqueueDownload(item: Document) {
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
			merge: true,
			sharedFolder,
		};

		this.downloadQueue.push(queueItem);
		this.downloadQueue.sort(compareFilePaths);
		this.processDownloadQueue();
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
			this.enqueueSync(doc, true);
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

	async syncDocumentWebsocket(item: Document): Promise<void> {
		const promise = item.onceProviderSynced();
		const wasConnected = item.connected;
		item.connect();
		await promise;
		if (!wasConnected) {
			item.disconnect();
			item.sharedFolder.tokenStore.removeFromRefreshQueue(
				S3RN.encode(item.s3rn),
			);
		}
	}

	async uploadItem(
		item: Document,
		merge: boolean = true,
	): Promise<RequestUrlResponse> {
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
		const baseUrl = this.getBaseUrl(clientToken, entity);
		const asUpdateUrl = `${baseUrl}/as-update`;
		const updateResponse = await requestUrl({
			url: asUpdateUrl,
			method: "GET",
			headers: headers,
		});
		if (updateResponse.status !== 200) {
			throw new Error("unable to get server-side code to align push");
		}
		const rawUpdate = updateResponse.arrayBuffer;
		const updateBytes = new Uint8Array(rawUpdate);
		const newDoc = new Y.Doc();
		Y.applyUpdate(newDoc, updateBytes);
		if (!merge && newDoc.getText("contents").toString() !== "") {
			newDoc.destroy();
			throw new Error(
				`[UploadItem][${item.path}] Server has contents -- cancelling upload`,
			);
		}

		const stateVector = Y.encodeStateVectorFromUpdate(updateBytes);
		const update = Y.encodeStateAsUpdate(item.ydoc, stateVector);

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
			const contentsMatch = currentText.trim() === currentFileContents.trim();
			const hasContents = currentFileContents !== "";

			const response = await this.downloadItem(doc);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			// Check for newly created documents without content, and reject them
			const newDoc = new Y.Doc();
			Y.applyUpdate(newDoc, updateBytes);
			if (!newDoc.getText("contents").toString()) {
				this.log(
					"[getDocument] server contents empty document, not overwriting local file.",
				);
				return;
			}

			this.log("[getDocument] got content from server");
			Y.applyUpdate(doc.ydoc, updateBytes);

			if (hasContents && !contentsMatch) {
				this.log("Skipping flush - file requires merge conflict resolution.");
				return;
			}
			doc.sharedFolder.flush(doc, doc.text);
		} catch (e) {
			console.error(e);
			return;
		}
	}

	private async syncDocument(doc: Document, merge: boolean = true) {
		try {
			if (doc.sharedFolder.remote?.relay.provider) {
				await this.uploadItem(doc, merge);
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
		this.activeSync.destroy();
		this.activeDownloads.destroy();
		this.syncGroups.destroy();
		this.syncQueue = [];
		this.downloadQueue = [];
		this.loginManager = null as any;
		this.sharedFolders = null as any;
		this.timeProvider = null as any;
		this.subscriptions.forEach((off) => off());
	}
}
