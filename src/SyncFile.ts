"use strict";
import {
	S3File,
	S3RemoteFile,
	S3Folder,
	type S3RNType,
} from "./S3RN";
import type { SharedFolder } from "./SharedFolder";
import { HasLogging } from "./debug";
import { type FileMetas, type SyncFileType } from "./SyncTypes";
import { TFile, type Vault, type TFolder, type FileStats } from "obsidian";
import { Observable, type Unsubscriber } from "./observable/Observable";
import { generateHash } from "./hashing";
import type { HasMimeType, IFile } from "./IFile";
import { getMimeType } from "./mimetypes";
import { flags } from "./flagManager";
import { errorFromUnknown, formatUserFacingError } from "./UserFacingError";

export function isSyncFile(file: IFile | undefined): file is SyncFile {
	return !!file && file instanceof SyncFile;
}

function shortHash(hash: string | undefined | null): string | undefined | null {
	return hash ? hash.slice(0, 12) : hash;
}

type ServerEditMarker = {
	mtime: number;
	size: number;
	hash: string;
};

type UserEditMarker = {
	mtime: number;
	size: number;
};

export class ContentAddressedFileStore extends HasLogging {
	private db: IDBDatabase | null = null;
	private dbName: string;
	private ready: Promise<void>;

	constructor(appId: string) {
		super();
		this.setLoggers("[ContentAddressedFileStore]");
		this.dbName = `${appId}-relay-hashes`;
		this.ready = this.openDB();
	}

	private async openDB(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, 1);

			request.onupgradeneeded = (event) => {
				const db = request.result;
				if (!db.objectStoreNames.contains("files")) {
					db.createObjectStore("files", { keyPath: "path" });
				}
			};

			request.onsuccess = (event) => {
				this.db = request.result;
				resolve();
			};

			request.onerror = (event) => {
				this.error(
					"Error opening ContentAddressedFile database:",
					request.error,
				);
				reject(request.error);
			};
		});
	}

	async saveHash(
		path: string,
		hash: string,
		modifiedAt: number,
	): Promise<void> {
		await this.ready;
		if (!this.db) return;

		return new Promise((resolve, reject) => {
			if (!this.db) return;
			const transaction = this.db.transaction(["files"], "readwrite");
			const store = transaction.objectStore("files");

			const request = store.put({ path, hash, modifiedAt });

			request.onsuccess = () => resolve();
			request.onerror = () => {
				this.error("Error saving hash:", request.error);
				reject(request.error);
			};
		});
	}

	async getHash(
		path: string,
	): Promise<{ hash: string; modifiedAt: number } | null> {
		await this.ready;
		if (!this.db) return null;

		return new Promise((resolve, reject) => {
			if (!this.db) return null;
			const transaction = this.db.transaction(["files"], "readonly");
			const store = transaction.objectStore("files");

			const request = store.get(path);

			request.onsuccess = () => {
				resolve(request.result || null);
			};

			request.onerror = () => {
				this.error("Error retrieving hash:", request.error);
				reject(request.error);
			};
		});
	}

	async removeHash(path: string): Promise<void> {
		await this.ready;
		if (!this.db) return;

		return new Promise((resolve, reject) => {
			if (!this.db) return null;
			const transaction = this.db.transaction(["files"], "readwrite");
			const store = transaction.objectStore("files");

			const request = store.delete(path);

			request.onsuccess = () => resolve();
			request.onerror = () => {
				this.error("Error removing hash:", request.error);
				reject(request.error);
			};
		});
	}

	destroy() {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
}

export interface FileCacheEntry {
	/**
	 * Hash of file contents
	 */
	hash: string;
	/**
	 * Last modified time of file
	 */
	mtime: number;
	/**
	 * Size of file in bytes
	 */
	size: number;
}

export class ContentAddressedFile extends HasLogging {
	value: string | undefined;
	content: ArrayBuffer | null = null;
	_tfile: TFile | null = null;

	constructor(
		private vault: Vault,
		public path: string,
		private store: ContentAddressedFileStore,
	) {
		super();
		const tfile = this.vault.getAbstractFileByPath(path);
		if (tfile && tfile instanceof TFile) {
			this._tfile = tfile;
		}
	}

