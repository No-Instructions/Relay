"use strict";
import { IndexeddbPersistence } from "./storage/y-indexeddb";
import * as idb from "lib0/indexeddb";
import * as Y from "yjs";
import { HasProvider } from "./HasProvider";
import { LoginManager } from "./LoginManager";
import { S3Document, S3Folder, S3RN, S3RemoteDocument } from "./S3RN";
import { SharedFolder } from "./SharedFolder";
import type { TFile, Vault, TFolder } from "obsidian";
import { debounce } from "obsidian";
import { DiskBuffer, DiskBufferStore } from "./DiskBuffer";
import type { Unsubscriber } from "./observable/Observable";
import { Dependency } from "./promiseUtils";
import { flags, withFlag } from "./flagManager";
import { flag } from "./flags";
import type { HasMimeType, IFile } from "./IFile";
import { getMimeType } from "./mimetypes";
import { diffMatchPatch } from "./y-diffMatchPatch";
import type { MergeHSM } from "./merge-hsm/MergeHSM";
import { ProviderIntegration, type YjsProvider } from "./merge-hsm/integration/ProviderIntegration";
import { generateHash } from "./hashing";

export function isDocument(file?: IFile): file is Document {
	return file instanceof Document;
}

export class Document extends HasProvider implements IFile, HasMimeType {
	private _parent: SharedFolder;
	private _persistence: IndexeddbPersistence | null = null;
	whenSyncedPromise: Dependency<void> | null = null;
	persistenceSynced: boolean = false;
	_awaitingUpdates?: boolean;
	readyPromise?: Dependency<Document>;
	path: string;
	_tfile: TFile | null;
	name: string;
	userLock: boolean = false;
	extension: string;
	basename: string;
	vault: Vault;
	stat: {
		ctime: number;
		mtime: number;
		size: number;
	};
	_diskBuffer?: DiskBuffer;
	_diskBufferStore?: DiskBufferStore;
	unsubscribes: Unsubscriber[] = [];
	pendingOps: ((data: string) => string)[] = [];

	/**
	 * MergeHSM instance for this document.
	 * Only available when HSM active mode is enabled.
	 * Use acquireLock() to get/create the HSM.
	 */
	private _hsm: MergeHSM | null = null;

	/**
	 * ProviderIntegration instance for bridging HSM with the provider.
	 * Created when lock is acquired, destroyed when released.
	 */
	private _providerIntegration: ProviderIntegration | null = null;

	/**
	 * Flag to track when we're in the middle of our own save operation.
	 * Used to distinguish our writes from external modifications.
	 */
	private _isSaving: boolean = false;

