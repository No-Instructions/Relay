"use strict";
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
import { dirname, join, sep } from "path-browserify";
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
import { DiskBufferStore } from "./DiskBuffer";
import { BackgroundSync } from "./BackgroundSync";
import type { NamespacedSettings } from "./SettingsStorage";
import { RelayInstances } from "./debug";
import { LocalStorage } from "./LocalStorage";
import { SyncFolder, isSyncFolder } from "./SyncFolder";
import { isDocument } from "./Document";
import { SyncStore } from "./SyncStore";
import {
	SyncType,
	isSyncFileMeta,
	makeDocumentMeta,
	makeFileMeta,
	makeFolderMeta,
	type FileMeta,
	type SyncFileType,
} from "./SyncTypes";
import type { IFile } from "./IFile";
import { createPathProxy } from "./pathProxy";
import { ContentAddressedStore } from "./CAS";
import { SyncSettingsManager, type SyncFlags } from "./SyncSettings";
import { SyncFile, isSyncFile } from "./SyncFile";

export interface SharedFolderSettings {
	guid: string;
	path: string;
	relay?: string;
	connect?: boolean;
	sync?: SyncFlags;
}

interface Operation {
	op: "create" | "rename" | "delete" | "update" | "noop";
	path: string;
	promise: Promise<void> | Promise<IFile>;
}

interface Create extends Operation {
	op: "create";
	path: string;
	promise: Promise<IFile>;
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

interface Update extends Operation {
	op: "update";
	path: string;
	promise: Promise<void>;
}

interface Noop extends Operation {
	op: "noop";
	path: string;
	promise: Promise<void>;
}

type OperationType = Create | Rename | Delete | Update | Noop;

class Files extends ObservableSet<IFile> {
	// Startup performance optimization
	notifyListeners = debounce(super.notifyListeners, 100);

	update() {
		this.notifyListeners();
		return;
	}

	add(item: IFile, update = true): ObservableSet<IFile> {
		const existing = this.find((file) => file.guid === item.guid);
		if (existing && existing !== item) {
			this.error("duplicate guid", existing, item);
			this._set.delete(existing);
		}
		this._set.add(item);
		if (update) {
			this.notifyListeners();
		}
		return this;
	}
}

export class SharedFolder extends HasProvider {
	path: string;
	files: Map<string, IFile>; // Maps guids to SharedDocs
	fset: Files;
	relayId?: string;
	_dbsize?: number;
	_remote?: RemoteSharedFolder;
	_shouldConnect: boolean;
	destroyed: boolean = false;
	public vault: Vault;
	syncStore: SyncStore;
	private _server?: string;
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
	proxy: SharedFolder;
	cas: ContentAddressedStore;
	syncSettingsManager: SyncSettingsManager;

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
		this.files = new Map();
		this.fset = new Files();
		this.pendingUpload = new LocalStorage<string>(
			`${appId}-system3-relay/folders/${this.guid}/pendingUploads`,
		);
		this.relayManager = relayManager;
		this.relayId = relayId;
		this.diskBufferStore = new DiskBufferStore();
		this._shouldConnect = this.settings.connect ?? true;

		this.authoritative = !awaitingUpdates;

		this.syncSettingsManager = this._settings.getChild<
			Record<keyof SyncFlags, boolean>,
			SyncSettingsManager
		>(
			"sync",
			(settings, path) => new SyncSettingsManager(settings, path, false),
		);

		this.syncStore = new SyncStore(
			this.ydoc,
			this.path,
			this.pendingUpload,
			this.syncSettingsManager,
		);
		this.syncStore.on(async () => {
			await this.syncFileTree(this.syncStore);
		});

		this.unsubscribes.push(
			this.relayManager.remoteFolders.subscribe((folders) => {
				this.remote = folders.find((folder) => folder.guid == this.guid);
			}),
		);

		this.proxy = createPathProxy(this, this.path, (globalPath: string) => {
			return this.getVirtualPath(globalPath);
		});

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

		this.cas = new ContentAddressedStore(this);

		this.whenReady().then(() => {
			if (!this.destroyed) {
				this.addLocalDocs();
				this.syncFileTree(this.syncStore);
			}
		});

