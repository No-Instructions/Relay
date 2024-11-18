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
import { IndexeddbPersistence, fetchUpdates } from "y-indexeddb";
import { v4 as uuidv4 } from "uuid";
import { dirname, join, sep } from "path-browserify";
import { Doc } from "yjs";
import { HasProvider, type ConnectionIntent } from "./HasProvider";
import { Document } from "./Document";
import { ObservableSet } from "./observable/ObservableSet";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";
import { moment } from "obsidian";
import { SharedPromise } from "./promiseUtils";
import { S3Folder, S3RemoteFolder } from "./S3RN";
import type { RemoteSharedFolder } from "./Relay";
import { RelayManager } from "./RelayManager";
import type { Unsubscriber } from "svelte/store";
import { curryLog } from "./debug";
import { withFlag } from "./flagManager";
import { flag } from "./flags";
import { DiskBufferStore } from "./DiskBuffer";
import { BackgroundSync } from "./BackgroundSync";

export interface SharedFolderSettings {
	guid: string;
	path: string;
	relay?: string;
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
		this._set.add(item);
		if (update) {
			this.notifyListeners();
		}
		return this;
	}
}

export class SharedFolder extends HasProvider {
	path: string;
	guid: string;
	ids: Y.Map<string>; // Maps document paths to guids
	docs: Map<string, Document>; // Maps guids to SharedDocs
	docset: Documents;
	relayId?: string;
	_remote?: RemoteSharedFolder;
	shouldConnect: boolean;
	public vault: Vault;
	private fileManager: FileManager;
	private relayManager: RelayManager;
	private readyPromise: SharedPromise<SharedFolder> | null = null;
	private _awaitingUpdates: boolean;
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
			if (!this.checkExtension(file.path)) {
				return;
			}
			if (file instanceof TFolder) {
				return;
			}
			const guid = this.ids.get(this.getVirtualPath(file.path));
			const loadFromDisk = (guid && newDocs.contains(guid)) || false;