	constructor(
		path: string,
		guid: string,
		loginManager: LoginManager,
		parent: SharedFolder,
	) {
		const s3rn = parent.relayId
			? new S3RemoteDocument(parent.relayId, parent.guid, guid)
			: new S3Document(parent.guid, guid);
		super(guid, s3rn, parent.tokenStore, loginManager);
		this._parent = parent;
		this.path = path;
		this.name = "[CRDT] " + path.split("/").pop() || "";
		this.setLoggers(this.name);
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.vault = this._parent.vault;
		this.stat = {
			ctime: Date.now(),
			mtime: Date.now(),
			size: 0,
		};
		this._diskBufferStore = this.sharedFolder.diskBufferStore;

		// Initialize HSM immediately so it's always available for filtering disk changes.
		// The HSM starts in loading state and transitions to idle once persistence loads.
		const mergeManager = parent.mergeManager;
		if (mergeManager) {
			this._hsm = mergeManager.getOrRegisterHSM(guid, path, this.ydoc);
		}

		this.unsubscribes.push(
			this._parent.subscribe(this.path, (state) => {
				if (state.intent === "disconnected") {
					this.disconnect();
				}
			}),
		);

		this.setLoggers(`[SharedDoc](${this.path})`);

		// need to port this to the HSM
		// this.whenSynced().then(() => {
		// 	const statsObserver = (event: Y.YTextEvent) => {
		// 		const origin = event.transaction.origin;
		// 		if (event.changes.keys.size === 0) return;
		// 		if (origin == this) return;
		// 		this.updateStats();
		// 	};
		// 	this.ytext.observe(statsObserver);
		// 	this.unsubscribes.push(() => {
		// 		this.ytext?.unobserve(statsObserver);
		// 	});
		// 	this.updateStats();
		// 	try {
		// 		this._persistence!.set("path", this.path);
		// 		this._persistence!.set("relay", this.sharedFolder.relayId || "");
		// 		this._persistence!.set("appId", this.sharedFolder.appId);
		// 		this._persistence!.set("s3rn", S3RN.encode(this.s3rn));
		// 	} catch (e) {
		// 		// pass
		// 	}

		// 	(async () => {
		// 		const serverSynced = await this.getServerSynced();
		// 		if (!serverSynced) {
		// 			await this.onceProviderSynced();
		// 			await this.markSynced();
		// 		}
		// 	})();
		// });

		withFlag(flag.enableDeltaLogging, () => {
			const logObserver = (event: Y.YTextEvent) => {
				let log = "";
				log += `Transaction origin: ${event.transaction.origin} ${event.transaction.origin?.constructor?.name}\n`;
				for (const delta of event.changes.delta) {
					log += `insert: ${delta.insert}\n\nretain: ${delta.retain}\n\ndelete: ${delta.delete}\n`;
				}
				this.debug(log);
			};
			this.ytext.observe(logObserver);
			this.unsubscribes.push(() => {
				this.ytext.unobserve(logObserver);
			});
		});

		this._tfile = null;
	}

	move(newPath: string, sharedFolder: SharedFolder) {
		this.path = newPath;
		this._parent = sharedFolder;
		this.name = newPath.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.updateStats();
	}

	async process(_fn: (data: string) => string) {
		// Automatic diff resolution removed due to data loss issues (BUG-020)
		// This method is intentionally a no-op
	}

	public get parent(): TFolder | null {
		return this.tfile?.parent || null;
	}

	public get sharedFolder(): SharedFolder {
		return this._parent;
	}

	/**
	 * Get the MergeHSM instance for this document.
	 * Returns null if HSM active mode is not enabled or lock not acquired.
	 */
	public get hsm(): MergeHSM | null {
		return this._hsm;
	}

	/**
	 * Acquire lock on this document for active editing.
	 * Transitions HSM from idle to active mode.
	 * Call this when editor opens (replaces userLock = true).
	 *
	 * @param editorContent - The current editor/disk content (required in v6).
	 *   Since the editor content equals the disk content when a file is first
	 *   opened (before CRDT loads), this provides accurate disk content for
	 *   merge operations. Pass the content from the editor or read from disk.
	 * @returns The MergeHSM instance, or null if HSM is not enabled
	 */
	async acquireLock(editorContent?: string): Promise<MergeHSM | null> {
		const mergeManager = this.sharedFolder.mergeManager;
		if (!mergeManager || !this._hsm) {
			this.userLock = true; // Fallback if MergeManager/HSM not available
			return null;
		}

		try {
			// Wait for HSM to finish loading before acquiring lock
			await this._hsm.awaitIdle();

			// v6: If editorContent not provided, read from disk (fallback for backward compatibility)
			let content = editorContent;
			if (content === undefined) {
				const tfile = this.tfile;
				if (tfile) {
					content = await this.vault.read(tfile);
				} else {
					content = "";  // New file, no content yet
				}
			}

			// Send ACQUIRE_LOCK with editorContent to transition from idle to active
			// v6: editorContent is required to fix BUG-022 (data loss on RESOLVE_ACCEPT_DISK)
			if (!mergeManager.isLoaded(this.guid)) {
				this._hsm.send({ type: "ACQUIRE_LOCK", editorContent: content });
				// Mark as active in MergeManager
				mergeManager.markActive(this.guid);
			}

			this.userLock = true; // Keep for compatibility

			// Create ProviderIntegration to bridge HSM with provider.
			// This handles:
			// - SYNC_TO_REMOTE effect → applies updates to remoteDoc (this.ydoc)
			// - remoteDoc.on('update') → sends REMOTE_DOC_UPDATED to HSM
			// - Provider events (sync, disconnect) → forwards to HSM
			if (!this._providerIntegration) {
				this._providerIntegration = new ProviderIntegration(
					this._hsm,
					this.ydoc, // remoteDoc is the same as Document.ydoc
					this._provider as YjsProvider
				);
			}

			return this._hsm;
		} catch (e) {
			this.warn("[acquireLock] Failed to acquire HSM lock:", e);
			this.userLock = true; // Fallback
			return null;
		}
	}

