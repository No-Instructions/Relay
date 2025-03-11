"use strict";
import * as Y from "yjs";
import {
	FileManager,
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	debounce,
	normalizePath,
} from "obsidian";
import { IndexeddbPersistence } from "y-indexeddb";
import * as idb from "lib0/indexeddb";
import { v4 as uuidv4 } from "uuid";
import { dirname, join, sep } from "path-browserify";
import { Doc } from "yjs";
import { HasProvider, type ConnectionIntent } from "./HasProvider";
import { Document } from "./Document";
import { ObservableSet } from "./observable/ObservableSet";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";
import { SharedPromise, Dependency, withTimeoutWarning } from "./promiseUtils";
import { S3Folder, S3RN, S3RemoteFolder } from "./S3RN";
import type { RemoteSharedFolder } from "./Relay";
import { RelayManager } from "./RelayManager";
import type { Unsubscriber } from "svelte/store";
import { withFlag } from "./flagManager";
import { flag } from "./flags";
import { DiskBufferStore } from "./DiskBuffer";
import { BackgroundSync } from "./BackgroundSync";
import type { NamespacedSettings } from "./SettingsStorage";
import { RelayInstances } from "./debug";
import { LocalStorage } from "./LocalStorage";

export interface SharedFolderSettings {
	guid: string;
	path: string;
	relay?: string;
	connect?: boolean;
}

interface Operation {
	op: "create" | "rename" | "delete" | "noop";
	path: string;
	promise: Promise<void> | Promise<Document>;
}

interface Create extends Operation {
	op: "create";
	path: string;
	promise: Promise<Document>;
}

interface Rename extends Operation {
	op: "rename";
	path: string;
	from: string;
	to: string;
	promise: Promise<void>;
}

interface Delete extends Operation {
	op: "delete";
	path: string;
	promise: Promise<void>;
}

interface Noop extends Operation {
	op: "noop";
	path: string;
	promise: Promise<void>;
}

type OperationType = Create | Rename | Delete | Noop;

class Documents extends ObservableSet<Document> {
	// Startup performance optimization
	notifyListeners = debounce(super.notifyListeners, 100);

	update() {
		this.notifyListeners();
		return;
	}

	add(item: Document, update = true): ObservableSet<Document> {
		update = update && !this._set.has(item);
		this._set.add(item);
		if (update) {
			this.notifyListeners();
		}
		return this;
	}
}

export class SharedFolder extends HasProvider {
	path: string;
	ids: Y.Map<string>; // Maps document paths to guids
	docs: Map<string, Document>; // Maps guids to SharedDocs
	docset: Documents;
	relayId?: string;
	_dbsize?: number;
	_remote?: RemoteSharedFolder;
	_shouldConnect: boolean;
	destroyed: boolean = false;
	public vault: Vault;
	private fileManager: FileManager;
	private relayManager: RelayManager;
	private readyPromise: Dependency<SharedFolder> | null = null;
	private whenSyncedPromise: Dependency<void> | null = null;
	private persistenceSynced: boolean = false;
	private syncFileTreePromise: SharedPromise<void> | null = null;
	private syncRequestedDuringSync: boolean = false;
	private authoritative: boolean;
	private pendingUpload: LocalStorage<string>;
	private unsubscribes: Unsubscriber[] = [];

	private _persistence: IndexeddbPersistence;
	diskBufferStore: DiskBufferStore;

	private addLocalDocs = () => {
		const files = this.getFiles();
		const docs: Document[] = [];
		const vpaths: string[] = [];
		files.forEach((file) => {
			// if the file is in the shared folder and not in the map, move it to the Trash
			if (!this.checkPath(file.path)) {
				return;
			}
			if (!this.ids.has(file.path)) {
				vpaths.push(this.getVirtualPath(file.path));
			}
		});
		const newDocs = this.placeHold(vpaths);
		files.forEach((file) => {
			if (!this.checkPath(file.path)) {
				return;
			}
			if (!Document.checkExtension(file.path)) {
				return;
			}
			if (file instanceof TFolder) {
				return;
			}
			const vpath = this.getVirtualPath(file.path);
			const upload = newDocs.contains(vpath);
			if (upload) {
				const doc = this.uploadDoc(vpath, false);
				docs.push(doc);
			} else {
				const doc = this.getDoc(vpath, false);
				docs.push(doc);
			}
		});
		if (docs.length > 0) {
			this.docset.update();
		}
	};

