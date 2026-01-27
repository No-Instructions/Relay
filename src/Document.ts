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
import { isHSMActiveModeEnabled } from "./merge-hsm/flags";
import { generateHash } from "./hashing";

export function isDocument(file?: IFile): file is Document {
	return file instanceof Document;
}

export class Document extends HasProvider implements IFile, HasMimeType {
	private _parent: SharedFolder;
	private _persistence: IndexeddbPersistence;
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
	 * Cleanup functions for HSM provider event subscriptions.
	 */
	private _hsmProviderCleanup: (() => void)[] = [];

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

		this.unsubscribes.push(
			this._parent.subscribe(this.path, (state) => {
				if (state.intent === "disconnected") {
					this.disconnect();
				}
			}),
		);

		this.setLoggers(`[SharedDoc](${this.path})`);
		try {
			const key = `${this.sharedFolder.appId}-relay-doc-${this.guid}`;
			this._persistence = new IndexeddbPersistence(key, this.ydoc);
		} catch (e) {
			this.warn("Unable to open persistence.", this.guid);
			console.error(e);
			throw e;
		}

		this.whenSynced().then(() => {
			const statsObserver = (event: Y.YTextEvent) => {
				const origin = event.transaction.origin;
				if (event.changes.keys.size === 0) return;
				if (origin == this) return;
				this.updateStats();
			};
			this.ytext.observe(statsObserver);
			this.unsubscribes.push(() => {
				this.ytext?.unobserve(statsObserver);
			});
			this.updateStats();
			try {
				this._persistence.set("path", this.path);
				this._persistence.set("relay", this.sharedFolder.relayId || "");
				this._persistence.set("appId", this.sharedFolder.appId);
				this._persistence.set("s3rn", S3RN.encode(this.s3rn));
			} catch (e) {
				// pass
			}

			(async () => {
				const serverSynced = await this.getServerSynced();
				if (!serverSynced) {
					await this.onceProviderSynced();
					await this.markSynced();
				}
			})();
		});

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