		this.whenSynced().then(async () => {
			this.syncStore.start();
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

	private addLocalDocs = () => {
		const syncTFiles = this.getSyncFiles();
		const files: IFile[] = [];
		const newPaths = this.placeHold(syncTFiles);
		syncTFiles.forEach((tfile) => {
			const vpath = this.getVirtualPath(tfile.path);
			const upload = newPaths.contains(vpath);

			if (SyncFolder.checkPath(vpath)) {
				const doc = this.getSyncFolder(vpath, false);
				files.push(doc);
			} else if (Document.checkExtension(vpath)) {
				if (upload) {
					const doc = this.uploadDoc(vpath, false);
					files.push(doc);
				} else {
					const doc = this.getDoc(vpath, false);
					files.push(doc);
				}
			} else if (this.syncStore.canSync(vpath)) {
				if (upload) {
					const file = this.uploadSyncFile(vpath, false);
					files.push(file);
				} else {
					const file = this.downloadSyncFile(vpath, false);
					files.push(file);
				}
			}
		});
		if (files.length > 0) {
			this.fset.update();
		}
	};

	public get server(): string | undefined {
		return this._server;
	}

	public set server(value: string | undefined) {
		if (value) {
			this.syncSettingsManager.enable();
		} else {
			this.syncSettingsManager.disable();
		}

		if (value === this._server) {
			return;
		}
		this.warn("server changed -- reinitializing all connections");
		const shouldConnect = this.shouldConnect;
		this.reset();
		const reconnect: HasProvider[] = [];
		this.fset.forEach((file) => {
			if (file instanceof HasProvider) {
				if (file.connected) {
					reconnect.push(file);
				}
				file.reset();
			}
		});
		// XXX filter to relay
		this.tokenStore.clear();
		if (shouldConnect) {
			this.connect();
			reconnect.forEach((file) => {
				file.connect();
			});
		}
		this._server = value;
	}

	public get tfolder(): TFolder {
		const folder = this.vault.getAbstractFileByPath(this.path);
		if (!(folder instanceof TFolder)) {
			throw new Error("tfolder is not a folder");
		}
		return folder;
	}

	public isSyncableTFile(tfile: TAbstractFile): boolean {
		const inFolder = this.checkPath(tfile.path);
		if (tfile instanceof TFolder && !SyncFolder.checkPath) {
			throw new Error("logical error");
		}
		const vpath = this.getVirtualPath(tfile.path);
		const isSupportedFileType = this.syncStore.canSync(vpath);
		const isExtensionEnabled =
			this.syncSettingsManager.isExtensionEnabled(vpath);
		return inFolder && isSupportedFileType && isExtensionEnabled;
	}

	private getSyncFiles(): TAbstractFile[] {
		const folder = this.vault.getAbstractFileByPath(this.path);
		if (!(folder instanceof TFolder)) {
			throw new Error(
				`Could not find shared folders on file system at ${this.path}`,
			);
		}
		const files: TAbstractFile[] = [];
		Vault.recurseChildren(folder, (file: TAbstractFile) => {
			if (file !== folder) {
				files.push(file);
			}
		});
		return files.filter((tfile) => {
			return this.isSyncableTFile(tfile);
		});
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
		await this.syncFileTree(this.syncStore);
		this.backgroundSync.enqueueSharedFolderSync(this);
	}

	public get settings(): SharedFolderSettings {
		return this._settings.get();
	}

	async sync() {
		await this.syncFileTree(this.syncStore);
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
		this._settings.update((current) => ({
			...current,
			...{ relay: this.relayId },
		}));

		if (value) {
			this.unsubscribes.push(
				value.relay.subscribe((relay) => {
					if (relay.guid === this.relayId) {
						this.server = relay.provider;
					}
				}),
			);
		}

		this.server = value?.relay.provider;
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
		doc: IFile,
		path: string,
		file: TAbstractFile,
		diffLog?: string[],
	): Promise<void> {
		// take a doc and it's new path.
		diffLog?.push(`${file.path} was renamed to ${this.getPath(path)}`);
		if (file instanceof TFile) {
			const dir = dirname(path);
			if (!this.existsSync(dir)) {
				await this.mkdir(dir);
				diffLog?.push(`creating directory ${dir}`);
			}
		}
		await this.fileManager
			.renameFile(file, normalizePath(this.getPath(path)))
			.then(() => {
				doc.move(path);
			});
	}

	async _handleServerCreate(vpath: string, diffLog?: string[]): Promise<IFile> {
		// Create directories as needed
		const dir = dirname(vpath);
		if (!this.existsSync(dir)) {
			await this.mkdir(dir);
			diffLog?.push(`creating directory ${dir}`);
		}
		if (Document.checkExtension(vpath)) {
			diffLog?.push(`created local file for remotely added doc ${vpath}`);
			const doc = await this.downloadDoc(vpath, false);
			return doc;
		}
		if (SyncFolder.checkPath(vpath)) {
			return this.getSyncFolder(vpath, false);
		}
		if (this.syncStore.canSync(vpath)) {
			return this.downloadSyncFile(vpath, false);
		}
		throw new Error("unexpected file");
	}

	private _assertNamespacing(path: string) {
		// Check if the path is valid (inside of shared folder), otherwise delete
		try {
			this.assertPath(this.path + path);
		} catch {
			this.error("Deleting doc (somehow moved outside of shared folder)", path);
			this.syncStore.delete(path);
			return;
		}
	}

	private applyRemoteState(
		guid: string,
		path: string,
		remoteIds: Set<string>,
		diffLog: string[],
	): OperationType {
		const file = this.files.get(guid);
		const meta = this.syncStore.getMeta(path);
		if (!meta) {
			this.warn("unknown sync type", path);
			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (this.existsSync(path)) {
			// XXX file meta typing
			if (file && isSyncFile(file) && file.shouldPull(meta as FileMeta)) {
				return { op: "update", path, promise: file.pull() };
			}
			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (remoteIds.has(guid) && file) {
			const oldPath = this.getPath(file.path);
			const tfile = this.vault.getAbstractFileByPath(oldPath);
			if (tfile) {
				const promise = this._handleServerRename(file, path, tfile, diffLog);
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
		const ffiles = this.getSyncFiles();
		const deletes: Delete[] = [];
		const folders = ffiles.filter((file) => file instanceof TFolder);
		const files = ffiles.filter((file) => file instanceof TFile);
		const sync = (file: TAbstractFile) => {
			// If the file is in the shared folder and not in the map, move it to the Trash
			const isSyncableFile = this.isSyncableTFile(file);
			const fileInFolder = this.checkPath(file.path);
			const fileInMap = remotePaths.contains(file.path.slice(this.path.length));
			const filePending = this.pendingUpload.has(
				this.getVirtualPath(file.path),
			);
			const vpath = this.getVirtualPath(file.path);
			const synced = this._provider?.synced && this._persistence?.synced;
			if (fileInFolder && isSyncableFile && !fileInMap && !filePending) {
				if (synced) {
					diffLog.push(`deleted local file ${vpath} for remotely deleted doc`);
					const promise = this.vault.adapter.trashLocal(file.path);
					deletes.push({
						op: "delete",
						path: vpath,
						promise,
					});
				}
			}
		};
		files.forEach(sync);
		folders.forEach(sync);
		return deletes;
	}

	syncByType(
		syncStore: SyncStore,
		diffLog: string[],
		ops: Operation[],
		types: SyncType[],
	) {
		syncStore.forEach((meta, path) => {
			this._assertNamespacing(path);
			if (types.contains(meta.type)) {
				this._assertNamespacing(path);
				ops.push(
					this.applyRemoteState(meta.id, path, syncStore.remoteIds, diffLog),
				);
			}
		});
	}

	syncFileTree(syncStore: SyncStore): Promise<void> {
		// If a sync is already running, mark that we want another sync after
		if (this.syncFileTreePromise) {
			this.syncRequestedDuringSync = true;
			const promise = this.syncFileTreePromise.getPromise();
			promise.then(() => {
				if (this.syncRequestedDuringSync) {
					this.syncRequestedDuringSync = false;
					return this.syncFileTree(syncStore);
				}
			});
			return promise;
		}

		const promiseFn = async (): Promise<void> => {
			try {
				const ops: Operation[] = [];
				const diffLog: string[] = [];

				this.ydoc.transact(async () => {
					// Sync folder operations first because renames/moves also affect files
					this.syncStore.migrateUp();
					this.syncByType(syncStore, diffLog, ops, [SyncType.Folder]);
				}, this);
				await Promise.all(ops.map((op) => op.promise));
				this.ydoc.transact(async () => {
					this.syncByType(
						syncStore,
						diffLog,
						ops,
						this.syncStore.typeRegistry.getEnabledFileSyncTypes(),
					);
					this.syncStore.commit();
				}, this);

				const creates = ops.filter((op) => op.op === "create");
				const renames = ops.filter((op) => op.op === "rename");
				const remotePaths = ops.map((op) => op.path);

				// Ensure these complete before checking for deletions
				await Promise.all(
					[...creates, ...renames].map((op) =>
						withTimeoutWarning<IFile | void>(op.promise, op),
					),
				);

				const deletes = this.cleanupExtraLocalFiles(remotePaths, diffLog);
				if ([...ops, ...deletes].every((op) => op.op === "noop")) {
					this.debug("sync: noop");
				} else {
					this.log("remote paths", remotePaths);
					this.log("operations", [...ops, ...deletes]);
				}
				if (renames.length > 0 || creates.length > 0 || deletes.length > 0) {
					this.fset.update();
				}
				if (diffLog.length > 0) {
					this.log("syncFileTree diff:\n" + diffLog.join("\n"));
				}
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

	getTFile(doc: Document): TFile | null {
		const maybeTFile = this.vault.getAbstractFileByPath(this.getPath(doc.path));
		if (maybeTFile instanceof TFile) {
			return maybeTFile;
		}
		return null;
	}

	public getDoc(vpath: string, update = true): Document {
		const id = this.syncStore.get(vpath);
		if (id !== undefined) {
			const doc = this.files.get(id);
			if (doc !== undefined) {
				doc.move(vpath);
				if (!isDocument(doc)) {
					throw new Error("unexpected ifile type");
				}
				return doc;
			} else {
				// the ID exists, but the file doesn't
				this.log("[getDoc]: creating doc for shared ID");
				return this.createDoc(vpath, update);
			}
		} else {
			// the File exists, but the ID doesn't
			this.warn("[getDoc]: creating new shared ID for existing tfile");
			const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
			if (!(tfile instanceof TFile)) {
				throw new Error("unexpectedly missing tfile or got tfolder");
			}
			const newDocs = this.placeHold([tfile]);
			if (newDocs.length > 0) {
				return this.uploadDoc(vpath);
			} else {
				return this.createDoc(vpath, update);
			}
		}
	}

	markUploaded(file: IFile) {
		if (isDocument(file)) {
			const meta = makeDocumentMeta(file.guid);
			this.ydoc.transact(() => {
				this.syncStore.markUploaded(file.path, meta);
			}, this);
			return;
		}
		if (isSyncFolder(file)) {
			const meta = makeFolderMeta(file.guid);
			this.ydoc.transact(() => {
				this.syncStore.markUploaded(file.path, meta);
			}, this);
			return;
		}
		if (isSyncFile(file)) {
			const type = this.syncStore.typeRegistry.getTypeForPath(file.path);
			if (!type) {
				throw new Error("unexpected sync type");
			}
			// XXX typecast
			if (!file.caf.value) {
				throw new Error("file hash not yet computed");
			}
			const existingMeta = this.syncStore.getMeta(this.path);
			if (existingMeta && file.caf.value === existingMeta.hash) return;
			const meta = makeFileMeta(
				type as SyncFileType,
				file.guid,
				file.mimetype,
				file.caf.value,
				file.stat.mtime,
			);
			this.log("new meta", meta);
			this.ydoc.transact(() => {
				this.syncStore.markUploaded(file.path, meta);
			}, this);
			return;
		}
	}

	getFile(vpath: string, update = true): IFile | null {
		const guid = this.syncStore.get(vpath);
		if (guid) {
			const file = this.files.get(guid);
			if (file) {
				return file;
			}
		}
		if (Document.checkExtension(vpath)) {
			return this.getDoc(vpath);
		}
		if (SyncFolder.checkPath(vpath)) {
			return this.getSyncFolder(vpath, update);
		}
		if (this.syncStore.canSync(vpath)) {
			return this.getSyncFile(vpath, update);
		}
		return null;
	}

	placeHold(newFiles: TAbstractFile[]): string[] {
		const newDocs: string[] = [];
		this.ydoc.transact(() => {
			newFiles.forEach((file) => {
				const vpath = this.getVirtualPath(file.path);
				this.log("place hold", vpath);
				if (!this.syncStore.has(vpath)) {
					this.log("place hold new", vpath);
					this.syncStore.new(vpath);
					newDocs.push(vpath);
				}
			});
		}, this);
		return newDocs;
	}

	public viewDoc(vpath: string): Document | undefined {
		const guid = this.syncStore.get(vpath);
		if (!guid) return;
		const doc = this.files.get(guid);
		if (!isDocument(doc)) {
			throw new Error("unexpected ifile type");
		}
		return doc;
	}

	getOrCreateDoc(guid: string, vpath: string): Document {
		const doc =
			this.files.get(guid) ||
			new Document(vpath, guid, this.loginManager, this);
		if (!isDocument(doc)) {
			throw new Error("unexpected ifile type");
		}
		doc.move(vpath);
		return doc;
	}

	async downloadDoc(vpath: string, update = true): Promise<Document> {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error(`called download on item that is not in ids ${vpath}`);
		}
		const doc = this.getOrCreateDoc(guid, vpath);
		doc.markOrigin("remote");

		withTimeoutWarning(this.backgroundSync.enqueueDownload(doc), doc.path);

		this.files.set(guid, doc);
		this.fset.add(doc, update);

		return doc;
	}

	uploadDoc(vpath: string, update = true): Document {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid: string | undefined = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("missing guid");
		}
		const doc = this.getOrCreateDoc(guid, vpath);

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

		this.files.set(guid, doc);
		this.fset.add(doc, update);
		return doc;
	}

	createDoc(vpath: string, update = true): Document {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const doc = this.getOrCreateDoc(guid, vpath);

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

		this.files.set(guid, doc);
		this.fset.add(doc, update);

		return doc;
	}

	private getOrCreateSyncFolder(guid: string, vpath: string) {
		const file =
			this.files.get(guid) ||
			new SyncFolder(vpath, guid, this.relayManager, this);
		if (!isSyncFolder(file)) {
			throw new Error("unexpected ifile type");
		}
		file.move(vpath);
		return file;
	}

	getSyncFolder(vpath: string, update: boolean) {
		this.log("[getSyncFolder]", `getting syncfolder`);
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const file = this.getOrCreateSyncFolder(guid, vpath);

		this.files.set(guid, file);
		this.fset.add(file, update);
		return file;
	}

	getOrCreateSyncFile(
		guid: string,
		vpath: string,
		hashOrTFile: TFile | string,
	): SyncFile {
		const file =
			this.files.get(guid) ||
			new SyncFile(vpath, guid, this.relayManager, this);
		if (!isSyncFile(file)) {
			throw new Error("unexpected ifile type");
		}
		file.move(vpath);
		return file;
	}

	downloadSyncFile(vpath: string, update: boolean) {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error(`called download on item that is not in ids ${vpath}`);
		}
		const meta = this.syncStore.getMeta(vpath);
		if (!meta || !meta.hash) {
			return this.uploadSyncFile(vpath, update);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, meta.hash);

		withTimeoutWarning(file.pull());

		this.files.set(guid, file);
		this.fset.add(file, update);

		return file;
	}

	uploadSyncFile(vpath: string, update = true): SyncFile {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid: string | undefined = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("missing guid");
		}
		const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
		if (!tfile) {
			throw new Error(`Upload failed, file does not exist at ${vpath}`);
		}
		if (!(tfile instanceof TFile)) {
			throw new Error(`Upload failed, expected file at ${vpath}`);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, tfile);

		const run = async () => {
			if (!this.existsSync(vpath)) {
				throw new Error(`Upload failed, file does not exist at ${vpath}`);
			}
			await file.push();
		};
		run();

		this.files.set(guid, file);
		this.fset.add(file, update);
		return file;
	}

	getSyncFile(vpath: string, update = true): SyncFile {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid: string | undefined = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("missing guid");
		}
		const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
		if (!tfile) {
			throw new Error(`Upload failed, file does not exist at ${vpath}`);
		}
		if (!(tfile instanceof TFile)) {
			throw new Error(`Upload failed, expected file at ${vpath}`);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, tfile);

		const meta = this.syncStore.getMeta(vpath);
		if (!meta) {
			this.log("get syncfile missing meta");
			file.push();
		} else {
			file.pull();
		}

		this.files.set(guid, file);
		this.fset.add(file, update);
		return file;
	}

	uploadFile(vpath: string, update = true): IFile {
		if (Document.checkExtension(vpath)) {
			return this.uploadDoc(vpath, update);
		}
		if (SyncFolder.checkPath(vpath)) {
			return this.getSyncFolder(vpath, update);
		}
		if (this.syncStore.canSync(vpath)) {
			return this.uploadSyncFile(vpath, update);
		}
		throw new Error("unexpectedly unable to upload");
	}

	deleteFile(vpath: string) {
		const guid = this.syncStore.get(vpath);
		if (guid) {
			this.ydoc.transact(() => {
				this.syncStore.delete(vpath);
				const doc = this.files.get(guid);
				if (doc) {
					doc.cleanup();
					this.fset.delete(doc);
				}
				this.files.delete(guid);
			}, this);
		}
	}

	renameFile(tfile: TAbstractFile, oldPath: string) {
		const newPath = tfile.path;
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
			if (!this.syncStore.canSync(newVPath)) return;
			this.placeHold([tfile]);
			this.log("can I has vpath", newVPath, this.syncStore.has(newVPath));
			this.uploadFile(newVPath);
		} else {
			// live doc exists
			const guid = this.syncStore.get(oldVPath);
			if (!guid) return;
			const file = this.files.get(guid);
			if (!newVPath) {
				// moving out of shared folder.. destroy the live doc.
				this.ydoc.transact(() => {
					this.syncStore.delete(oldVPath);
				}, this);
				if (file) {
					file.cleanup();
					file.destroy();
					this.fset.delete(file);
				}
				this.files.delete(guid);
			} else {
				// moving within shared folder.. move the live doc.
				const guid = this.syncStore.get(oldVPath);
				if (!guid) {
					return;
				}
				const toMove: [string, string, string][] = [];
				if (file instanceof SyncFolder) {
					this.syncStore.forEach((meta, path) => {
						if (path.startsWith(oldVPath + sep)) {
							const destination = path.replace(oldVPath, newVPath);
							toMove.push([meta.id, path, destination]);
						}
					});
				}
				this.ydoc.transact(() => {
					this.syncStore.move(oldVPath, newVPath);
					if (file) {
						file.move(newVPath);
					}
					toMove.forEach((move) => {
						const [guid, oldVPath, newVPath] = move;
						this.syncStore.move(oldVPath, newVPath);
						const subdoc = this.files.get(guid);
						if (subdoc) {
							// it is critical that this happens within the transaction
							subdoc.move(newVPath);
						}
					});
				}, this);

				// Due to nested folder moves the tfiles and syncStore can diverge.
				// The nested folder moves are done in bulk in the sync store, but the tfile
				// events come in individually.
				this.syncStore.resolveMove(oldVPath);
			}
		}
	}

	destroy() {
		this.destroyed = true;
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.files.forEach((doc: IFile) => {
			doc.destroy();
			this.files.delete(doc.guid);
		});
		this.syncStore.destroy();
		this.syncSettingsManager.destroy();
		super.destroy();
		this.ydoc.destroy();
		this.fset.clear();
		this._settings.destroy();
		this._settings = null as any;
		this.diskBufferStore = null as any;
		this.relayManager = null as any;
		this.backgroundSync = null as any;
		this.loginManager = null as any;
		this.tokenStore = null as any;
		this.fileManager = null as any;
		this.syncStore = null as any;
		this.syncSettingsManager = null as any;
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