	constructor(
		public appId: string,
		guid: string,
		path: string,
		loginManager: LoginManager,
		vault: Vault,
		fileManager: FileManager,
		tokenStore: LiveTokenStore,
		relayManager: RelayManager,
		public backgroundSync: BackgroundSync,
		private _settings: NamespacedSettings<SharedFolderSettings>,
		relayId?: string,
		awaitingUpdates: boolean = true,
	) {
		const s3rn = relayId
			? new S3RemoteFolder(relayId, guid)
			: new S3Folder(guid);

		super(guid, s3rn, tokenStore, loginManager);
		this.path = path;
		this.setLoggers(`[SharedFile](${this.path})`);
		this.fileManager = fileManager;
		this.vault = vault;
		this.ids = this.ydoc.getMap("docs");
		this.docs = new Map();
		this.docset = new Documents();
		this.pendingUpload = new LocalStorage<string>(
			`${appId}-system3-relay/folders/${this.guid}/pendingUploads`,
		);
		this.relayManager = relayManager;
		this.relayId = relayId;
		this.diskBufferStore = new DiskBufferStore();
		this._shouldConnect = this.settings.connect ?? true;

		this.authoritative = !awaitingUpdates;

		this.unsubscribes.push(
			this.relayManager.remoteFolders.subscribe((folders) => {
				this.remote = folders.find((folder) => folder.guid == this.guid);
			}),
		);

		try {
			this._persistence = new IndexeddbPersistence(this.guid, this.ydoc);
		} catch (e) {
			this.warn("Unable to open persistence.", this.guid);
			console.error(e);
			throw e;
		}

		if (loginManager.loggedIn) {
			this.connect();
		}

		this.whenReady().then(async () => {
			if (!this.destroyed) {
				this.addLocalDocs();
				await this.syncFileTree(this.ydoc);
			}
		});

		withFlag(flag.enableDeltaLogging, () => {
			const logObserver = (event: Y.YMapEvent<string>) => {
				let log = "";
				log += `Transaction origin: ${event.transaction.origin}${event.transaction.origin?.constructor?.name}\n`;
				event.changes.keys.forEach((change, key) => {
					if (change.action === "add") {
						log += `Added ${key}: ${this.ids.get(key)}\n`;
					}
					if (change.action === "update") {
						log += `Updated ${key}: ${this.ids.get(key)}\n`;
					}
					if (change.action === "delete") {
						log += `Deleted ${key}\n`;
					}
				});
				this.debug(log);
			};
			this.ids.observe(logObserver);
			this.unsubscribes.push(() => {
				this.ids.unobserve(logObserver);
			});
		});

		this.whenSynced().then(async () => {
			const syncFileObserver = async (event: Y.YMapEvent<string>) => {
				if (event.changes.keys.size === 0) {
					this.log("no changes detected");
					return;
				}

				const origin = event.transaction.origin;
				if (origin == this) return;

				this.log("file tree", this._debugFileTree());
				// TODO use event changes to simplify
				await this.syncFileTree(this.ydoc);
			};
			this.ids.observe(syncFileObserver);
			this.unsubscribes.push(() => {
				this.ids.unobserve(syncFileObserver);
			});
			try {
				this._persistence.set("path", this.path);
				this._persistence.set("relay", this.relayId || "");
				this._persistence.set("appId", this.appId);
				this._persistence.set("s3rn", S3RN.encode(this.s3rn));
			} catch (e) {
				// pass
			}
		});

		(async () => {
			const serverSynced = await this.getServerSynced();
			if (!serverSynced) {
				await this.onceProviderSynced();
				await this.markSynced();
			}
		})();

		RelayInstances.set(this, this.path);
	}

