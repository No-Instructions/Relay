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
import { HasProvider, type ConnectionIntent } from "./HasProvider";
import { Document } from "./Document";
import { ObservableSet } from "./observable/ObservableSet";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";
import { SharedPromise } from "./promiseUtils";
import { S3Folder, S3RemoteFolder } from "./S3RN";
import type { RemoteSharedFolder } from "./Relay";
import { RelayManager } from "./RelayManager";
import type { Unsubscriber } from "svelte/store";
import { RelayInstances } from "./debug";
import { flags, withFlag } from "./flagManager";
import { flag } from "./flags";
import { DiskBufferStore } from "./DiskBuffer";
import { BackgroundSync } from "./BackgroundSync";
import type { NamespacedSettings } from "./SettingsStorage";
import { SyncFile } from "./SyncFile";
import { ContentAddressedStore } from "./CAS";
import { getMimeType } from "./mimetypes";
import { SyncFolder } from "./SyncFolder";
import {
	SyncStore,
	SyncType,
	isDocument,
	isSyncFile,
	isSyncFolder,
	makeFileMeta,
	type Meta,
} from "./SyncStore";
import { SyncSettingsManager, type SyncFlags } from "./SyncSettings";
import { SyncNothing } from "./SyncNothing";
import type { IFile } from "./IFile";
import type { TimeProvider } from "./TimeProvider";

export interface SharedFolderSettings {
	guid: string;
	path: string;
	relay?: string;
	sync: SyncFlags;
}

interface FileSyncOperation {
	op: "create" | "rename" | "delete" | "noop" | "pull" | "push";
	path: string;
	promise: Promise<void> | Promise<IFile>;
}

interface Create extends FileSyncOperation {
	op: "create";
	path: string;
	promise: Promise<IFile>;
}

interface Pull extends FileSyncOperation {
	op: "pull";
	path: string;
	promise: Promise<IFile>;
}

interface Push extends FileSyncOperation {
	op: "push";
	path: string;
	promise: Promise<IFile>;
}

interface Rename extends FileSyncOperation {
	op: "rename";
	path: string;
	from: string;
	to: string;
	promise: Promise<void>;
}

interface Delete extends FileSyncOperation {
	op: "delete";
	path: string;
	promise: Promise<void>;
}

interface Noop extends FileSyncOperation {
	op: "noop";
	path: string;
	promise: Promise<void>;
}

type OperationType = Create | Rename | Delete | Noop | Push | Pull;

class Files extends ObservableSet<IFile> {
	// Startup performance optimization
	notifyListeners = debounce(super.notifyListeners, 100);

	update() {
		this.notifyListeners();
		return;
	}

	add(item: IFile, update = true): ObservableSet<IFile> {
		this._set.add(item);
		if (update) {
			this.notifyListeners();
		}
		return this;
	}
}

export class SharedFolder extends HasProvider {
	path: string;
	docs: Map<string, IFile>; // Maps guids to SharedDocs
	docset: Files;
	cas: ContentAddressedStore;
	relayId?: string;
	_remote?: RemoteSharedFolder;
	shouldConnect: boolean;
	public vault: Vault;
	syncStore: SyncStore;
	private fileManager: FileManager;
	private relayManager: RelayManager;
	syncSettingsManager: SyncSettingsManager;
	private readyPromise: SharedPromise<SharedFolder> | null = null;
	private _awaitingUpdates: boolean;
	private unsubscribes: Unsubscriber[] = [];

	private _persistence: IndexeddbPersistence;
	diskBufferStore: DiskBufferStore;

	private addLocalDocs = () => {
		const files = this.getFiles();
		const docs: IFile[] = [];
		const newFiles: TAbstractFile[] = [];
		files.forEach((file) => {
			// if the file is in the shared folder and not in the map, move it to the Trash
			if (!this.checkPath(file.path)) {
				return;
			}
			if (!this.syncSettingsManager.isExtensionEnabled(file.path)) {
				return;
			}
			if (!this.syncStore.has(this.getVirtualPath(file.path))) {
				newFiles.push(file);
			}
		});
		const newDocs = this.placeHold(newFiles);
		files.forEach((file) => {
			if (!this.checkPath(file.path)) {
				return;
			}
			const meta = this.syncStore.get(this.getVirtualPath(file.path));
			const loadFromDisk = (meta && newDocs.contains(meta.id)) || false;

			const upload = (file: IFile) => {
				withFlag(flag.enableUploadOnShare, () => {
					if (file instanceof Document) {
						file.getProviderToken().then(() => {
							this.backgroundSync.putDocument(file);
						});
					}
				});
				if (file instanceof SyncFile) {
					if (!file.getRemote()) {
						file.push();
					}
				}
			};
			const doc = this.createFile(file.path, loadFromDisk, false, upload);
			docs.push(doc);
		});
		if (docs.length > 0) {
			this.docset.update();
		}
	};

