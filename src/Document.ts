"use strict";
import { IndexeddbPersistence } from "y-indexeddb";
import * as idb from "lib0/indexeddb";
import * as Y from "yjs";
import { HasProvider } from "./HasProvider";
import { LoginManager } from "./LoginManager";
import { S3Document, S3Folder, S3RN, S3RemoteDocument } from "./S3RN";
import { SharedFolder } from "./SharedFolder";
import { curryLog } from "./debug";
import type { TFile, Vault, TFolder } from "obsidian";
import { DiskBuffer, DiskBufferStore } from "./DiskBuffer";
import type { Unsubscriber } from "./observable/Observable";
import { SharedPromise } from "./promiseUtils";
import { withFlag } from "./flagManager";
import { flag } from "./flags";

export class Document extends HasProvider implements TFile {
	_dbsize?: number;
	private _parent: SharedFolder;
	private _persistence: IndexeddbPersistence;
	whenSyncedPromise: SharedPromise<void> | null = null;
	persistenceSynced: boolean = false;
    _awaitingUpdates?: boolean;
	readyPromise?: SharedPromise<Document>;
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

	move(newPath: string) {
		this.path = newPath;
		this.name = newPath.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
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
				return this.setDiskBuffer(fileContents.replace("\r\n", "\n"));
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
		const stale = this.text !== contents;
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
		const persistenceSynced = this._persistence.synced;
		return (
			persistenceSynced &&
			(this.synced || !!this._serverSynced || this._origin === "local")
		);
	}

	hasLocalDB() {
		return (
			!!this._serverSynced ||
			this._persistence._dbsize > 3 ||
			!!(this._dbsize && this._dbsize > 3)
		);
	}

	async awaitingUpdates(): Promise<boolean> {
		await this.whenSynced();
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
			new SharedPromise<Document>(promiseFn, (): [boolean, Document] => {
				return [this.ready, this];
			});
		return this.readyPromise.getPromise();
	}

	whenSynced(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			await this.sharedFolder.whenSynced();
			// Check if already synced first
			if (this._persistence.synced) {
				await this.count();
				this.persistenceSynced = true;
				return;
			}

			return new Promise<void>((resolve) => {
				this._persistence.once("synced", async () => {
					await this.count();
					this.persistenceSynced = true;
					resolve();
				});
			});
		};

		this.whenSyncedPromise =
			this.whenSyncedPromise ||
			new SharedPromise<void>(promiseFn, (): [boolean, void] => {
				return [this.persistenceSynced, undefined];
			});
		return this.whenSyncedPromise.getPromise();
	}

	async hasKnownPeers(): Promise<boolean> {
		await this.whenSynced();
		return this.hasLocalDB();
	}

	private _origin?: string;

	async markOrigin(origin: "local" | "remote"): Promise<void> {
		this._origin = origin;
		await this._persistence.set("origin", origin);
	}

	async getOrigin(): Promise<string | undefined> {
		if (this._origin !== undefined) {
			return this._origin;
		}
		this._origin = await this._persistence.get("origin");
		return this._origin;
	}

	_serverSynced?: boolean;
	async markSynced(): Promise<void> {
		this._serverSynced = true;
		await this._persistence.set("serverSync", 1);
	}

	async getServerSynced(): Promise<boolean> {
		if (this._serverSynced !== undefined) {
			return this._serverSynced;
		}
		const serverSync = await this._persistence.get("serverSync");
		if (serverSync === 1) {
			this._serverSynced = true;
			return this._serverSynced;
		}
		return false;
	}

	async count(): Promise<number> {
		// XXX this is to workaround the y-indexeddb not counting records until after the synced event
		if (this._persistence.db === null) {
			throw new Error("database not ready yet");
		}
		if (this._persistence._dbsize > 3) {
			this._dbsize = this._persistence._dbsize;
			return this._dbsize;
		}
		const [updatesStore] = idb.transact(
			this._persistence.db,
			["updates"],
			"readonly",
		);
		const cnt = await idb.count(updatesStore);
		this._dbsize = cnt;
		return this._dbsize;
	}

	public get dbsize() {
		if (!this._dbsize) {
			throw new Error("dbsize accessed before count");
		}
		return this._persistence._dbsize === 0 && this._dbsize
			? this._dbsize
			: this._persistence._dbsize;
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