	public get shouldConnect(): boolean {
		return this._shouldConnect;
	}

	public set shouldConnect(connect: boolean) {
		this._settings.update((current) => ({
			...current,
			connect,
		}));
		this._shouldConnect = connect;
	}

	async netSync() {
		await this.whenReady();
		this.addLocalDocs();
		await this.syncFileTree(this.ydoc);
		this.backgroundSync.enqueueSharedFolderSync(this);
	}

	public get settings(): SharedFolderSettings {
		return this._settings.get();
	}

	getFiles(): TFile[] {
		const folder = this.vault.getAbstractFileByPath(this.path);
		if (!(folder instanceof TFolder)) {
			throw new Error(
				`Could not find shared folders on file system at ${this.path}`,
			);
		}
		const files: TFile[] = [];
		Vault.recurseChildren(folder, (file: TAbstractFile) => {
			if (file instanceof TFile) {
				files.push(file);
			}
		});
		return files;
	}

	connect(): Promise<boolean> {
		if (this.s3rn instanceof S3RemoteFolder) {
			if (this.connected || this.shouldConnect) {
				// XXX group queue by folder
				this.backgroundSync.resume();
				return super.connect();
			}
		}
		return Promise.resolve(false);
	}

	public get name(): string {
		return this.path.split("/").pop() || "";
	}

	public get location(): string {
		return this.path.split("/").slice(0, -1).join("/");
	}

	public get remote(): RemoteSharedFolder | undefined {
		try {
			// FIXME: race condition because sharedFolder doesn't use postie
			// for notifyListener updates.
			this._remote?.relay;
		} catch (e) {
			return undefined;
		}
		return this._remote;
	}

	public set remote(value: RemoteSharedFolder | undefined) {
		if (this._remote === value) {
			return;
		}
		this._remote = value;
		this.relayId = value?.relay?.guid;
		this.s3rn = this.relayId
			? new S3RemoteFolder(this.relayId, this.guid)
			: new S3Folder(this.guid);
		this._settings.update((current) => {
			if (this.relayId) {
				return {
					guid: this.guid,
					path: this.path,
					relay: this.relayId,
				};
			}
			return {
				guid: this.guid,
				path: this.path,
			};
		});
		this.notifyListeners();
	}

	public get ready(): boolean {
		return (
			this.persistenceSynced &&
			(this.authoritative || this._serverSynced || this.synced)
		);
	}