	private get tfile(): TFile {
		if (!this._tfile) {
			const tfile = this.vault.getAbstractFileByPath(this.path);
			if (tfile && tfile instanceof TFile) {
				this._tfile = tfile;
			} else {
				throw new Error(`missing tfile: ${this.path}`);
			}
		}
		return this._tfile;
	}

	private async loadHashFromStore(): Promise<string | undefined> {
		try {
			const storedData = await this.store.getHash(this.path);
			const fileMtime = this.tfile.stat.mtime;
			if (!storedData) {
				this.debug("hash cache miss", {
					path: this.path,
					reason: "empty",
					fileMtime,
				});
				return;
			}

			const hit = storedData.modifiedAt === fileMtime;
			this.debug("hash cache lookup", {
				path: this.path,
				hit,
				storedHash: shortHash(storedData.hash),
				storedModifiedAt: storedData.modifiedAt,
				fileMtime,
			});
			if (hit) {
				// If the stored hash is for the same modification time, use it
				return storedData.hash;
			}
		} catch (error) {
			this.warn("Failed to load hash from store:", error);
		}
	}

	public get modifiedAt() {
		if (!this.tfile) {
			throw new Error("missing tfile");
		}
		return this.tfile.stat.mtime;
	}

	async read(): Promise<ArrayBuffer | null> {
		this.log("reading content from disk");
		const mtime = this.tfile.stat.mtime;
		const content = await this.vault.readBinary(this.tfile);
		const hash = await generateHash(content);
		this.debug("computed hash from disk read", {
			path: this.path,
			hash: shortHash(hash),
			mtime,
			size: content.byteLength,
		});
		try {
			await this.store.saveHash(this.path, hash, mtime);
		} catch (error) {
			this.warn("Failed to save hash to store:", error);
		}
		return content;
	}

	async _hash(): Promise<string> {
		const mtime = this.tfile.stat.mtime;
		const content = await this.vault.readBinary(this.tfile);
		const hash = await generateHash(content);
		this.debug("computed hash from disk", {
			path: this.path,
			hash: shortHash(hash),
			mtime,
			size: content.byteLength,
		});
		try {
			await this.store.saveHash(this.path, hash, mtime);
		} catch (error) {
			this.warn("Failed to save hash to store:", error);
		}
		return hash;
	}

	move(newPath: string) {
		if (newPath === this.path) {
			return;
		}
		this.path = newPath;
		const tfile = this.vault.getAbstractFileByPath(newPath);
		this._tfile = tfile instanceof TFile ? tfile : null;
	}

	exists() {
		// Re-verify against the vault on every call: a cached handle can go
		// stale when the file is deleted or moved between checks, and a stale
		// true here makes downstream TFile getters throw mid-flow.
		const tfile = this.vault.getAbstractFileByPath(this.path);
		if (tfile && tfile instanceof TFile) {
			this._tfile = tfile;
			return true;
		}
		this._tfile = null;
		return false;
	}

	async clear() {
		this._tfile = null;
		// Also remove from store when clearing
		this.store.removeHash(this.path).catch((error) => {
			this.warn("Failed to remove hash from store:", error);
		});
	}

	async hash(): Promise<string> {
		let hash = await this.loadHashFromStore();
		if (hash) {
			return hash;
		}
		hash = await this._hash();
		return hash;
	}

	destroy() {
		this.vault = null as any;
		this._tfile = null as any;
		// Don't destroy store as it might be shared
	}
}

