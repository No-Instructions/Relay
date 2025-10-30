"use strict";
import {
	S3File,
	S3RemoteFile,
	S3Document,
	S3Folder,
	type S3RNType,
} from "./S3RN";
import { SharedFolder } from "./SharedFolder";
import { HasLogging } from "./debug";
import { type FileMeta, type FileMetas, type SyncFileType } from "./SyncTypes";
import { TFile, type Vault, type TFolder, type FileStats } from "obsidian";
import { Observable, type Unsubscriber } from "./observable/Observable";
import { generateHash } from "./hashing";
import type { HasMimeType, IFile } from "./IFile";
import { getMimeType } from "./mimetypes";
import { flags } from "./flagManager";

export function isSyncFile(file: IFile | undefined): file is SyncFile {
	return !!file && file instanceof SyncFile;
}

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
			if (storedData && storedData.modifiedAt === this.tfile.stat.mtime) {
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
		try {
			await this.store.saveHash(this.path, hash, mtime);
		} catch (error) {
			this.warn("Failed to save hash to store:", error);
		}
		return hash;
	}

	exists() {
		if (this._tfile) {
			return true;
		}
		const tfile = this.vault.getAbstractFileByPath(this.path);
		if (tfile && tfile instanceof TFile) {
			this._tfile = tfile;
			return true;
		}
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
	s3rn: S3RNType;
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
	offFileInfo: Unsubscriber = () => {};
	uploadError?: string = undefined;

	constructor(
		public path: string,
		private _guid: string,
		private hashStore: ContentAddressedFileStore,
		parent: SharedFolder,
	) {
		super();
		this.s3rn = parent.relayId
			? new S3RemoteFile(parent.relayId, parent.guid, _guid)
			: new S3File(parent.guid, _guid);
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
		this.s3rn = this._parent.relayId
			? new S3RemoteFile(this._parent.relayId, this._parent.guid, guid)
			: new S3File(this._parent.guid, guid);
	}

	public get mimetype(): string {
		return getMimeType(this.path);
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
		return this.inMeta
			? ""
			: this.uploadError
				? this.uploadError
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

	public async push(force = false) {
		this.log("push");
		if (!this.sharedFolder.connected) {
			this.log("skipping push -- folder is disconnected");
			return;
		}
		if (!this.sharedFolder.syncStore.canSync(this.path)) {
			this.log("skipping push -- filetype is disabled");
			return;
		}
		const hash = await this.caf.hash();
		this._refreshMeta();
		if (!this.meta || (hash && this.meta.hash !== hash) || force) {
			try {
				await this.sharedFolder.cas.writeFile(this);
				await this.sharedFolder.markUploaded(this);
				this.uploadError = undefined;
				this.notifyListeners();
			} catch (error) {
				let errorMessage = "Failed to push file";
				try {
					errorMessage = (error as string).toString();
				} catch (e) {
					//pass
				}
				this.uploadError = errorMessage.replace(/^Error:/, "").trim();
				this.notifyListeners();
			}
		}
		return;
	}

	public async sync() {
		this.log("sync");
		this._refreshMeta();

		if (!this.caf.exists()) {
			if (!this.meta) {
				throw new Error("unexpected case");
			}
			await this.pull();
			return;
		} else if (!this.meta) {
			await this.push();
			return;
		}

		try {
			const hash = await this.caf.hash();
			if (flags().enableVerifyUploads) {
				// Not remote
				try {
					if (!this.verifyUpload()) {
						this.warn("file in metadata, but not on the server!");
						await this.push();
					}
				} catch (err) {
					// pass
				}
			}
			if (hash !== this.meta.hash) {
				// local is newer
				if (this.stat.mtime > (this.meta as FileMetas).synctime) {
					await this.push();
					return;
				}
				// remote is newer
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
			this.warn("unable to compute hash", err);
		}
	}

	shouldPull(meta: FileMeta) {
		return !this.tfile || meta.synctime > this.stat.mtime;
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
			if (hash === this.meta.hash) {
				return;
			}
		}
		try {
			const content = await this.sharedFolder.cas.readFile(this);
			await this.vault.adapter.writeBinary(
				this.sharedFolder.getPath(this.path),
				content,
			);
			await this.caf.hash();
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
		} else if (this.s3rn instanceof S3Document) {
			// convert to remote document
			if (this.sharedFolder.relayId) {
				this.s3rn = new S3RemoteFile(
					this.sharedFolder.relayId,
					this.sharedFolder.guid,
					this.guid,
				);
			} else {
				this.s3rn = new S3File(this.sharedFolder.guid, this.guid);
			}
		}
		return (
			this.sharedFolder.shouldConnect &&
			this.sharedFolder.connect().then((connected) => {
				this.connected = true;
				return this.connected;
			})
		);
	}

	public async read(): Promise<string> {
		return this.vault.read(this.tfile);
	}

	public async delete(): Promise<void> {
		await this.caf.clear();
		return this.vault.delete(this.tfile);
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
		this.offFileInfo?.();
		this.offFileInfo = null as any;

		this._parent = null as any;
		this.caf.destroy();
	}
}
