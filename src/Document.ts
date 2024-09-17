"use strict";
import { IndexeddbPersistence, fetchUpdates } from "y-indexeddb";
import * as Y from "yjs";
import { HasProvider } from "./HasProvider";
import { LoginManager } from "./LoginManager";
import { S3Document, S3Folder, S3RemoteDocument } from "./S3RN";
import { SharedFolder } from "./SharedFolder";
import { curryLog } from "./debug";
import type { TFile, Vault, TFolder } from "obsidian";
import type { VaultFacade } from "./obsidian-api/Vault";
import { DiskBuffer } from "./DiskBuffer";
import type { Unsubscriber } from "./observable/Observable";

export class Document extends HasProvider implements TFile {
	guid: string;
	private _parent: SharedFolder;
	private _persistence: IndexeddbPersistence;
	_hasKnownPeers?: boolean;
	path: string;
	_tfile: TFile | null;
	name: string;
	extension: string;
	basename: string;
	vault: Vault;
	stat: {
		ctime: number;
		mtime: number;
		size: number;
	};
	_diskBuffer?: DiskBuffer;
	offFolderStatusListener: Unsubscriber;

	debug!: (message?: any, ...optionalParams: any[]) => void;
	log!: (message?: any, ...optionalParams: any[]) => void;
	warn!: (message?: any, ...optionalParams: any[]) => void;
	error!: (message?: any, ...optionalParams: any[]) => void;

	setLoggers(context: string) {
		this.debug = curryLog(context, "debug");
		this.log = curryLog(context, "log");
		this.warn = curryLog(context, "warn");
		this.error = curryLog(context, "error");
	}

	constructor(
		path: string,
		guid: string,
		loginManager: LoginManager,
		parent: SharedFolder,
	) {
		const s3rn = parent.relayId
			? new S3RemoteDocument(parent.relayId, parent.guid, guid)
			: new S3Document(parent.guid, guid);
		super(s3rn, parent.tokenStore, loginManager);
		this.guid = guid;
		this._parent = parent;
		this.path = path;
		this.name = "[CRDT] " + path.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.vault = (this._parent.vault as VaultFacade).app.vault; // XXX so sick of this..
		this.stat = {
			ctime: Date.now(),
			mtime: Date.now(),
			size: 0,
		};
		this.offFolderStatusListener = this._parent.subscribe(
			this.path,
			(state) => {
				if (state.status === "disconnected") {
					this.disconnect();
				}
			},
		);

		this.setLoggers(`[SharedDoc](${this.path})`);
		this._persistence = new IndexeddbPersistence(this.guid, this.ydoc);
		this.ydoc.on(
			"update",
			(update: Uint8Array, origin: unknown, doc: Y.Doc) => {
				//this.log(`Update from origin`, origin, update);
				this.updateStats();
			},
		);
		this._tfile = null;
	}

	move(newPath: string) {
		this.path = newPath;
		this.name = newPath.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.setLoggers(`[SharedDoc](${this.path})`);
		this.updateStats();
	}

	public get parent(): TFolder | null {
		return this.tfile?.parent || null;
	}

	public get sharedFolder(): SharedFolder {
		return this._parent;
	}
	public get tfile(): TFile | null {
		if (!this._tfile) {
			this._tfile = this._parent.getTFile(this);
		}
		return this._tfile;
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
			const storedContents = await this._parent.diskBufferStore.loadDiskBuffer(
				this.guid,
			);
			if (storedContents !== null) {
				fileContents = storedContents;
			} else {
				fileContents = await this._parent.read(this);
			}
			return this.setDiskBuffer(fileContents);
		}
		return this._diskBuffer;
	}

	setDiskBuffer(contents: string): TFile {
		if (this._diskBuffer) {
			this._diskBuffer.contents = contents;
		} else {
			this._diskBuffer = new DiskBuffer(
				(this._parent.vault as VaultFacade).app.vault,
				"local disk",
				contents,
			);
		}
		this._parent.diskBufferStore.saveDiskBuffer(this.guid, contents);
		return this._diskBuffer;
	}

	async clearDiskBuffer(): Promise<void> {
		if (this._diskBuffer) {
			this._diskBuffer.contents = "";
			this._diskBuffer = undefined;
		}
		await this._parent.diskBufferStore.removeDiskBuffer(this.guid);
	}

	public async checkStale(): Promise<boolean> {
		await this.whenReady();
		const diskBuffer = await this.diskBuffer();
		return this.text.trim() !== (diskBuffer as DiskBuffer).contents.trim();
	}

	connect(): Promise<boolean> {
		if (this.sharedFolder.s3rn instanceof S3Folder) {
			// Local only
			return Promise.resolve(false);
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
		return this.sharedFolder.connect().then((connected) => {
			return super.connect();
		});
	}

	public async whenReady(): Promise<Document> {
		const dependencies = [];
		if (!this._persistence.synced) {
			dependencies.push(this.whenSynced());
		}
		if (!this._provider) {
			dependencies.push(this.withActiveProvider());
		}
		return Promise.all(dependencies).then((_) => {
			return this;
		});
	}

	whenSynced(): Promise<void> {
		if (this._persistence.synced) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this._persistence.once("synced", resolve);
		});
	}

	hasKnownPeers(): Promise<boolean> {
		if (this._hasKnownPeers !== undefined) {
			return Promise.resolve(this._hasKnownPeers);
		}
		return this.whenSynced().then(async () => {
			await fetchUpdates(this._persistence);
			this._hasKnownPeers = this._persistence._dbsize > 3;
			this.log("update count", this.path, this._persistence._dbsize);
			return this._hasKnownPeers;
		});
	}

	destroy() {
		if (this._persistence) {
			this._persistence.destroy();
		}
		this.offFolderStatusListener();
		super.destroy();
		this.ydoc.destroy();
		if (this._diskBuffer) {
			this._diskBuffer.contents = "";
			this._diskBuffer = undefined;
		}
	}

	public async read(): Promise<string> {
		return this.text;
	}

	public async rename(newPath: string): Promise<void> {
		this.move(newPath);
	}

	public async delete(): Promise<void> {
		this.destroy();
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
