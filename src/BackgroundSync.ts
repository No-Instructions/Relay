import {
	arrayBufferToBase64,
	requestUrl,
	type RequestUrlResponse,
} from "obsidian";
import type { HasProvider } from "./HasProvider";
import type { LoginManager } from "./LoginManager";
import * as Y from "yjs";
import { S3RN, S3RemoteDocument, S3RemoteFolder } from "./S3RN";
import type { SharedFolder, SharedFolders } from "./SharedFolder";
import { Document } from "./Document";
import type { TimeProvider } from "./TimeProvider";
import { RelayInstances, curryLog } from "./debug";
import type { Unsubscriber } from "./observable/Observable";
import { diff_match_patch, type Diff } from "diff-match-patch";
import { SyncFile } from "./SyncFile";

declare const API_URL: string;

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
	subscriptions: Unsubscriber[] = [];
	downloadQueue: HasProvider[] = [];
	log = curryLog("[BackgroundSync]", "log");
	debug = curryLog("[BackgroundSync]", "debug");
	error = curryLog("[BackgroundSync]", "error");

	constructor(
		private loginManager: LoginManager,
		private timeProvider: TimeProvider,
		private sharedFolders: SharedFolders,
	) {
		RelayInstances.set(this, "BackgroundSync");
	}

	enqueueDownload(item: HasProvider) {
		this.downloadQueue.push(item);
	}

	async downloadItem(item: HasProvider): Promise<RequestUrlResponse> {
		const entity = item.s3rn;
		this.log("[downloadItem]", `${S3RN.encode(entity)}`);
		let docId: string;
		if (entity instanceof S3RemoteDocument) {
			docId = entity.documentId;
		} else if (entity instanceof S3RemoteFolder) {
			docId = entity.folderId;
		} else {
			throw new Error("Unable to decode S3RN");
		}
		if (!this.loginManager.loggedIn) {
			throw new Error("Not logged in");
		}
		const headers = {
			Authorization: `Bearer ${this.loginManager.user?.token}`,
		};
		const response = await requestUrl({
			url: `${API_URL}/relay/${entity.relayId}/doc/${docId}/as-update`,
			method: "GET",
			headers: headers,
		});
		if (response.status === 200) {
			this.debug("[downloadItem]", docId, response.status);
		} else {
			this.error("[downloadItem]", docId, response.status, response.text);
		}
		return response;
	}

	async uploadItem(item: Document): Promise<RequestUrlResponse> {
		const entity = item.s3rn;
		this.log("[uploadItem]", `${S3RN.encode(entity)}`);
		let docId: string;
		if (entity instanceof S3RemoteDocument) {
			docId = entity.documentId;
		} else if (entity instanceof S3RemoteFolder) {
			docId = entity.folderId;
		} else {
			throw new Error("Unable to decode S3RN");
		}
		if (!this.loginManager.loggedIn) {
			throw new Error("Not logged in");
		}
		const headers = {
			Authorization: `Bearer ${this.loginManager.user?.token}`,
			"Content-Type": "application/octet-stream",
		};
		const update = Y.encodeStateAsUpdate(item.ydoc);
		const response = await requestUrl({
			url: `${API_URL}/relay/${entity.relayId}/doc/${docId}/update`,
			method: "POST",
			headers: headers,
			body: update.buffer,
			throw: false,
		});
		if (response.status === 200) {
			this.debug("[uploadItem]", docId, response.status, response.text);
		} else {
			this.error("[uploadItem]", docId, response.status, response.text);
		}
		return response;
	}

	async getDocument(doc: Document) {
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
			if (!newDoc.getText("contents").toString() && hasContents) {
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

	async putDocument(doc: Document) {
		try {
			const response = await this.uploadItem(doc);
			if (response.status !== 200) {
				throw new Error(
					`Failed to upload document: ${response.status} ${response.text}`,
				);
			}
		} catch (e) {
			console.error(e);
			return;
		}
	}

	async putFolderFiles(folder: SharedFolder) {
		await folder.whenReady();
		this.log("[putFolderFiles]", `Uploading ${folder.docset.size} items`);
		let i = 1;
		for (const file of folder.docset.items()) {
			if (file instanceof Document) {
				await file.whenReady();
				if (file.text) {
					await this.uploadItem(file);
				}
				this.log("[putFolderFiles]", `${i}/${folder.docset.size}`);
				i++;
			}
		}
	}

	async getFolder(folder: SharedFolder) {
		const response = await this.downloadItem(folder);
		const rawUpdate = response.arrayBuffer;
		const updateBytes = new Uint8Array(rawUpdate);
		Y.applyUpdate(folder.ydoc, updateBytes);
	}

	async getFolderFiles(folder: SharedFolder) {
		await folder.whenReady();
		if (!folder.shouldConnect) {
			return;
		}
		this.log("[getFolderFiles]", `Downloading ${folder.docset.size} files`);
		let i = 1;
		for (const file of folder.docset.items()) {
			if (file instanceof Document) {
				await this.getDocument(file);
				this.log("[getFolderFiles]", `${i}/${folder.docset.size}`);
				i++;
			} else if (file instanceof SyncFile) {
				file.sync();
				i++;
			}
		}
	}

	destroy() {
		this.loginManager = null as any;
		this.sharedFolders = null as any;
		this.subscriptions.forEach((off) => off());
		this.downloadQueue = [];
	}
}