	async process(fn: (data: string) => string) {
		if (this.tfile && flags().enableAutomaticDiffResolution) {
			this.pendingOps.push(fn);
		}
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
	 * @returns The MergeHSM instance, or null if HSM is not enabled
	 */
	async acquireLock(): Promise<MergeHSM | null> {
		if (!isHSMActiveModeEnabled()) {
			this.userLock = true; // Fallback to old behavior
			return null;
		}

		const mergeManager = this.sharedFolder.mergeManager;
		if (!mergeManager) {
			this.userLock = true; // Fallback if MergeManager not available
			return null;
		}

		try {
			// MergeManager.getHSM() registers if needed and sends ACQUIRE_LOCK
			this._hsm = await mergeManager.getHSM(
				this.guid,
				this.path,
				this.ydoc,
			);
			this.userLock = true; // Keep for compatibility

			// Wire up provider events to HSM
			this._setupHSMProviderEvents();

			return this._hsm;
		} catch (e) {
			this.warn("[acquireLock] Failed to acquire HSM lock:", e);
			this.userLock = true; // Fallback
			return null;
		}
	}

	/**
	 * Set up provider event forwarding to HSM.
	 */
	private _setupHSMProviderEvents(): void {
		if (!this._hsm) return;

		const hsm = this._hsm;

		// Forward provider sync event
		const onSynced = () => {
			hsm.send({ type: 'PROVIDER_SYNCED' });
		};
		this._provider.on('synced', onSynced);
		this._hsmProviderCleanup.push(() => this._provider.off('synced', onSynced));

		// Forward connection status changes
		let lastConnected: boolean | null = null;
		const onStatus = (state: { status: string }) => {
			const isConnected = state.status === 'connected';
			if (lastConnected !== isConnected) {
				lastConnected = isConnected;
				if (isConnected) {
					hsm.send({ type: 'CONNECTED' });
				} else if (state.status === 'disconnected') {
					hsm.send({ type: 'DISCONNECTED' });
				}
			}
		};
		this._provider.on('status', onStatus);
		this._hsmProviderCleanup.push(() => this._provider.off('status', onStatus));

		// Send initial state if already connected
		if (this._provider.connectionState.status === 'connected') {
			hsm.send({ type: 'CONNECTED' });
		}
		if (this._providerSynced) {
			hsm.send({ type: 'PROVIDER_SYNCED' });
		}
	}

	/**
	 * Release lock on this document.
	 * Transitions HSM from active back to idle mode.
	 * Call this when editor closes (replaces userLock = false).
	 */
	releaseLock(): void {
		this.userLock = false; // Keep for compatibility

		if (!isHSMActiveModeEnabled() || !this._hsm) {
			return;
		}

		// Clean up provider event subscriptions
		this._hsmProviderCleanup.forEach(cleanup => cleanup());
		this._hsmProviderCleanup = [];

		const mergeManager = this.sharedFolder.mergeManager;
		if (mergeManager) {
			// MergeManager.unload() sends RELEASE_LOCK
			mergeManager.unload(this.guid);
		}

		this._hsm = null;
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

	public async diskBuffer(read = false): Promise<TFile> {
		if (read || this._diskBuffer === undefined) {
			let fileContents: string;
			try {
				const storedContents = await this._parent.diskBufferStore
					.loadDiskBuffer(this.guid)
					.catch((e) => {
						this.warn("[diskBuffer] loadDiskBuffer error:", e);
						return null;
					});
				if (storedContents !== null && storedContents !== "") {
					fileContents = storedContents;
					this.log(
						`[diskBuffer] loaded from IndexedDB cache (${storedContents.length} chars)`,
					);
				} else {
					fileContents = await this._parent.read(this);
					this.log(
						`[diskBuffer] read from file (${fileContents.length} chars), cache was ${storedContents === null ? "null" : "empty"}`,
					);
				}
				return this.setDiskBuffer(fileContents.replace(/\r\n/g, "\n"));
			} catch (e) {
				console.error(e);
				throw e;
			}
		}
		this.log("[diskBuffer] returning existing in-memory diskBuffer");
		return this._diskBuffer;
	}

	setDiskBuffer(contents: string): TFile {
		if (this._diskBuffer) {
			this._diskBuffer.contents = contents;
			this.log(`[setDiskBuffer] updated existing (${contents.length} chars)`);
		} else {
			this._diskBuffer = new DiskBuffer(
				this._parent.vault,
				"local disk",
				contents,
			);
			this.log(`[setDiskBuffer] created new (${contents.length} chars)`);
		}
		this._parent.diskBufferStore
			.saveDiskBuffer(this.guid, contents)
			.then(() => {
				this.log("[setDiskBuffer] saved to IndexedDB");
			})
			.catch((e) => {
				this.warn("[setDiskBuffer] IndexedDB save error:", e);
			});
		return this._diskBuffer;
	}

	async clearDiskBuffer(): Promise<void> {
		this.log("[clearDiskBuffer] called");
		if (this._diskBuffer) {
			this._diskBuffer.contents = "";
			this._diskBuffer = undefined;
			this.log("[clearDiskBuffer] cleared in-memory buffer");
		}
		await this._parent.diskBufferStore
			.removeDiskBuffer(this.guid)
			.then(() => {
				this.log("[clearDiskBuffer] removed from IndexedDB");
			})
			.catch((e) => {
				this.warn("[clearDiskBuffer] IndexedDB remove error:", e);
			});
	}

	public async checkStale(): Promise<boolean> {
		this.log("[checkStale] starting");
		await this.whenSynced();
		const diskBuffer = await this.diskBuffer(true);
		const contents = (diskBuffer as DiskBuffer).contents;
		this.log(
			`[checkStale] diskBuffer contents: ${contents.length} chars, preview: "${contents.slice(0, 50).replace(/\n/g, "\\n")}..."`,
		);
		const response = await this.sharedFolder.backgroundSync.downloadItem(this);
		const updateBytes = new Uint8Array(response.arrayBuffer);

		const textBeforeUpdate = this.text;
		Y.applyUpdate(this.ydoc, updateBytes);
		const textAfterUpdate = this.text;
		this.log(
			`[checkStale] CRDT before update: ${textBeforeUpdate.length} chars, after: ${textAfterUpdate.length} chars`,
		);
		if (textBeforeUpdate !== textAfterUpdate) {
			this.log(
				`[checkStale] CRDT changed after server update, preview: "${textAfterUpdate.slice(0, 50).replace(/\n/g, "\\n")}..."`,
			);
		}
		const stale = this.text !== contents;
		this.log(
			`[checkStale] stale=${stale} (CRDT ${this.text.length} chars vs diskBuffer ${contents.length} chars)`,
		);

		const og = this.text;
		let text = og;

		const applied: ((data: string) => string)[] = [];
		for (const fn of this.pendingOps) {
			text = fn(text);
			applied.push(fn);

			if (text == contents) {
				this.clearDiskBuffer();
				if (og == this.text) {
					diffMatchPatch(this.ydoc, text, this);
				} else {
					if (flags().enableDeltaLogging) {
						this.warn(
							"diffMatchPatch solution is stale an cannot be applied",
							text,
							this.text,
						);
					} else {
						this.log("diffMatchPatch solution is stale an cannot be applied");
					}
					return true;
				}
				this.pendingOps = [];
				return true;
			}
		}
		this.pendingOps = [];
		if (!stale) {
			this.log("[checkStale] not stale, clearing diskBuffer");
			this.clearDiskBuffer();
		} else {
			this.log("[checkStale] stale! will show differ");
		}
		return stale;
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
		return this._persistence.isReady(this.synced);
	}

	hasLocalDB(): boolean {
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
				this._hsm.send({ type: 'SAVE_COMPLETE', mtime, hash });
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
		await this._persistence.setOrigin(origin);
	}

	async getOrigin(): Promise<"local" | "remote" | undefined> {
		return this._persistence.getOrigin();
	}

	async markSynced(): Promise<void> {
		await this._persistence.markServerSynced();
	}

	async getServerSynced(): Promise<boolean> {
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
