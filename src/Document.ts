"use strict";
import { IndexeddbPersistence, fetchUpdates } from "y-indexeddb";
import * as Y from "yjs";
import { HasProvider } from "./HasProvider";
import { LoginManager } from "./LoginManager";
import { S3Document, S3Folder, S3RemoteDocument } from "./S3RN";
import { SharedFolder } from "./SharedFolder";
import type { TFile, Vault, TFolder } from "obsidian";
import { DiskBuffer } from "./DiskBuffer";
import type { Unsubscriber } from "./observable/Observable";
import type { IFile } from "./SyncFile";

export class Document extends HasProvider implements IFile {
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
		this.setLoggers(this.name);
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.vault = this._parent.vault;
		this.stat = {
			ctime: Date.now(),
			mtime: Date.now(),
			size: 0,
		};
		this.offFolderStatusListener = this._parent.subscribe(
			this.path,
			(state) => {
				if (state.intent === "disconnected") {
					this.disconnect();
				}
			},
		);

		try {
			this._persistence = new IndexeddbPersistence(this.guid, this.ydoc);
		} catch (e) {
			this.warn("Unable to open persistence.", this.guid);
			console.error(e);
			throw e;
		}

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
		this.updateStats();
	}

	async pull() {
		console.log("pulling document contents");
		await this.sharedFolder.backgroundSync.getDocument(this);
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
			try {
				const storedContents = await this._parent.diskBufferStore
					.loadDiskBuffer(this.guid)
					.catch((e) => {
						return null;
					});
				if (storedContents !== null && storedContents !== "") {
					fileContents = storedContents;
				} else {
					fileContents = await this._parent.read(this);
				}
				return this.setDiskBuffer(fileContents);
			} catch (e) {
				console.error(e);
				throw e;
			}
		}
		return this._diskBuffer;
	}

	setDiskBuffer(contents: string): TFile {
		if (this._diskBuffer) {
			this._diskBuffer.contents = contents;
		} else {
			this._diskBuffer = new DiskBuffer(
				this._parent.vault,
				"local disk",
				contents,
			);
		}
		this._parent.diskBufferStore
			.saveDiskBuffer(this.guid, contents)
			.catch((e) => {});
		return this._diskBuffer;
	}

	async clearDiskBuffer(): Promise<void> {
		if (this._diskBuffer) {
			this._diskBuffer.contents = "";
			this._diskBuffer = undefined;
		}
		await this._parent.diskBufferStore
			.removeDiskBuffer(this.guid)
			.catch((e) => {});
	}

	public async checkStale(): Promise<boolean> {
		await this.whenReady();
		const hasKnownPeers = await this.hasKnownPeers();
		const diskBuffer = await this.diskBuffer(true);
		if (!hasKnownPeers && this.text.trim() === "") {
			return false;
		}
		const contents = (diskBuffer as DiskBuffer).contents;
		const stale = this.text.trim() !== contents.trim();
		if (!stale) {
			this.clearDiskBuffer();
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

	public get persistenceSynced(): boolean {
		return this._persistence.synced;
	}

	hasLocalDB() {
		return this._persistence._dbsize > 3;
	}

	hasKnownPeers(): Promise<boolean> {
		if (this._hasKnownPeers !== undefined) {
			return Promise.resolve(this._hasKnownPeers);
		}
		return this.whenSynced().then(async () => {
			await fetchUpdates(this._persistence);
			this._hasKnownPeers = this._persistence._dbsize > 3;
			this.debug("update count", this.path, this._persistence._dbsize);
			return this._hasKnownPeers;
		});
	}

	public get dbsize() {
		return this._persistence._dbsize;
	}

	destroy() {
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
