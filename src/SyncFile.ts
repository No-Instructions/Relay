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
import type { Unsubscriber } from "./observable/Observable";
import type { RelayManager } from "./RelayManager";
import { generateHash } from "./hashing";
import type { HasMimeType, IFile } from "./IFile";
import { getMimeType } from "./mimetypes";

export function isSyncFile(file: IFile): file is SyncFile {
	return file instanceof SyncFile;
}

export class ContentAddressedFile extends HasLogging {
	lastRead: number = 0;
	value: string | undefined;
	content: ArrayBuffer | null = null;
	tfile: TFile | null = null;

	constructor(
		private vault: Vault,
		public path: string,
	) {
		super();
		const tfile = this.vault.getAbstractFileByPath(path);
		if (tfile && tfile instanceof TFile) {
			this.tfile = tfile;
			this.sha256();
		}
	}

	public get modifiedAt() {
		if (!this.tfile) {
			throw new Error("missing tfile");
		}
		return this.tfile.stat.mtime;
	}

	async _read() {
		if (!this.tfile) {
			const tfile = this.vault.getAbstractFileByPath(this.path);
			if (tfile && tfile instanceof TFile) {
				this.tfile = tfile;
			} else {
				throw new Error("missing tfile");
			}
		}

		const modifiedAt = this.modifiedAt;
		if (modifiedAt > this.lastRead || this.content === null) {
			this.warn("reading content from disk");
			this.content = await this.vault.readBinary(this.tfile);
			this.value = await generateHash(this.content);
			this.lastRead = modifiedAt;
		}
	}

	async read(): Promise<ArrayBuffer | null> {
		await this._read();
		return this.content;
	}

	public async sha256(): Promise<string> {
		await this._read();
		return this.value as string;
	}

	exists() {
		if (this.tfile) {
			return true;
		}
		const tfile = this.vault.getAbstractFileByPath(this.path);
		if (tfile && tfile instanceof TFile) {
			this.tfile = tfile;
			return true;
		}
		return false;
	}

	clear() {
		this.content = null;
		this.tfile = null;
	}

	destroy() {
		this.vault = null as any;
		this.tfile = null as any;
	}
}

export class SyncFile extends HasLogging implements TFile, IFile, HasMimeType {
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

	constructor(
		public path: string,
		public guid: string,
		private relayManager: RelayManager,
		parent: SharedFolder,
	) {
		super();
		this.s3rn = parent.relayId
			? new S3RemoteFile(parent.relayId, parent.guid, guid)
			: new S3File(parent.guid, guid);
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
		);

		const run = async () => {
			const tfile = this.vault.getAbstractFileByPath(
				this.sharedFolder.getPath(path),
			);
			if (tfile && tfile instanceof TFile) {
				await this.push();
			} else {
				await this.pull();
			}
		};
		run();

		this.log("created");
	}

	public get mimetype(): string {
		return getMimeType(this.path);
	}

	disconnect() {
		// pass
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
	}

	public get lastModified() {
		return this.stat.mtime;
		//return Math.max(this.stat.mtime, this.stat.ctime);
	}

	public async push(): Promise<string> {
		this.log("push");
		if (!this.sharedFolder.syncStore.canSync(this.path)) {
			this.log("skipping push -- filetype is disabled");
			return "";
		}
		const hash = await this.caf.sha256();
		const content = await this.caf.read();
		if (!content) {
			throw new Error("read failed");
		}
		const meta = this.sharedFolder.syncStore.getMeta(this.path);
		if (!meta || (hash && meta.hash !== hash)) {
			await this.sharedFolder.cas.writeFile(this);
			this.sharedFolder.markUploaded(this);
		}
		return this.caf.sha256();
	}

	public async sync() {
		this.log("sync");
		const meta = this.sharedFolder.syncStore.getMeta(this.path);
		if (!meta) {
			await this.push();
		} else {
			const hash = await this.caf.sha256();
			if (hash !== meta.hash) {
				if ((meta as FileMetas).synctime > this.stat.mtime) {
					this.warn(
						"synctime",
						meta.synctime,
						this.meta?.synctime,
						this.stat.mtime,
					);
					await this.pull();
				} else {
					await this.push();
				}
			}
		}
	}

	shouldPull(meta: FileMeta) {
		return !this.tfile || meta.synctime > this.stat.mtime;
	}

	public async pull() {
		this.log("pull");
		const meta = this.sharedFolder.syncStore.getMeta(this.path);
		if (meta) {
			// XXX type casting
			this.meta = meta as FileMetas;
		} else {
			this.warn("meta fail", meta);
		}
		if (!this.meta) {
			throw new Error("cannot pull without meta");
		}
		if (this.caf.exists()) {
			const hash = await this.caf.sha256();
			if (hash === this.meta.hash) {
				return;
			}
		}
		const content = await this.sharedFolder.cas.readFile(this);
		await this.vault.adapter.writeBinary(
			this.sharedFolder.getPath(this.path),
			content,
		);
		this.caf.sha256();
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
		this.caf.clear();
		return this.vault.delete(this.tfile);
	}

	public async write(content: string): Promise<void> {
		this.vault.adapter.write(this.tfile.path, content);
		this.caf.sha256();
	}

	public async append(content: string): Promise<void> {
		this.vault.append(this.tfile, content);
		this.caf.sha256();
	}

	cleanup() {}

	destroy() {
		this.offFileInfo?.();
		this.offFileInfo = null as any;

		this._parent = null as any;
		this.relayManager = null as any;
		this.caf.destroy();
	}
}
