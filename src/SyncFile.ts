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
import { type FileMeta, isFileMeta } from "./SyncStore";
import { TFile, type Vault, type TFolder, type FileStats } from "obsidian";
import type { Unsubscriber } from "./observable/Observable";
import type { RelayManager } from "./RelayManager";
import { uuidv4 } from "lib0/random";
import { generateHash } from "./hashing";
import type { Hashable, IFile } from "./IFile";

export class SyncFile extends HasLogging implements TFile, IFile, Hashable {
	s3rn: S3RNType;
	private _parent: SharedFolder;
	_tfile: TFile | null = null;
	name: string;
	extension: string;
	synctime: number;
	basename: string;
	vault: Vault;
	ready: boolean = false;
	connected: boolean = true;
	offFileInfo: Unsubscriber = () => {};
	offFolderStatusListener: Unsubscriber;
	private _sha256at: number = 0;
	private _sha256: string = "";

	constructor(
		public path: string,
		hashOrFile: string | TFile | undefined,
		public guid: string,
		private relayManager: RelayManager,
		parent: SharedFolder,
	) {
		super();
		if (hashOrFile instanceof TFile) {
			this._tfile = hashOrFile;
		} else {
			this._sha256 = hashOrFile || "";
			this._sha256at = Date.now();
		}
		this.s3rn = parent.relayId
			? new S3RemoteFile(parent.relayId, parent.guid, guid)
			: new S3File(parent.guid, guid);
		this._parent = parent;
		this.name = this.path.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.vault = this._parent.vault;
		const tfile = this.vault.getAbstractFileByPath(
			this.sharedFolder.getPath(path),
		);
		if (tfile instanceof TFile) {
			this._tfile = tfile;
		}
		this.synctime = this._tfile?.stat.mtime || 0;
		this.offFolderStatusListener = this._parent.subscribe(
			this.path,
			(state) => {
				if (state.intent === "disconnected") {
					this.disconnect();
				}
			},
		);
		this.log("created");
	}

	static fromTFile(
		relayManager: RelayManager,
		sharedFolder: SharedFolder,
		tfile: TFile,
	) {
		return new SyncFile(
			sharedFolder.getVirtualPath(tfile.path),
			tfile,
			uuidv4(),
			relayManager,
			sharedFolder,
		);
	}

	public async sha256(content?: ArrayBuffer): Promise<string> {
		const stat = this.tfile.stat;
		const modifiedAt = Math.max(stat.mtime, stat.ctime);
		if (modifiedAt > this._sha256at) {
			if (content === undefined) {
				content = await this.vault.readBinary(this.tfile);
			}
			this._sha256at = Date.now();
			this._sha256 = await generateHash(content);
			this.ready = true;
		}
		return this._sha256;
	}

	disconnect() {
		this.connected = false;
	}

	move(newPath: string) {
		if (newPath === this.path) {
			return;
		}
		this.debug("setting new path", newPath);
		this.path = newPath;
		this.name = newPath.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.setLoggers(`[SharedFile](${this.path})`);
		this.sha256();
	}

	public get lastModified() {
		return this.stat.mtime;
		//return Math.max(this.stat.mtime, this.stat.ctime);
	}

	public get meta(): FileMeta | undefined {
		const meta = this.sharedFolder.syncStore.get(this.path);
		if (isFileMeta(meta)) {
			return meta;
		}
	}

	public set meta(value: FileMeta) {
		this.sharedFolder.syncStore.set(this.path, value);
	}

	public get shouldPull() {
		return (
			(this.meta?.synctime || 0) > this.synctime && this._parent.shouldConnect
		);
	}

	public get shouldPush() {
		if (!this._parent.shouldConnect) {
			return false;
		}
		if (!this.meta) {
			return false;
		}
		const serverOutOfDate = (this.meta.synctime || 0) < this.synctime;
		const serverHasContent = !!this.getRemote();
		return serverOutOfDate || !serverHasContent;
	}

	public get serverHash() {
		return this.meta?.hash;
	}

	public async getRemote() {
		await this._parent.whenSynced();
		if (!this.serverHash) {
			return undefined;
		}
		return await this.sharedFolder.cas.getByHash(this.serverHash);
	}

	public async push(): Promise<string> {
		const fileInfo = await this.getRemote();
		const content = await this.vault.readBinary(this.tfile);
		const hash = await this.sha256(content);
		if (fileInfo?.synchash !== hash) {
			this.log("push", fileInfo, hash);
			try {
				await this.sharedFolder.cas.writeFile(
					{
						guid: fileInfo ? fileInfo.guid : uuidv4(),
						name: this.name,
						synchash: hash,
						ctime: this.stat.ctime,
						mtime: this.stat.mtime,
						parent: null,
						is_directory: false,
						synctime: Date.now(),
					},
					content,
				);
			} catch (e) {
				// ignore duplicates
				this.debug("push error", e);
			}
		}
		this.synctime = Date.now();
		const meta = this.meta;
		if (isFileMeta(meta) && meta.hash !== hash) {
			this.sharedFolder.ydoc.transact(() => {
				this.meta = {
					...meta,
					hash: hash,
					synctime: this.synctime,
				};
			}, this.sharedFolder);
		}
		return hash;
	}

	public async pull() {
		if (!this.serverHash) {
			throw new Error(`${this.path} no server hash for item`);
		}
		this.sharedFolder.cas.getByHash(this.serverHash);
		const fileInfo = await this.getRemote();
		if (!fileInfo) {
			throw new Error(
				`${this.path} (${this.serverHash}) item missing from server`,
			);
		}
		const content = await this.sharedFolder.cas.readFile(fileInfo.id);
		await this.vault.adapter.writeBinary(
			this.sharedFolder.getPath(this.path),
			content,
		);
		await this.sha256(content);
		this._tfile = this.vault.getAbstractFileByPath(
			this.sharedFolder.getPath(this.path),
		) as TFile;
	}

	public get isStale() {
		const hash = this._sha256;
		if (hash !== this.serverHash) {
			this.log("hash stale", hash, this.serverHash);
		}
		return hash !== this.serverHash;
	}

	async sync() {
		if (!this.connected) {
			return;
		}
		if (!this._tfile) {
			await this.pull();
			return;
		}
		await this.sha256();
		if (this.isStale && this.shouldPull) {
			await this.pull();
		} else if (this.isStale && this.shouldPush) {
			await this.push();
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

	public async rename(newPath: string): Promise<void> {
		this.move(newPath);
	}

	public async delete(): Promise<void> {
		return this.vault.delete(this.tfile);
	}

	public async write(content: string): Promise<void> {
		this.vault.adapter.write(this.tfile.path, content);
		this.sha256();
	}

	public async append(content: string): Promise<void> {
		this.vault.append(this.tfile, content);
		this.sha256();
	}

	destroy() {
		this.offFolderStatusListener?.();
		this.offFolderStatusListener = null as any;
		this.offFileInfo?.();
		this.offFileInfo = null as any;

		this._parent = null as any;
		this.relayManager = null as any;
		this._tfile = null as any;
	}
}
