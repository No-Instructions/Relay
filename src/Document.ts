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
				this.sharedFolder.markUploaded(this);
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
						return null;
					});
				if (storedContents !== null && storedContents !== "") {
					fileContents = storedContents;
				} else {
					fileContents = await this._parent.read(this);
				}
				return this.setDiskBuffer(fileContents.replace(/\r\n/g, "\n"));
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
		await this.whenSynced();
		const diskBuffer = await this.diskBuffer(true);
		const contents = (diskBuffer as DiskBuffer).contents;
		const response = await this.sharedFolder.backgroundSync.downloadItem(this);
		const updateBytes = new Uint8Array(response.arrayBuffer);

		Y.applyUpdate(this.ydoc, updateBytes);
		const stale = this.text !== contents;

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

	save() {
		if (!this.tfile) {
			return;
		}
		this.vault.modify(this.tfile, this.text);
		this.warn("file saved", this.path);
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