	public get tfolder(): TFolder {
		const folder = this.vault.getAbstractFileByPath(this.path);
		if (!(folder instanceof TFolder)) {
			throw new Error("tfolder is not a folder");
		}
		return folder;
	}

	constructor(
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
		this.setLoggers(`[SharedFolder][${path}]`);
		this.shouldConnect = true;
		this.fileManager = fileManager;
		this.vault = vault;
		this.path = path;
		this.docs = new Map();
		this.docset = new Files();
		this.relayManager = relayManager;
		this._awaitingUpdates = awaitingUpdates;
		this.relayId = relayId;
		this.diskBufferStore = new DiskBufferStore();

		this.unsubscribes.push(
			this.relayManager.remoteFolders.subscribe((folders) => {
				this.remote = folders.find((folder) => folder.guid == this.guid);
			}),
		);

		this.syncSettingsManager = this._settings.getChild<
			SyncFlags,
			SyncSettingsManager
		>(
			"sync",
			(settings, path, defaults) =>
				new SyncSettingsManager(settings, path, flags().enableAttachmentSync),
		);

		this._settings.set({
			guid,
			path,
			relay: relayId,
			sync: this.syncSettingsManager.get(),
		});

		try {
			this._persistence = new IndexeddbPersistence(this.guid, this.ydoc);
			this._persistence.once("synced", () => {
				this.syncStore.print();
			});
		} catch (e) {
			this.warn("Unable to open persistence.", this.guid);
			console.error(e);
			throw e;
		}

		if (loginManager.loggedIn) {
			this.connect();
		}

		this.syncStore = new SyncStore(
			this.ydoc,
			this.path,
			this.syncSettingsManager,
		);

		this.cas = new ContentAddressedStore(
			this,
			this.relayManager,
			this.loginManager,
		);

		this.whenReady().then(() => {
			this.ydoc.transact(() => {
				this.syncStore.migrateUp();
				this.syncStore.commit();
			}, this);
			this.addLocalDocs();
			this.syncFileTree(this.syncStore);
			this.ydoc.on(
				"update",
				async (update: Uint8Array, origin: unknown, doc: Y.Doc) => {
					if (origin == this) {
						return;
					}
					await this.syncFileTree(this.syncStore);
				},
			);
			RelayInstances.set(this, `[Shared Folder](${this.path})`);
		});
	}

	public get settings(): SharedFolderSettings {
		return this._settings.get();
	}

	sync() {
		this.syncFileTree(this.syncStore);
	}

	getFiles(): TAbstractFile[] {
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
		return files;
	}