			const upload = (doc: Document) => {
				withFlag(flag.enableUploadOnShare, () => {
					this.backgroundSync.putDocument(doc);
				});
			};
			const doc = this.createFile(file.path, loadFromDisk, false, upload);
			docs.push(doc);
		});
		if (docs.length > 0) {
			this.docset.update();
		}
	};

	constructor(
		guid: string,
		path: string,
		loginManager: LoginManager,
		vault: Vault,
		fileManager: FileManager,
		tokenStore: LiveTokenStore,
		relayManager: RelayManager,
		private backgroundSync: BackgroundSync,
		relayId?: string,
		awaitingUpdates: boolean = true,
	) {
		const s3rn = relayId
			? new S3RemoteFolder(relayId, guid)
			: new S3Folder(guid);

		super(s3rn, tokenStore, loginManager);
		this.shouldConnect = true;

		this.log = curryLog("[SharedFolder]", "log");
		this.warn = curryLog("[SharedFolder]", "warn");
		this.debug = curryLog("[SharedFolder]", "debug");
		this.error = curryLog("[SharedFolder]", "error");

		this.guid = guid;
		this.fileManager = fileManager;
		this.vault = vault;
		this.path = path;
		this.ids = this.ydoc.getMap("docs");
		this.docs = new Map();
		this.docset = new Documents();
		this.relayManager = relayManager;
		this._awaitingUpdates = awaitingUpdates;
		this.relayId = relayId;
		this.diskBufferStore = new DiskBufferStore();
		this.unsubscribes.push(
			this.relayManager.remoteFolders.subscribe((folders) => {
				this.remote = folders.find((folder) => folder.guid == this.guid);
			}),
		);

		try {
			this._persistence = new IndexeddbPersistence(this.guid, this.ydoc);
			this._persistence.once("synced", () => {
			    this.log("", this.ids);
			});
		} catch (e) {
			console.error(e);
			throw e;
		}

		if (loginManager.loggedIn) {
			this.connect();
		}

		this.whenReady().then(() => {
			this.addLocalDocs();
		});

		this.ydoc.on(
			"update",
			async (update: Uint8Array, origin: unknown, doc: Y.Doc) => {
				if (origin == this) {
					return;
				}
				this.log("file tree", this._debugFileTree());
				await this.syncFileTree(doc);
			},
		);
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

	public get settings(): SharedFolderSettings {
		return {
			guid: this.guid,
			path: this.path,
			relay: this.relayId,
		};
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
		this.notifyListeners();
	}

	public get ready(): boolean {
		const persistenceSynced = this._persistence.synced;
		const serverSynced = this.synced && this.connected;
		return persistenceSynced && (!this._awaitingUpdates || serverSynced);
	}

	async awaitingUpdates(): Promise<boolean> {
		await this.whenSynced();
		if (this._awaitingUpdates) {
			await fetchUpdates(this._persistence);
			this.log("update count", this.path, this._persistence._dbsize);
			this._awaitingUpdates = this._persistence._dbsize < 3;
		}
		return this._awaitingUpdates;
	}

	async whenReady(): Promise<SharedFolder> {
		const promiseFn = async (): Promise<SharedFolder> => {
			const awaitingUpdates = await this.awaitingUpdates();
			if (awaitingUpdates) {
				// If this is a brand new shared folder, we want to wait for a connection before we start reserving new guids for local files.
				await this.onceConnected();
				await this.onceProviderSynced();
				return this;
			}
			// If this is a shared folder with edits, then we can behave as though we're just offline.
			return this;
		};
		this.readyPromise =
			this.readyPromise ||
			new SharedPromise<SharedFolder>(
				promiseFn,
				(): [boolean, SharedFolder] => {
					return [this.ready, this];
				},
			);
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
		if (this._persistence.synced) {
			return new Promise((resolve) => {
				resolve();
			});
		}
		return new Promise((resolve) => {
			this._persistence.once("synced", resolve);
		});
	}

	toggleConnection(): void {
		if (this.shouldConnect) {
			this.shouldConnect = false;
			this.disconnect();
		} else {
			this.shouldConnect = true;
			this.connect();
		}
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
		path: string,
		diffLog?: string[],
	): Promise<Document> {
		const doc = this.createDoc(path, false, false);

		// Create directories as needed
		let folderPromise: Promise<void> = Promise.resolve();
		const dir = dirname(path);
		if (!this.existsSync(dir)) {
			folderPromise = this.mkdir(dir);
			diffLog?.push(`creating directory ${dir}`);
		}

		// Receive content, then flush to disk
		const start = moment.now();
		await doc.whenReady();
		const end = moment.now();
		this.debug(
			`receive delay: received content for ${doc.path} after ${end - start}ms`,
			doc.text.toString(),
		);
		await folderPromise;
		this.flush(doc, doc.text.toString());
		diffLog?.push(`created local file for remotely added doc ${path}`);
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
		if (this.existsSync(path)) {
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
			const fileInFolder = this.checkPath(file.path);
			const fileInMap = remotePaths.contains(file.path.slice(this.path.length));
			const synced = this._provider?.synced && this._persistence?.synced;
			if (fileInFolder && !fileInMap) {
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

	async syncFileTree(doc: Doc) {
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
		await Promise.all([...creates, ...renames].map((op) => op.promise));

		const deletes = this.cleanupExtraLocalFiles(remotePaths, diffLog);

		if (renames.length > 0 || creates.length > 0 || deletes.length > 0) {
			this.docset.update();
		}
		this.log("syncFileTree diff:\n" + diffLog.join("\n"));
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

	checkExtension(path: string, extension = ".md"): boolean {
		return path.endsWith(extension);
	}

	getVirtualPath(path: string): string {
		this.assertPath(path);

		const vPath = path.slice(this.path.length);
		return vPath;
	}

	getFile(
		path: string,
		create = true,
		loadFromDisk = false,
		update = true,
	): Document {
		const vPath = this.getVirtualPath(path);
		return this.getDoc(vPath, create, loadFromDisk, update);
	}

	getTFile(doc: Document): TFile | null {
		const maybeTFile = this.vault.getAbstractFileByPath(this.getPath(doc.path));
		if (maybeTFile instanceof TFile) {
			return maybeTFile;
		}
		return null;
	}

	getDoc(
		vPath: string,
		create = true,
		loadFromDisk = false,
		update = true,
	): Document {
		const id = this.ids.get(vPath);
		if (id !== undefined) {
			const doc = this.docs.get(id);
			if (doc !== undefined) {
				doc.move(vPath);
				return doc;
			} else {
				// the ID exists, but the file doesn't
				this.log("[getDoc]: creating doc for shared ID");
				return this.createDoc(vPath, false, update);
			}
		} else if (create) {
			// the File exists, but the ID doesn't
			this.log("[getDoc]: creating new shared ID for existing file");
			return this.createDoc(vPath, loadFromDisk, update);
		} else {
			throw new Error("No shared doc for vpath: " + vPath);
		}
	}

	createFile(
		path: string,
		loadFromDisk = false,
		update = true,
		onSync = (doc: Document) => {},
	): Document {
		const vPath = this.getVirtualPath(path);
		return this.createDoc(vPath, loadFromDisk, update, onSync);
	}

	placeHold(vpaths: string[]): string[] {
		const newDocs: string[] = [];
		this.ydoc.transact(() => {
			vpaths.forEach((vpath) => {
				if (!this.ids.has(vpath)) {
					this.debug("creating entirely new doc for", vpath);
					const guid = uuidv4();
					newDocs.push(guid);
					this.ids.set(vpath, guid);
				}
			});
		}, this);
		return newDocs;
	}

	createDoc(
		vpath: string,
		loadFromDisk = false,
		update = true,
		onSync = (doc: Document) => {},
	): Document {
		if (!this.synced && !this.ids.get(vpath)) {
			this.warn(`potential for document split at ${vpath}`);
		}
		const maybeGuid: string | undefined = this.ids.get(vpath);
		let guid: string;
		if (maybeGuid === undefined) {
			if (!loadFromDisk) {
				throw new Error("attempting to create a new doc without a local file");
			}
			guid = uuidv4();
			this.ydoc.transact(() => {
				this.ids.set(vpath, guid); // Register the doc as soon as possible to avoid a race condition
			}, this);
		} else {
			guid = maybeGuid;
		}
		const doc =
			this.docs.get(guid) || new Document(vpath, guid, this.loginManager, this);
		const knownPeersPromise = doc.hasKnownPeers();
		const awaitingUpdatesPromise = this.awaitingUpdates();
		if (loadFromDisk) {
			(async () => {
				const exists = await this.exists(doc);
				if (!exists) {
					return;
				}
				const [contents, hasKnownPeers, awaitingUpdates] = await Promise.all([
					this.read(doc),
					knownPeersPromise,
					awaitingUpdatesPromise,
				]);
				const text = doc.ydoc.getText("contents");
				if (
					!awaitingUpdates &&
					!hasKnownPeers &&
					contents &&
					text.toString() != contents
				) {
					this.log(`[${doc.path}] No Known Peers: Syncing file into ytext.`);
					text.insert(0, contents);
					onSync(doc);
				}
			})();
		}

		this.docs.set(guid, doc);
		this.docset.add(doc, update);

		return doc;
	}

	deleteFile(path: string) {
		const vPath = this.getVirtualPath(path);
		return this.deleteDoc(vPath);
	}

	deleteDoc(vPath: string) {
		const guid = this.ids.get(vPath);
		if (guid) {
			this.ydoc.transact(() => {
				this.ids.delete(vPath);
				const doc = this.docs.get(guid)?.destroy();
				if (doc) {
					this.docset.delete(doc);
				}
				this.docs.delete(guid);
			}, this);
			this.diskBufferStore.removeDiskBuffer(guid);
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
			this.createDoc(newVPath, true, true);
		} else {
			// live doc exists
			const guid = this.ids.get(oldVPath);
			if (!guid) return;
			const doc = this.docs.get(guid);
			if (!newVPath) {
				// moving out of shared folder.. destroy the live doc.
				this.ydoc.transact(() => {
					this.ids.delete(oldVPath);
				}, this);
				if (doc) {
					doc.destroy();
					this.docset.delete(doc);
				}
				this.docs.delete(guid);
			} else {
				// moving within shared folder.. move the live doc.
				const guid = this.ids.get(oldVPath);
				if (!guid) {
					return;
				}
				this.ydoc.transact(() => {
					this.ids.set(newVPath, guid);
					this.ids.delete(oldVPath);
					if (doc) {
						doc.move(newVPath);
					}
				}, this);
			}
		}
	}

	destroy() {
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
		this.diskBufferStore = null as any;
		this.relayManager = null as any;
		this.backgroundSync = null as any;
		this.loginManager = null as any;
		this.tokenStore = null as any;
		this.fileManager = null as any;
		this.vault = null as any;
	}
}
export class SharedFolders extends ObservableSet<SharedFolder> {
	private folderBuilder: (
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
	) => Promise<SharedFolder>;
	private _offRemoteUpdates?: () => void;

	public toSettings(): SharedFolderSettings[] {
		return this.items().map((folder) => folder.settings);
	}

	public delete(item: SharedFolder): boolean {
		item?.destroy();
		return super.delete(item);
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
		this.relayManager = null as any;
		this.folderBuilder = null as any;
	}

	constructor(
		private relayManager: RelayManager,
		folderBuilder: (
			guid: string,
			path: string,
			relayId?: string,
			awaitingUpdates?: boolean,
		) => Promise<SharedFolder>,
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

	async _new(
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
	): Promise<SharedFolder> {
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
		const folder = await this.folderBuilder(
			path,
			guid,
			relayId,
			awaitingUpdates,
		);
		this._set.add(folder);
		return folder;
	}

	async new(
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
	) {
		const folder = await this._new(path, guid, relayId, awaitingUpdates);
		this.notifyListeners();
		return folder;
	}
}