	/**
	 * Release lock on this document.
	 * Transitions HSM from active back to idle mode.
	 * Call this when editor closes (replaces userLock = false).
	 */
	releaseLock(): void {
		this.userLock = false; // Keep for compatibility

		// Destroy ProviderIntegration (unsubscribes from events)
		if (this._providerIntegration) {
			this._providerIntegration.destroy();
			this._providerIntegration = null;
		}

		const mergeManager = this.sharedFolder.mergeManager;
		if (mergeManager) {
			// MergeManager.unload() sends RELEASE_LOCK
			mergeManager.unload(this.guid);
		}
	}

	/**
	 * Get the HSM sync status for this document.
	 * Returns the status if HSM is available, or null otherwise.
	 * This can be used instead of checkStale() when HSM is enabled.
	 */
	getHSMSyncStatus(): import("./merge-hsm/types").SyncStatus | null {
		const mergeManager = this.sharedFolder.mergeManager;
		if (!mergeManager) {
			return null;
		}
		return mergeManager.syncStatus.get(this.guid) ?? null;
	}

	/**
	 * Check if the document has a conflict according to HSM.
	 * Returns true if HSM indicates a conflict, false if synced/pending,
	 * or null if HSM is not available.
	 */
	hasHSMConflict(): boolean | null {
		const status = this.getHSMSyncStatus();
		if (!status) {
			return null;
		}
		return status.status === "conflict";
	}

	public get tfile(): TFile | null {
		if (!this._tfile) {
			this._tfile = this.getTFile();
		}
		return this._tfile;
	}

	getTFile(): TFile | null {
		return this._parent?.getTFile(this);
	}

	public get ytext(): Y.Text {
		return this.ydoc.getText("contents");
	}

	public get text(): string {
		if (!this.ytext) {
			return "";
		}
		return this.ytext.toString();
	}

	async connect(): Promise<boolean> {
		if (this.sharedFolder.s3rn instanceof S3Folder) {
			// Local only
			return false;
		} else if (this.s3rn instanceof S3Document) {
			// convert to remote document
			if (this.sharedFolder.relayId) {
				this.s3rn = new S3RemoteDocument(
					this.sharedFolder.relayId,
					this.sharedFolder.guid,
					this.guid,
				);
			} else {
				this.s3rn = new S3Document(this.sharedFolder.guid, this.guid);
			}
		}
		return (
			this.sharedFolder.shouldConnect &&
			this.sharedFolder.connect().then((connected) => {
				return super.connect();
			})
		);
	}

	public get ready(): boolean {
		if (!this._persistence) return this.synced;
		return this._persistence.isReady(this.synced);
	}

	hasLocalDB(): boolean {
		if (!this._persistence) return false;
		return this._persistence.hasServerSync || this._persistence.hasUserData();
	}

	async awaitingUpdates(): Promise<boolean> {
		await this.whenSynced();
		await this.getServerSynced();
		if (!this._awaitingUpdates) {
			return false;
		}
		this._awaitingUpdates = !this.hasLocalDB();
		return this._awaitingUpdates;
	}

	async whenReady(): Promise<Document> {
		const promiseFn = async (): Promise<Document> => {
			const awaitingUpdates = await this.awaitingUpdates();
			if (awaitingUpdates) {
				// If this is a brand new shared folder, we want to wait for a connection before we start reserving new guids for local files.
				this.log("awaiting updates");
				this.connect();
				await this.onceConnected();
				this.log("connected");
				await this.onceProviderSynced();
				this.log("synced");
				return this;
			}
			return this;
		};
		this.readyPromise =
			this.readyPromise ||
			new Dependency<Document>(promiseFn, (): [boolean, Document] => {
				return [this.ready, this];
			});
		return this.readyPromise.getPromise();
	}