	getSyncableTAbstractFiles(): TAbstractFile[] {
		return this.getFiles().filter((file) => {
			return this.syncSettingsManager.isExtensionEnabled(file.path);
		});
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

	async _handleServerCreate(path: string, diffLog?: string[]): Promise<IFile> {
		const doc = this.createFile(this.getPath(path), false, false, () => {});

		// Create directories as needed
		let folderPromise: Promise<void> = Promise.resolve();
		const dir = dirname(path);
		if (!this.existsSync(dir)) {
			folderPromise = this.mkdir(dir);
			diffLog?.push(`creating directory ${dir}`);
		}

		// Pull from remote as authoratative
		if (doc instanceof SyncFile || doc instanceof Document) {
			await folderPromise;
			try {
				doc.pull();
			} catch (e) {
				//pass
			}
			diffLog?.push(`created local file for remotely added doc ${path}`);
		}

		return doc;
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
		const file = this.docs.get(guid);
		const meta = this.syncStore.get(path);
		if (!meta) {
			console.warn("unknown sync type", path);
			return { op: "noop", path, promise: Promise.resolve() };
		}
		if (meta && isSyncFile(meta) && !meta.hash) {
			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (file instanceof SyncFile) {
			if (file.isStale && file.shouldPush) {
				diffLog.push(`pushing ${path}`);
				return {
					op: "push",
					path,
					promise: (async () => {
						await file.push();
						return file;
					})(),
				};
			} else if (file.isStale && file.shouldPull) {
				diffLog.push(`pulling ${path}`);
				return {
					op: "pull",
					path,
					promise: (async () => {
						await file.pull();
						return file;
					})(),
				};
			}
		}
		if (this.existsSync(path)) {
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
		const ffiles = this.getSyncableTAbstractFiles();
		const deletes: Delete[] = [];
		const folders = ffiles.filter((file) => file instanceof TFolder);
		const files = ffiles.filter((file) => file instanceof TFile);
		const sync = (file: TAbstractFile) => {
			// If the file is in the shared folder and not in the map, move it to the Trash
			const fileInFolder = this.checkPath(file.path);
			const fileInMap = remotePaths.contains(file.path.slice(this.path.length));
			const synced = this._provider?.synced && this._persistence?.synced;
			const vpath = this.getVirtualPath(file.path);
			if (fileInFolder && !fileInMap) {
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
		ops: FileSyncOperation[],
		types: (SyncType.Folder | SyncType.File | SyncType.Document)[],
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

	async syncFileTree(syncStore: SyncStore) {
		const ops: FileSyncOperation[] = [];
		const diffLog: string[] = [];

		this.ydoc.transact(async () => {
			// Sync folder operations first because renames/moves also affect files
			this.syncStore.migrateUp();
			this.syncByType(syncStore, diffLog, ops, [SyncType.Folder]);
		}, this);
		await Promise.all(ops.map((op) => op.promise));
		this.ydoc.transact(async () => {
			this.syncByType(syncStore, diffLog, ops, [
				SyncType.File,
				SyncType.Document,
			]);
			this.syncStore.commit();
		}, this);

		const creates = ops.filter((op) => op.op === "create");
		const renames = ops.filter((op) => op.op === "rename");
		const remotePaths = ops.map((op) => op.path);

		// Ensure these complete before checking for deletions
		await Promise.all([...creates, ...renames].map((op) => op.promise));

		const deletes = this.cleanupExtraLocalFiles(remotePaths, diffLog);

		if ([...ops, ...deletes].every((op) => op.op === "noop")) {
			this.debug("sync: noop");
		} else {
			this.log("remote paths", remotePaths);
			this.log("operations", [...ops, ...deletes]);
		}
		if (renames.length > 0 || creates.length > 0 || deletes.length > 0) {
			this.docset.update();
		}

		if (diffLog.length > 0) {
			this.log("syncFileTree diff:\n" + diffLog.join("\n"));
		}
	}

	move(path: string) {
		this.path = path;
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

	getFile(
		path: string,
		create = true,
		loadFromDisk = false,
		update = true,
	): IFile {
		const vPath = this.getVirtualPath(path);
		return this.getVFile(vPath, create, loadFromDisk, update);
	}

	getTFile(doc: Document): TFile | null {
		const maybeTFile = this.vault.getAbstractFileByPath(this.getPath(doc.path));
		if (maybeTFile instanceof TFile) {
			return maybeTFile;
		}
		return null;
	}

	getVFile(
		vpath: string,
		create = true,
		loadFromDisk = false,
		update = true,
	): IFile {
		this.log("getting vfile", create, loadFromDisk, vpath);
		const meta = this.syncStore.get(vpath);
		if (meta && meta.id !== undefined) {
			const doc = this.docs.get(meta.id);
			if (doc !== undefined) {
				doc.move(vpath);
				return doc;
			} else {
				// the ID exists, but the file doesn't
				this.log("[getVFile]: creating doc for shared ID");
				return this.createFile(this.getPath(vpath), false, update, () => {});
			}
		} else if (create) {
			// the File exists, but the ID doesn't
			this.log("[getDoc]: creating new shared ID for existing file");
			return this.createFile(
				this.getPath(vpath),
				loadFromDisk,
				update,
				() => {},
			);
		} else {
			const syncObject = this.getSyncObjectByPath(vpath);
			if (syncObject instanceof SyncNothing) {
				return syncObject;
			}
			throw new Error("No shared doc for vpath: " + vpath);
		}
	}

	createFile(
		path: string,
		loadFromDisk = false,
		update = true,
		onSync = (file: IFile) => {},
	): IFile {
		const vpath = this.getVirtualPath(path);
		const meta = this.syncStore.get(vpath);
		const isFolder = this.vault.getAbstractFileByPath(path) instanceof TFolder;

		if (isSyncFolder(meta) || isFolder) {
			return this.createSyncFolder(vpath, update);
		}

		if (!this.syncSettingsManager.isExtensionEnabled(vpath)) {
			this.warn("sync nothing for ", vpath, this.syncSettingsManager.get());
			return this.createSyncNothing(vpath);
		}

		if (isDocument(meta) || this.syncStore.checkExtension(vpath, "md")) {
			return this.createDoc(vpath, loadFromDisk, update, onSync);
		}

		return this.createSyncFile(vpath, loadFromDisk, update, onSync);
	}

	getSyncObjectByPath(vpath: string): IFile | undefined {
		let ifile: IFile | undefined;
		for (const [, file] of this.docs) {
			if (file.path === vpath) {
				ifile = file;
			}
		}
		return ifile;
	}

	createSyncNothing(vpath: string) {
		const file = new SyncNothing(vpath);
		this.docs.set(file.guid, file);
		this.docset.add(file, false);
		return file;
	}

	createSyncFolder(vpath: string, update: boolean) {
		this.log("[createSyncFolder]", `creating syncfolder`);
		if (!this.synced && !this.syncStore.has(vpath)) {
			this.warn(`potential for document split at ${vpath}`);
		}

		const meta = this.syncStore.get(vpath);
		const tfolder = this.vault.getAbstractFileByPath(this.getPath(vpath));
		if (isSyncFolder(meta)) {
			const file = (this.docs.get(meta.id) ||
				new SyncFolder(vpath, meta.id, this.relayManager, this)) as SyncFolder;
			this.docs.set(meta.id, file);
			this.docset.add(file, update);
			file.ready = true;
			return file;
		} else if (tfolder instanceof TFolder) {
			this.log(`create pushing new file ${vpath}`);
			const guid = uuidv4();
			this.ydoc.transact(() => {
				this.syncStore.new(vpath, tfolder instanceof TFolder);
			}, this);
			const file = SyncFolder.fromTFolder(this.relayManager, this, tfolder);
			this.docs.set(guid, file);
			this.docset.add(file, update);
			file.ready = true;
			return file;
		} else {
			throw new Error("missing a guid and a tfolder");
		}
	}

	createSyncFile(
		vpath: string,
		loadFromDisk: boolean,
		update: boolean,
		onSync = (file: IFile) => {},
	) {
		this.log(
			"[createSyncFile]",
			`creating syncfile, loadFromDisk=${loadFromDisk}`,
		);
		if (!this.synced && !this.syncStore.has(vpath)) {
			this.warn(`potential for document split at ${vpath}`);
		}
		const meta = this.syncStore.get(vpath);
		const hash = meta?.hash;
		const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
		if (meta?.id) {
			this.log(`create pulling from server ${vpath}`);
			const file =
				(this.docs.get(meta.id) as SyncFile) ||
				new SyncFile(vpath, hash, meta.id, this.relayManager, this);
			if (loadFromDisk) {
				file.push();
			} else if (tfile) {
				file.sync();
			}
			this.docs.set(meta.id, file);
			this.docset.add(file, update);
			file.ready = true;
			return file;
		} else if (tfile instanceof TFile) {
			this.log(`create pushing new file ${vpath}`);
			const guid = uuidv4();
			this.ydoc.transact(() => {
				this.syncStore.set(vpath, makeFileMeta(guid, getMimeType(vpath)));
			}, this);
			const file = SyncFile.fromTFile(this.relayManager, this, tfile);
			file.push().then(async () => {
				this.ydoc.transact(async () => {
					const hash = await file.sha256();
					this.syncStore.set(
						vpath,
						makeFileMeta(guid, getMimeType(vpath), hash, Date.now()),
					);
				}, this);
				onSync(file);
			});

			this.docs.set(guid, file);
			this.docset.add(file, update);
			file.ready = true;
			return file;
		} else {
			throw new Error("missing a guid and a tfile");
		}
	}

	placeHold(newFiles: TAbstractFile[]): string[] {
		const newDocs: string[] = [];
		this.ydoc.transact(() => {
			newFiles.forEach((file) => {
				const meta = this.syncStore.new(
					this.getVirtualPath(file.path),
					file instanceof TFolder,
				);
				newDocs.push(meta.id);
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
		if (!this.synced && !this.syncStore.has(vpath)) {
			this.warn(`potential for document split at ${vpath}`);
		}
		let meta = this.syncStore.get(vpath);

		if (!isDocument(meta)) {
			this.warn(`called createDoc on ${vpath}`);
		}

		if (!meta) {
			const file = this.vault.getAbstractFileByPath(this.getPath(vpath));
			if (!loadFromDisk || !file) {
				throw new Error("attempting to create a new doc without a local file");
			}
			meta = this.ydoc.transact<Meta>(() => {
				return this.syncStore.new(vpath, file instanceof TFolder);
			}, this);
		}
		const doc =
			this.docs.get(meta.id) ||
			new Document(vpath, meta.id, this.loginManager, this);
		if (!(doc instanceof Document)) {
			throw new Error("unexpected wrong document type");
		}
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
		//else if (doc instanceof Document) {
		//	this.backgroundSync.getDocument(doc);
		//}

		this.docs.set(meta.id, doc);
		this.docset.add(doc, update);

		return doc;
	}

	deleteFile(path: string) {
		const vPath = this.getVirtualPath(path);
		return this.deleteDoc(vPath);
	}

	deleteDoc(vPath: string) {
		const meta = this.syncStore.get(vPath);
		if (meta) {
			this.ydoc.transact(() => {
				this.syncStore.delete(vPath);
				const doc = this.docs.get(meta.id)?.destroy();
				if (doc) {
					this.docset.delete(doc);
				}
				this.docs.delete(meta.id);
			}, this);
			this.diskBufferStore.removeDiskBuffer(meta.id);
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

			const upload = (file: IFile) => {
				withFlag(flag.enableUploadOnShare, () => {
					if (file instanceof Document) {
						file.getProviderToken().then(() => {
							this.backgroundSync.putDocument(file);
						});
					}
				});
				if (file instanceof SyncFile) {
					if (!file.getRemote()) {
						file.push();
					}
				}
			};
			this.createFile(newPath, true, true, upload);
		} else {
			// live doc exists
			const meta = this.syncStore.get(oldVPath);
			if (!meta) return;
			const doc = this.docs.get(meta.id);
			if (!newVPath) {
				// moving out of shared folder.. destroy the live doc.
				this.ydoc.transact(() => {
					this.syncStore.delete(oldVPath);
				}, this);
				if (doc) {
					doc.destroy();
					this.docset.delete(doc);
				}
				this.docs.delete(meta.id);
			} else {
				// moving within shared folder.. move the live doc.
				const meta = this.syncStore.get(oldVPath);
				if (!meta) {
					return;
				}
				const toMove: [string, string, string][] = [
					[meta.id, oldVPath, newVPath],
				];
				if (doc instanceof SyncFolder) {
					this.syncStore.forEach((meta, path) => {
						if (path.startsWith(oldVPath + sep)) {
							const destination = path.replace(oldVPath, newVPath);
							toMove.push([meta.id, path, destination]);
						}
					});
				}
				if (doc) {
					doc.move(newVPath);
				}
				this.ydoc.transact(() => {
					toMove.forEach((move) => {
						const [guid, oldVPath, newVPath] = move;
						this.syncStore.move(oldVPath, newVPath);
						const subdoc = this.docs.get(guid);
						if (subdoc) {
							subdoc.move(newVPath);
						}
					});
				}, this);
			}
		}
	}

	destroy() {
		this.docs.forEach((doc: IFile) => {
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
		this.cas.destroy();
		this.cas = null as any;
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
	private unsubscribes: Unsubscriber[] = [];

	constructor(
		private relayManager: RelayManager,
		private vault: Vault,
		folderBuilder: (
			path: string,
			guid: string,
			relayId?: string,
			awaitingUpdates?: boolean,
		) => Promise<SharedFolder>,
		private timeProvider: TimeProvider,
		private settings: NamespacedSettings<SharedFolderSettings[]>,
	) {
		super();
		this.folderBuilder = folderBuilder;

		if (!this._offRemoteUpdates) {
			this._offRemoteUpdates = this.relayManager.remoteFolders.subscribe(
				(remotes) => {
					let updated = false;
					let relayGuid: string | undefined = undefined;
					this.items().forEach((folder) => {
						const remote = remotes.find((remote) => remote.guid == folder.guid);
						if (folder.remote != remote) {
							updated = true;
							relayGuid = folder.remote?.relay.guid;
						}
						folder.remote = remote;
					});
					if (relayGuid) {
						this.settings.update((current) => ({
							...current,
							relay: relayGuid,
						}));
					}
					if (updated) {
						this.update();
					}
				},
			);
		}
		this.timeProvider.setInterval(() => {
			this.forEach((folder) => {
				folder.sync();
			});
		}, 10000);
	}

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
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.relayManager = null as any;
		this.folderBuilder = null as any;
		this.timeProvider = null as any;
	}

	load() {
		this._load(this.settings.get());
	}

	private _load(folders: SharedFolderSettings[]) {
		let updated = false;
		console.log("loading ", folders);
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

	private async _new(
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