	async count(): Promise<number> {
		// XXX this is to workaround the y-indexeddb not counting records until after the synced event
		if (this._persistence.db === null) {
			throw new Error("unexpected missing database");
		}
		if (this._dbsize) {
			return this._dbsize;
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

	private _serverSynced?: boolean;
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

	private hasLocalDB() {
		// This is a bad hueristic
		return (
			this._persistence._dbsize > 3 || !!(this._dbsize && this._dbsize > 3)
		);
	}

	async awaitingUpdates(): Promise<boolean> {
		await this.whenSynced();
		if (this.authoritative) {
			return false;
		}
		const serverSynced = await this.getServerSynced();
		if (serverSynced) {
			return false;
		}
		return !this.hasLocalDB();
	}

	whenReady(): Promise<SharedFolder> {
		const promiseFn = async (): Promise<SharedFolder> => {
			const awaitingUpdates = await this.awaitingUpdates();
			if (awaitingUpdates) {
				// If this is a brand new shared folder, we want to wait for a connection before we start reserving new guids for local files.
				this.connect();
				await this.onceConnected();
				await this.onceProviderSynced();
				return this;
			}
			// If this is a shared folder with edits, then we can behave as though we're just offline.
			return this;
		};
		this.readyPromise =
			this.readyPromise ||
			new Dependency<SharedFolder>(promiseFn, (): [boolean, SharedFolder] => {
				return [this.ready, this];
			});
		return this.readyPromise.getPromise();
	}

	_debugFileTree() {
		const ids = new Map();
		this.ydoc.getMap("docs")._map.forEach((item, path) => {
			if (item.content instanceof Y.ContentAny) {
				ids.set(path, item.content.arr[0]);
			} else {
				ids.set(path, item.content);
			}
		});
		return ids;
	}

	whenSynced(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
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
			new Dependency<void>(promiseFn, (): [boolean, void] => {
				if (this._persistence.synced && this._dbsize) {
					this.persistenceSynced = true;
				}
				return [this.persistenceSynced, undefined];
			});
		return this.whenSyncedPromise.getPromise();
	}

	public get intent(): ConnectionIntent {
		return this.shouldConnect ? "connected" : "disconnected";
	}

	async _handleServerRename(
		doc: Document,
		path: string,
		file: TAbstractFile,
		diffLog?: string[],
	): Promise<void> {
		// take a doc and it's new path.
		diffLog?.push(`${file.path} was renamed to ${path}`);
		const dir = dirname(path);
		if (!this.existsSync(dir)) {
			await this.mkdir(dir);
			diffLog?.push(`creating directory ${dir}`);
		}
		this.fileManager
			.renameFile(file, normalizePath(this.getPath(path)))
			.then(() => {
				doc.move(path);
			});
	}

	async _handleServerCreate(
		vpath: string,
		diffLog?: string[],
	): Promise<Document> {
		const dir = dirname(vpath);
		if (!this.existsSync(dir)) {
			await this.mkdir(dir);
			diffLog?.push(`creating directory ${dir}`);
		}
		const doc = await this.downloadDoc(vpath, false);
		diffLog?.push(`created local file for remotely added doc ${vpath}`);
		return doc;
	}

	private _assertNamespacing(path: string) {
		// Check if the path is valid (inside of shared folder), otherwise delete
		try {
			this.assertPath(this.path + path);
		} catch {
			this.error("Deleting doc (somehow moved outside of shared folder)", path);
			this.ids.delete(path);
			return;
		}
	}

	private applyRemoteState(
		guid: string,
		path: string,
		remoteIds: Set<string>,
		diffLog: string[],
	): OperationType {
		const doc = this.docs.get(guid);
		if (this.existsSync(path) || !Document.checkExtension(path)) {
			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (remoteIds.has(guid) && doc) {
			const oldPath = this.getPath(doc.path);
			const file = this.vault.getAbstractFileByPath(oldPath);
			if (file) {
				const promise = this._handleServerRename(doc, path, file, diffLog);
				return {
					op: "rename",
					path: path,
					from: oldPath,
					to: path,
					promise,
				};
			}
		}

		// write will trigger `create` which will read the file from disk by default.
		// so we need to pre-empt that by loading the file into docs.
		const promise = this._handleServerCreate(path, diffLog);
		return { op: "create", path, promise };
	}

	private cleanupExtraLocalFiles(
		remotePaths: string[],
		diffLog: string[],
	): Delete[] {
		// Delete files that are no longer shared
		const files = this.getFiles();
		const deletes: Delete[] = [];
		files.forEach((file) => {
			// If the file is in the shared folder and not in the map, move it to the Trash
			const isMarkdown = Document.checkExtension(file.path);
			const fileInFolder = this.checkPath(file.path);
			const fileInMap = remotePaths.contains(file.path.slice(this.path.length));
			const filePending = this.pendingUpload.has(
				this.getVirtualPath(file.path),
			);
			const synced = this._provider?.synced && this._persistence?.synced;
			if (fileInFolder && !fileInMap && !filePending && isMarkdown) {
				if (synced) {
					diffLog.push(
						`deleted local file ${file.path} for remotely deleted doc`,
					);
					const promise = this.vault.adapter.trashLocal(file.path);
					deletes.push({ op: "delete", path: file.path, promise });
				}
			}
		});
		return deletes;
	}

	syncFileTree(doc: Doc): Promise<void> {
		// If a sync is already running, mark that we want another sync after
		if (this.syncFileTreePromise) {
			this.syncRequestedDuringSync = true;
			const promise = this.syncFileTreePromise.getPromise();
			promise.then(() => {
				if (this.syncRequestedDuringSync) {
					this.syncRequestedDuringSync = false;
					return this.syncFileTree(doc);
				}
			});
			return promise;
		}

		const promiseFn = async (): Promise<void> => {
			try {
				const ops: Operation[] = [];
				const map = doc.getMap<string>("docs");
				const diffLog: string[] = [];

				this.ydoc.transact(() => {
					map.forEach((_, path) => {
						this._assertNamespacing(path);
					});
					const remoteIds = new Set(this.ids.values());
					map.forEach((guid, path) => {
						this._assertNamespacing(path);
						ops.push(this.applyRemoteState(guid, path, remoteIds, diffLog));
					});
				});

				const creates = ops.filter((op) => op.op === "create");
				const renames = ops.filter((op) => op.op === "rename");
				const remotePaths = ops.map((op) => op.path);

				// Ensure these complete before checking for deletions
				await Promise.all(
					[...creates, ...renames].map((op) =>
						withTimeoutWarning<Document | void>(op.promise, op),
					),
				);

				const deletes = this.cleanupExtraLocalFiles(remotePaths, diffLog);

				if (renames.length > 0 || creates.length > 0 || deletes.length > 0) {
					this.docset.update();
				}
				this.log("syncFileTree diff:\n" + diffLog.join("\n"));
			} finally {
				// Reset the promise after completion (success or failure)
				this.syncFileTreePromise = null;
			}
		};

		this.syncFileTreePromise = new SharedPromise<void>(promiseFn);

		return this.syncFileTreePromise.getPromise();
	}

	move(path: string) {
		this.path = path;
		this.setLoggers(`[SharedFile](${this.path})`);
		this._settings.update((current) => ({
			...current,
			path,
		}));
	}

	read(doc: Document): Promise<string> {
		const vaultPath = join(this.path, doc.path);
		return this.vault.adapter.read(normalizePath(vaultPath));
	}

	existsSync(path: string): boolean {
		const vaultPath = normalizePath(join(this.path, path));
		const pathExists = this.vault.getAbstractFileByPath(vaultPath) !== null;
		return pathExists;
	}

	exists(doc: Document): Promise<boolean> {
		const vaultPath = join(this.path, doc.path);
		return this.vault.adapter.exists(normalizePath(vaultPath));
	}

	flush(doc: Document, content: string): Promise<void> {
		const vaultPath = join(this.path, doc.path);
		this.log("writing to ", normalizePath(vaultPath));
		return this.vault.adapter.write(normalizePath(vaultPath), content);
	}

	getPath(path: string): string {
		return join(this.path, path);
	}

	assertPath(path: string) {
		if (!this.checkPath(path)) {
			throw new Error("Path is not in shared folder: " + path);
		}
	}

	mkdir(path: string): Promise<void> {
		const vaultPath = join(this.path, path);
		return this.vault.adapter.mkdir(normalizePath(vaultPath));
	}

	checkPath(path: string): boolean {
		return path.startsWith(this.path + sep);
	}

	getVirtualPath(path: string): string {
		this.assertPath(path);

		const vPath = path.slice(this.path.length);
		return vPath;
	}

	public async getFile(path: string): Promise<Document> {
		// Get a file from disk for immediate use (in the editor, or on create)
		const vPath = this.getVirtualPath(path);
		if (!Document.checkExtension(path)) {
			throw new Error("bad extension!");
		}
		return this.getDoc(vPath, true);
	}

	getTFile(doc: Document): TFile | null {
		const maybeTFile = this.vault.getAbstractFileByPath(this.getPath(doc.path));
		if (maybeTFile instanceof TFile) {
			return maybeTFile;
		}
		return null;
	}

	private getDoc(vpath: string, update = true): Document {
		const id = this.ids.get(vpath) || this.pendingUpload.get(vpath);
		if (id !== undefined) {
			const doc = this.docs.get(id);
			if (doc !== undefined) {
				doc.move(vpath);
				return doc;
			} else {
				// the ID exists, but the file doesn't
				this.log("[getDoc]: creating doc for shared ID");
				return this.createDoc(vpath, update);
			}
		} else {
			// the File exists, but the ID doesn't
			this.warn("[getDoc]: creating new shared ID for existing file");
			const newDocs = this.placeHold([vpath]);
			if (newDocs.length > 0) {
				return this.uploadDoc(vpath);
			} else {
				return this.createDoc(vpath, update);
			}
		}
	}

	placeHold(vpaths: string[]): string[] {
		const newDocs: string[] = [];
		vpaths.forEach((vpath) => {
			if (!this.ids.has(vpath) && !this.pendingUpload.has(vpath)) {
				this.debug("creating entirely new doc for", vpath);
				const guid = uuidv4();
				newDocs.push(vpath);
				this.pendingUpload.set(vpath, guid);
			}
		});
		return newDocs;
	}

	public viewFile(path: string): Document | undefined {
		const vPath = this.getVirtualPath(path);
		if (!Document.checkExtension(path)) {
			throw new Error("bad extension!");
		}
		return this.viewDoc(vPath);
	}

	private viewDoc(vpath: string): Document | undefined {
		const guid = this.ids.get(vpath) || this.pendingUpload.get(vpath);
		if (!guid) return;
		const doc = this.docs.get(guid);
		return doc;
	}

	async downloadDoc(vpath: string, update = true): Promise<Document> {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.ids.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.ids.get(vpath);
		if (!guid) {
			throw new Error(`called download on item that is not in ids ${vpath}`);
		}

		const doc =
			this.docs.get(guid) || new Document(vpath, guid, this.loginManager, this);
		doc.markOrigin("remote");

		await withTimeoutWarning(
			this.backgroundSync.enqueueDownload(doc),
			doc.path,
		);

		this.docs.set(guid, doc);
		this.docset.add(doc, update);

		return doc;
	}

	uploadDoc(vpath: string, update = true): Document {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (
			!this.synced &&
			!this.ids.has(vpath) &&
			!this.pendingUpload.has(vpath)
		) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid: string | undefined =
			this.ids.get(vpath) || this.pendingUpload.get(vpath);
		if (!guid) {
			throw new Error("missing guid");
		}
		const doc =
			this.docs.get(guid) || new Document(vpath, guid, this.loginManager, this);

		const originPromise = doc.getOrigin();
		const awaitingUpdatesPromise = this.awaitingUpdates();

		(async () => {
			const exists = await this.exists(doc);
			if (!exists) {
				throw new Error(`Upload failed, doc does not exist at ${vpath}`);
			}
			const [contents, origin, awaitingUpdates] = await Promise.all([
				this.read(doc),
				originPromise,
				awaitingUpdatesPromise,
			]);
			const text = doc.ydoc.getText("contents");
			if (!awaitingUpdates && origin === undefined) {
				this.log(`[${doc.path}] No Known Peers: Syncing file into ytext.`);
				this.ydoc.transact(() => {
					text.insert(0, contents);
				}, this._persistence);
				doc.markOrigin("local");
				this.log(`[${doc.path}] Uploading file`);
				await this.backgroundSync.enqueueSync(doc);
				this.markUploaded(doc);
			}
		})();

		this.docs.set(guid, doc);
		this.docset.add(doc, update);
		return doc;
	}

	markUploaded(doc: Document) {
		if (!this.ids.has(doc.path)) {
			if (doc._serverSynced) {
				this.ydoc.transact(() => {
					this.log(`[${doc.path}] File uploaded: adding to set`);
					this.ids.set(doc.path, doc.guid);
					this.pendingUpload.delete(doc.path);
				}, this);
			}
		}
	}

	createDoc(vpath: string, update = true): Document {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (
			!this.synced &&
			!this.ids.has(vpath) &&
			!this.pendingUpload.get(vpath)
		) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.ids.get(vpath) || this.pendingUpload.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const doc =
			this.docs.get(guid) || new Document(vpath, guid, this.loginManager, this);

		(async () => {
			this.whenReady().then(async () => {
				const synced = await doc.getServerSynced();
				if (doc.tfile?.stat.size === 0 && !synced) {
					this.backgroundSync.enqueueDownload(doc);
				} else if (this.pendingUpload.get(doc.path)) {
					this.backgroundSync.enqueueSync(doc);
				}
			});
		})();

		this.docs.set(guid, doc);
		this.docset.add(doc, update);

		return doc;
	}

	deleteFile(path: string) {
		const vPath = this.getVirtualPath(path);
		return this.deleteDoc(vPath);
	}

	deleteDoc(vPath: string) {
		const guid = this.ids.get(vPath) || this.pendingUpload.get(vPath);
		if (guid) {
			this.ydoc.transact(() => {
				this.ids.delete(vPath);
				this.pendingUpload.delete(vPath);
				const doc = this.docs.get(guid);
				if (doc) {
					doc._diskBufferStore?.removeDiskBuffer(guid);
					doc.destroy();
					this.docset.delete(doc);
				}
				this.docs.delete(guid);
			}, this);
		}
	}

	renameFile(newPath: string, oldPath: string) {
		let newVPath = "";
		let oldVPath = "";
		try {
			newVPath = this.getVirtualPath(newPath);
		} catch {
			this.log("Moving out of shared folder");
		}
		try {
			oldVPath = this.getVirtualPath(oldPath);
		} catch {
			this.log("Moving in from outside of shared folder");
		}

		if (!newVPath && !oldVPath) {
			// not related to shared folders
			return;
		} else if (!oldVPath) {
			// if this was moved from outside the shared folder context, we need to create a live doc
			this.assertPath(newPath);
			if (!Document.checkExtension(newPath)) return;
			this.placeHold([newVPath]);
			this.uploadDoc(newVPath);
		} else {
			// live doc exists
			const guid = this.ids.get(oldVPath) || this.pendingUpload.get(oldVPath);
			if (!guid) return;
			const doc = this.docs.get(guid);
			if (!newVPath) {
				// moving out of shared folder.. destroy the live doc.
				this.ydoc.transact(() => {
					this.ids.delete(oldVPath);
				}, this);
				this.pendingUpload.delete(oldVPath);
				if (doc) {
					doc.destroy();
					this.docset.delete(doc);
				}
				this.docs.delete(guid);
			} else {
				// moving within shared folder.. move the live doc.
				const guid = this.ids.get(oldVPath) || this.pendingUpload.get(oldVPath);
				if (!guid) {
					return;
				}
				const upload = this.pendingUpload.get(oldVPath);
				if (upload) {
					this.pendingUpload.set(newVPath, upload);
					this.pendingUpload.delete(oldVPath);
				} else {
					this.ydoc.transact(() => {
						if (this.ids.has(oldVPath)) {
							this.ids.set(newVPath, guid);
							this.ids.delete(oldVPath);
						}
					}, this);
				}
				if (doc) {
					doc.move(newVPath);
				}
			}
		}
	}

	destroy() {
		this.destroyed = true;
		this.docs.forEach((doc: Document) => {
			doc.destroy();
			this.docs.delete(doc.guid);
		});
		super.destroy();
		this.ydoc.destroy();
		this.docset.clear();
		this.unsubscribes.forEach((unsubscribe) => {
			unsubscribe();
		});
		this._settings.destroy();
		this._settings = null as any;
		this.diskBufferStore = null as any;
		this.relayManager = null as any;
		this.backgroundSync = null as any;
		this.loginManager = null as any;
		this.tokenStore = null as any;
		this.fileManager = null as any;
		this.vault = null as any;

		this.whenSyncedPromise?.destroy();
		this.whenSyncedPromise = null as any;
		this.readyPromise?.destroy();
		this.readyPromise = null as any;
		this.syncFileTreePromise?.destroy();
		this.syncFileTreePromise = null as any;
	}
}
export class SharedFolders extends ObservableSet<SharedFolder> {
	private folderBuilder: (
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
	) => SharedFolder;
	private _offRemoteUpdates?: () => void;
	private unsubscribes: Unsubscriber[] = [];

	constructor(
		private relayManager: RelayManager,
		private vault: Vault,
		folderBuilder: (
			path: string,
			guid: string,
			relayId?: string,
			awaitingUpdates?: boolean,
		) => SharedFolder,
		private settings: NamespacedSettings<SharedFolderSettings[]>,
	) {
		super();
		this.folderBuilder = folderBuilder;

		if (!this._offRemoteUpdates) {
			this._offRemoteUpdates = this.relayManager.remoteFolders.subscribe(
				(remotes) => {
					let updated = false;
					this.items().forEach((folder) => {
						const remote = remotes.find((remote) => remote.guid == folder.guid);
						if (folder.remote != remote) {
							updated = true;
						}
						folder.remote = remote;
					});
					if (updated) {
						this.update();
					}
				},
			);
		}
	}

	public delete(item: SharedFolder): boolean {
		item?.destroy();
		const deleted = super.delete(item);
		this.settings.update((current) => {
			return current.filter((settings) => settings.guid !== item.guid);
		});
		return deleted;
	}

	update = debounce(this.notifyListeners, 100);

	lookup(path: string): SharedFolder | null {
		// Return the shared folder that contains the file -- agnostic of whether the file actually exists
		const folder = this.find((sharedFolder: SharedFolder) => {
			return sharedFolder.checkPath(path);
		});
		if (!folder) {
			return null;
		}
		return folder;
	}

	destroy() {
		this.items().forEach((folder) => {
			folder.destroy();
		});
		this.clear();
		if (this._offRemoteUpdates) {
			this._offRemoteUpdates();
		}
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.relayManager = null as any;
		this.folderBuilder = null as any;
	}

	load() {
		this._load(this.settings.get());
	}

	private _load(folders: SharedFolderSettings[]) {
		let updated = false;
		folders.forEach((folder: SharedFolderSettings) => {
			const tFolder = this.vault.getFolderByPath(folder.path);
			if (!tFolder) {
				this.warn(`Invalid settings, ${folder.path} does not exist`);
				return;
			}
			this._new(folder.path, folder.guid, folder?.relay);
			updated = true;
		});

		if (updated) {
			this.notifyListeners();
		}
	}

	private _new(
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
	): SharedFolder {
		const existing = this.find(
			(folder) => folder.path == path && folder.guid == guid,
		);
		if (existing) {
			return existing;
		}
		const sameGuid = this.find((folder) => folder.guid == guid);
		if (sameGuid) {
			throw new Error(`This folder is already mounted at ${sameGuid.path}.`);
		}
		const samePath = this.find((folder) => folder.path == path);
		if (samePath) {
			throw new Error("Conflict: Tracked folder exists at this location.");
		}
		const folder = this.folderBuilder(path, guid, relayId, awaitingUpdates);
		this._set.add(folder);
		return folder;
	}

	new(path: string, guid: string, relayId?: string, awaitingUpdates?: boolean) {
		const folder = this._new(path, guid, relayId, awaitingUpdates);
		this.notifyListeners();
		return folder;
	}
}