	whenSynced(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			await this.sharedFolder.whenSynced();

			return new Promise<void>((resolve) => {
				if (this.persistenceSynced) {
					resolve();
					return;
				}

				if (!this._persistence) {
					this.persistenceSynced = true;
					resolve();
					return;
				}

				this._persistence.once("synced", () => {
					this.persistenceSynced = true;
					resolve();
				});
			});
		};

		this.whenSyncedPromise =
			this.whenSyncedPromise ||
			new Dependency<void>(promiseFn, (): [boolean, void] => {
				return [this.persistenceSynced, undefined];
			});
		return this.whenSyncedPromise.getPromise();
	}

	async hasKnownPeers(): Promise<boolean> {
		await this.whenSynced();
		return this.hasLocalDB();
	}

	public get mimetype(): string {
		return getMimeType(this.path);
	}

	async save() {
		if (!this.tfile) {
			return;
		}
		if (this.sharedFolder.isPendingDelete(this.path)) {
			this.warn("skipping save for pending delete", this.path);
			return;
		}

		// Mark that we're saving to distinguish from external modifications
		this._isSaving = true;
		try {
			const contents = this.text;
			await this.vault.modify(this.tfile, contents);
			this.warn("file saved", this.path);

			// Notify HSM of save completion with new mtime and hash
			if (this._hsm && this.tfile) {
				const mtime = this.tfile.stat.mtime;
				const encoder = new TextEncoder();
				const hash = await generateHash(encoder.encode(contents).buffer);
				this._hsm.send({ type: "SAVE_COMPLETE", mtime, hash });
			}
		} finally {
			this._isSaving = false;
		}
	}

	/**
	 * Check if the document is currently being saved by us.
	 * Used to distinguish our writes from external modifications.
	 */
	get isSaving(): boolean {
		return this._isSaving;
	}

	requestSave = debounce(this.save, 2000);

	async markOrigin(origin: "local" | "remote"): Promise<void> {
		if (!this._persistence) return;
		await this._persistence.setOrigin(origin);
	}

	async getOrigin(): Promise<"local" | "remote" | undefined> {
		if (!this._persistence) return undefined;
		return this._persistence.getOrigin();
	}

	async markSynced(): Promise<void> {
		if (!this._persistence) return;
		await this._persistence.markServerSynced();
	}

	async getServerSynced(): Promise<boolean> {
		if (!this._persistence) return false;
		return this._persistence.getServerSynced();
	}

	static checkExtension(vpath: string): boolean {
		return vpath.endsWith(".md");
	}

	destroy() {
		this.unsubscribes.forEach((unsubscribe) => {
			unsubscribe();
		});

		// Release HSM lock if held
		if (this._hsm) {
			this.releaseLock();
		}

		super.destroy();
		this.ydoc.destroy();
		if (this._diskBuffer) {
			this._diskBuffer.contents = "";
			this._diskBuffer = undefined;
		}
		this._diskBufferStore = null as any;
		this.whenSyncedPromise?.destroy();
		this.whenSyncedPromise = null as any;
		this.readyPromise?.destroy();
		this.readyPromise = null as any;
		this._parent = null as any;
	}

	public async read(): Promise<string> {
		return this.text;
	}

	public async cleanup(): Promise<void> {
		this._diskBufferStore?.removeDiskBuffer(this.guid);
	}

	// Helper method to update file stats
	private updateStats(): void {
		this.stat.mtime = Date.now();
		this.stat.size = this.text.length;
	}

	// Additional methods that might be useful
	public async write(content: string): Promise<void> {
		this.ytext.delete(0, this.ytext.length);
		this.ytext.insert(0, content);
		this.updateStats();
	}

	public async append(content: string): Promise<void> {
		this.ytext.insert(this.ytext.length, content);
		this.updateStats();
	}
}