export class SyncFile
	extends Observable<SyncFile>
	implements TFile, IFile, HasMimeType
{
	private _parent: SharedFolder;
	meta: FileMetas | undefined;
	name: string;
	extension: string;
	basename: string;
	type: SyncFileType;
	vault: Vault;
	caf: ContentAddressedFile;
	ready: boolean = false;
	connected: boolean = true;
	destroyed: boolean = false;
	offFileInfo: Unsubscriber = () => {};
	uploadError?: string = undefined;
	private syncPromise: Promise<void> | null = null;
	private syncRequestedDuringSync = false;
	private lastServerEdit: ServerEditMarker | null = null;
	private lastUserEdit: UserEditMarker | null = null;

	constructor(
		public path: string,
		private _guid: string,
		private hashStore: ContentAddressedFileStore,
		parent: SharedFolder,
	) {
		super();
		this._parent = parent;
		this.setLoggers(`[SharedFile](${this.path})`);
		this.name = this.path.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.vault = this._parent.vault;
		const syncType =
			this.sharedFolder.syncStore.typeRegistry.getTypeForPath(path);
		if (!syncType) {
			throw new Error("unexpected synctype");
		}
		// XXX remove typecast
		this.type = syncType as SyncFileType;

		this.caf = new ContentAddressedFile(
			this.vault,
			this.sharedFolder.getPath(path),
			this.hashStore,
		);

		this.log("created");
	}

	public get guid(): string {
		return this._guid;
	}

	public set guid(guid: string) {
		this._guid = guid;
	}

	public get mimetype(): string {
		return getMimeType(this.path);
	}

	public get s3rn(): S3RNType {
		const relayId = this.sharedFolder.relayId;
		return relayId
			? new S3RemoteFile(relayId, this.sharedFolder.guid, this.guid)
			: new S3File(this.sharedFolder.guid, this.guid);
	}

	disconnect() {
		// pass
	}

	public get inMeta() {
		return !!this.sharedFolder.syncStore.getMeta(this.path);
	}

	public get pending() {
		return !!this.sharedFolder.syncStore.pendingUpload.has(this.path);
	}

	public get tag() {
		return this.uploadError
			? this.uploadError
			: this.inMeta
				? ""
				: this.pending
					? "pending"
					: "unknown";
	}

	move(newPath: string, sharedFolder: SharedFolder) {
		if (newPath === this.path) {
			return;
		}
		this._parent = sharedFolder;
		this.debug("setting new path", newPath);
		this.path = newPath;
		this.caf.move(sharedFolder.getPath(newPath));
		this.name = newPath.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.setLoggers(`[SharedFile](${this.path})`);
	}

	public get lastModified() {
		return this.stat.mtime;
		//return Math.max(this.stat.mtime, this.stat.ctime);
	}

	_refreshMeta() {
		const meta = this.sharedFolder.syncStore.getMeta(this.path);
		this.meta = meta as FileMetas;
		return meta;
	}

	public noteLocalModify(stat: FileStats) {
		if (
			this.lastServerEdit &&
			this.matchesEditStat(this.lastServerEdit, stat) &&
			!this.hasUserEditAfter(this.lastServerEdit)
		) {
			return;
		}
		this.lastUserEdit = {
			mtime: stat.mtime,
			size: stat.size,
		};
	}

	public async push(force = false) {
		this.log("push");
		if (this.sharedFolder.skipStorageBlockedUpload(this.path)) {
			return;
		}
		if (!this.sharedFolder.syncStore.canSync(this.path)) {
			this.log("skipping push -- filetype is disabled");
			return;
		}
		if (this.sharedFolder.intent !== "connected") {
			this.log("skipping push -- folder is set to disconnected");
			return;
		}
		const hash = await this.caf.hash();
		this._refreshMeta();
		if (this.meta?.hash === hash) {
			this.clearCurrentUserEdit();
		} else {
			this.noteCurrentUserEdit();
		}
		this.debug("push state", {
			path: this.path,
			guid: this.guid,
			force,
			localHash: shortHash(hash),
			metaHash: shortHash(this.meta?.hash),
			metaSynctime: this.meta?.synctime,
			statMtime: this.stat.mtime,
		});
		if (!this.meta || (hash && this.meta.hash !== hash) || force) {
			try {
				await this.sharedFolder.cas.writeFile(this);
				await this.sharedFolder.markUploaded(this);
				this.uploadError = undefined;
				this.notifyListeners();
				this.debug("push complete", {
					path: this.path,
					guid: this.guid,
					hash: shortHash(hash),
					force,
				});
			} catch (error) {
				this.uploadError = formatUserFacingError(error, "Failed to push file");
				this.notifyListeners();
				throw error instanceof Error ? error : errorFromUnknown(error);
			}
		} else {
			this.debug("push skipped -- hash already uploaded", {
				path: this.path,
				guid: this.guid,
				hash: shortHash(hash),
			});
		}
		return;
	}

	public async sync() {
		if (this.syncPromise) {
			this.syncRequestedDuringSync = true;
			return this.syncPromise;
		}

		const syncPromise = this.syncUntilSettled().finally(() => {
			if (this.syncPromise === syncPromise) {
				this.syncPromise = null;
			}
		});
		this.syncPromise = syncPromise;
		return syncPromise;
	}

	private async syncUntilSettled() {
		do {
			this.syncRequestedDuringSync = false;
			await this.syncOnce();
		} while (this.syncRequestedDuringSync);
	}

	private async syncOnce() {
		this.log("sync");
		this._refreshMeta();
		const localExists = this.caf.exists();
		const localStat = localExists ? this.stat : undefined;
		this.debug("sync state", {
			path: this.path,
			guid: this.guid,
			localExists,
			localStat: localStat
				? { mtime: localStat.mtime, size: localStat.size }
				: null,
			meta: this.meta
				? {
						hash: shortHash(this.meta.hash),
						synctime: this.meta.synctime,
						type: this.meta.type,
					}
				: null,
			pending: this.pending,
		});

		if (!localExists) {
			if (!this.meta) {
				throw new Error("unexpected case");
			}
			this.debug("sync decision", {
				path: this.path,
				guid: this.guid,
				decision: "pull-missing-local",
				metaHash: shortHash(this.meta.hash),
				metaSynctime: this.meta.synctime,
			});
			await this.pull();
			return;
		} else if (!this.meta) {
			this.debug("sync decision", {
				path: this.path,
				guid: this.guid,
				decision: "push-missing-meta",
				statMtime: this.stat.mtime,
			});
			await this.push();
			return;
		}

		if (this.isCleanLastServerEdit(this.meta as FileMetas, this.stat)) {
			this.debug("sync decision", {
				path: this.path,
				guid: this.guid,
				decision: "noop-server-edit",
				hash: shortHash(this.meta.hash),
			});
			if (this.uploadError) {
				this.uploadError = undefined;
				this.notifyListeners();
			}
			return;
		}

		try {
			const hash = await this.caf.hash();
			this.debug("sync hash comparison", {
				path: this.path,
				guid: this.guid,
				localHash: shortHash(hash),
				metaHash: shortHash(this.meta.hash),
				statMtime: this.stat.mtime,
				metaSynctime: this.meta.synctime,
			});
			if (flags().enableVerifyUploads) {
				// Not remote
				try {
					if (!(await this.verifyUpload())) {
						this.warn("file in metadata, but not on the server!");
						await this.push();
					}
				} catch (err) {
					// pass
				}
			}
			if (hash === this.meta.hash) {
				this.clearCurrentUserEdit();
				this.debug("sync decision", {
					path: this.path,
					guid: this.guid,
					decision: "noop-hash-match",
					hash: shortHash(hash),
				});
				if (this.uploadError) {
					this.uploadError = undefined;
					this.notifyListeners();
				}
			} else {
				this.noteCurrentUserEdit();
				// local is newer
				if (this.stat.mtime > (this.meta as FileMetas).synctime) {
					this.debug("sync decision", {
						path: this.path,
						guid: this.guid,
						decision: "push-local-newer",
						localHash: shortHash(hash),
						metaHash: shortHash(this.meta.hash),
						statMtime: this.stat.mtime,
						metaSynctime: this.meta.synctime,
					});
					await this.push();
					return;
				}
				// remote is newer
				this.debug("sync decision", {
					path: this.path,
					guid: this.guid,
					decision: "pull-remote-newer",
					localHash: shortHash(hash),
					metaHash: shortHash(this.meta.hash),
					statMtime: this.stat.mtime,
					metaSynctime: this.meta.synctime,
				});
				this.warn(
					"synctime",
					this.meta.synctime,
					this.meta?.synctime,
					this.stat.mtime,
				);
				await this.pull();
				return;
			}
		} catch (err) {
			if (this.uploadError) {
				throw err;
			}
			this.warn("unable to compute hash", err);
		}
	}

	shouldPull(meta: FileMetas) {
		const tfile = this.tfile;
		if (this.isLastServerEditSuccessor(meta)) {
			return true;
		}
		return meta.synctime > tfile.stat.mtime;
	}

	private isCleanLastServerEdit(meta: FileMetas, stat: FileStats): boolean {
		const edit = this.lastServerEdit;
		if (!edit || meta.hash !== edit.hash) {
			return false;
		}
		return this.matchesEditStat(edit, stat) && !this.hasUserEditAfter(edit);
	}

	private isLastServerEditSuccessor(meta: FileMetas): boolean {
		const edit = this.lastServerEdit;
		if (!edit || meta.hash === edit.hash) {
			return false;
		}
		return !this.hasUserEditAfter(edit);
	}

	private hasUserEditAfter(edit: ServerEditMarker): boolean {
		return !!this.lastUserEdit && this.lastUserEdit.mtime >= edit.mtime;
	}

	private matchesEditStat(
		edit: { mtime: number; size: number } | null,
		stat: FileStats,
	): boolean {
		return !!edit && stat.mtime === edit.mtime && stat.size === edit.size;
	}

	private clearCurrentUserEdit() {
		if (this.matchesEditStat(this.lastUserEdit, this.stat)) {
			this.lastUserEdit = null;
		}
	}

	private noteCurrentUserEdit() {
		this.lastUserEdit = {
			mtime: this.stat.mtime,
			size: this.stat.size,
		};
	}

	public async verifyUpload() {
		this.log("verify upload");
		this._refreshMeta();
		if (!this.meta) {
			throw new Error("cannot verify upload without meta");
		}
		return this.sharedFolder.cas.verify(this);
	}

	public async pull() {
		this.log("pull");
		this._refreshMeta();
		if (!this.meta) {
			throw new Error("cannot pull without meta");
		}
		if (this.caf.exists()) {
			const hash = await this.caf.hash();
			this.debug("pull state", {
				path: this.path,
				guid: this.guid,
				localHash: shortHash(hash),
				metaHash: shortHash(this.meta.hash),
				metaSynctime: this.meta.synctime,
				statMtime: this.stat.mtime,
			});
			if (hash === this.meta.hash) {
				this.debug("pull skipped -- hash already local", {
					path: this.path,
					guid: this.guid,
					hash: shortHash(hash),
				});
				return;
			}
		}
		try {
			const content = await this.sharedFolder.cas.readFile(this);
			const vaultPath = this.sharedFolder.getPath(this.path);
			const edit: ServerEditMarker = {
				mtime: Date.now(),
				size: content.byteLength,
				hash: this.meta.hash,
			};
			// Record the marker before writing so the modify event raised by
			// writeBinary is recognized as our own server-write echo
			// (noteLocalModify) rather than a user edit.
			this.lastServerEdit = edit;
			await this.vault.adapter.writeBinary(vaultPath, content, {
				mtime: edit.mtime,
			});
			// Save the hash eagerly: the pulled content's hash is known from
			// meta, and a durable entry is the local evidence that this file
			// synced — cleanup relies on it after a restart.
			this.hashStore
				.saveHash(vaultPath, this.meta.hash, edit.mtime)
				.catch((error) => {
					this.warn("Failed to save pulled hash:", error);
				});
			if (this.uploadError) {
				this.uploadError = undefined;
				this.notifyListeners();
			}
			this.debug("pull wrote local file", {
				path: this.path,
				guid: this.guid,
				metaHash: shortHash(this.meta.hash),
				size: content.byteLength,
			});
		} catch (e) {
			this.log(e);
			return;
		}
	}

	public get tfile(): TFile {
		const abstractFile = this.vault.getAbstractFileByPath(
			this.sharedFolder.getPath(this.path),
		);
		if (abstractFile instanceof TFile) {
			return abstractFile;
		}
		throw new Error("TFile API used before file existed");
	}

	public get stat(): FileStats {
		return this.tfile.stat;
	}

	public get parent(): TFolder | null {
		return this.tfile?.parent || null;
	}

	public get sharedFolder(): SharedFolder {
		return this._parent;
	}

	async connect(): Promise<boolean> {
		if (this.sharedFolder.s3rn instanceof S3Folder) {
			// Local only
			return false;
		}
		return (
			this.sharedFolder.shouldConnect &&
			this.sharedFolder.connect().then((connected) => {
				this.connected = connected;
				return this.connected;
			})
		);
	}

	public async read(): Promise<string> {
		return this.vault.read(this.tfile);
	}

	public async delete(): Promise<void> {
		await this.caf.clear();
		return this.sharedFolder.trashFile(this.tfile);
	}

	public async write(content: string): Promise<void> {
		this.vault.adapter.write(this.tfile.path, content);
		await this.caf.hash();
	}

	public async append(content: string): Promise<void> {
		this.vault.append(this.tfile, content);
		await this.caf.hash();
	}

	cleanup() {}

	destroy() {
		this.destroyed = true;
		this.offFileInfo?.();
		this.offFileInfo = null as any;

		this._parent = null as any;
		this.caf.destroy();
	}
}
