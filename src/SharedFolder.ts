"use strict";
import * as Y from "yjs";
import { TFolder, debounce } from "obsidian";
import type { FileManager } from "./obsidian-api/FileManager";
import { IndexeddbPersistence } from "y-indexeddb";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, open, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Doc } from "yjs";
import type { Vault } from "./obsidian-api/Vault";
import { HasProvider, type ConnectionState } from "./HasProvider";
import { Document } from "./Document";
import { curryLog } from "./debug";
import { ObservableSet } from "./ObservableSet";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";
import moment from "moment";

export interface SharedFolderSettings {
	guid: string;
	path: string;
}

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
	ids: Y.Map<string>; // Maps document paths to guids
	docs: Map<string, Document>; // Maps guids to SharedDocs
	docset: Documents;
	log: (message: string) => void;
	private vault: Vault;
	private fileManager: FileManager;
	private readyPromise: Promise<SharedFolder> | null = null;

	private _persistence: IndexeddbPersistence;

	private addLocalDocs = () => {
		const files = this.vault.getFiles();
		const docs: Document[] = [];
		const vpaths: string[] = [];
		files.forEach((file) => {
			// if the file is in the shared folder and not in the map, move it to the Trash
			if (file instanceof TFolder) {
				return;
			}
			if (this.checkPath(file.path) && !this.ids.has(file.path)) {
				vpaths.push(this.getVirtualPath(file.path));
			}
		});
		this.placeHold(vpaths);
		files.forEach((file) => {
			if (file instanceof TFolder) {
				return;
			}
			if (this.checkPath(file.path) && !this.ids.has(file.path)) {
				const doc = this.createFile(file.path, true, false);
				docs.push(doc);
			}
			if (this.checkPath(file.path) && this.ids.has(file.path)) {
				const doc = this.createFile(file.path, false, false);
				docs.push(doc);
			}
		});
		if (docs.length > 0) {
			console.warn("local docs added", docs);
			this.docset.update();
		}
	};

	constructor(
		guid: string,
		path: string,
		loginManager: LoginManager,
		vault: Vault,
		fileManager: FileManager,
		tokenStore: LiveTokenStore
	) {
		super(guid, tokenStore, loginManager);
		this.fileManager = fileManager;
		this.vault = vault;
		this.path = path;
		this.ids = this.ydoc.getMap("docs");
		this.docs = new Map();
		this.docset = new Documents();
		this._persistence = new IndexeddbPersistence(this.guid, this.ydoc);
		this._persistence.once("synced", () => {
			console.log(this.ids);
		});

		this.getProviderToken().then((token) => {
			this.connect();
		});

		this.whenReady().then(() => {
			this.addLocalDocs();
		});

		this.log = curryLog(`[SharedFolder](${this.path}):`);
		this.ydoc.on(
			"update",
			(update: Uint8Array, origin: any, doc: Y.Doc) => {
				if (origin == this) {
					return;
				}
				console.log(this._debugFileTree());
				this.syncFileTree(doc, update);
			}
		);
	}

	public get name(): string {
		return this.path.split("/").pop() || "";
	}

	public get location(): string {
		return this.path.split("/").slice(0, -1).join("/");
	}

	public get settings(): SharedFolderSettings {
		return { guid: this.guid, path: this.path };
	}

	public get ready(): boolean {
		return this.connected && this.synced;
	}

	async whenReady(): Promise<SharedFolder> {
		//Note this doesn't guarantee that the map is actually synced...
		if (this.readyPromise) {
			return this.readyPromise;
		}
		this.readyPromise = new Promise((resolve) => {
			Promise.all([this.onceConnected(), this.onceProviderSynced()]).then(
				() => {
					resolve(this);
				}
			);
		});
		return this.readyPromise;
	}

	_debugFileTree(): Map<string, any> {
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

	syncFileTree(doc: Doc, update: Uint8Array) {
		const creates: Document[] = [];
		const renames: string[] = [];
		const deletes: string[] = [];
		const map = doc.getMap<string>("docs");

		const diffLog: string[] = [];

		// Apply Updates for shared docs
		this.ydoc.transact(() => {
			map.forEach((guid, path) => {
				const fullPath = this.vault.root + this.path + path;

				// Check if the path is valid (inside of shared folder), otherwise delete
				try {
					this.assertPath(this.path + path);
				} catch {
					console.warn(
						"Deleting doc (somehow moved outside of shared folder)",
						path
					);
					this.ids.delete(path);
					diffLog.push(
						"Deleting doc (somehow moved outside of shared folder)"
					);
					return;
				}

				if (!existsSync(fullPath)) {
					const dir = dirname(fullPath);
					if (!existsSync(dir)) {
						mkdirSync(dir, { recursive: true });
						diffLog.push(`creating directory ${dir}`);
					}

					const inIds: boolean = Array.from(
						this.ids.values()
					).includes(guid);
					const doc = this.docs.get(guid);
					if (inIds && doc) {
						// Rename
						const oldPath = this.getPath(doc.path);
						diffLog.push(`${oldPath} was renamed to ${path}`);
						this.log(`${oldPath} was renamed to ${path}`);
						const file = this.vault.getAbstractFileByPath(oldPath);
						if (file) {
							renames.push(oldPath);
							this.fileManager.renameFile(file, this.path + path);
						}
					} else {
						// this will trigger `create` which will read the file from disk by default.
						// so we need to pre-empt that by loading the file into docs.
						const doc = this.createDoc(path, false, false);
						creates.push(doc);
						const start = moment.now();
						doc.locallyRaised(false);
						doc.whenReady().then(() => {
							const end = moment.now();
							console.log(
								`send delay: received content for ${
									doc.path
								} after ${end - start}ms`
							);
						});
						diffLog.push(
							`created local file for remotely added doc ${path}`
						);
						open(fullPath, "w", (err, fd) => {
							if (err) {
								throw err;
							}
							this.log(
								`Sync Message for ${this.path + path}: opening`
							);
						});
					}
				}
			});
		}, this);

		// Delete files that are no longer shared
		const files = this.vault.getFiles();
		files.forEach((file) => {
			// If the file is in the shared folder and not in the map, move it to the Trash
			const fileInFolder = this.checkPath(file.path);
			const wasRenamed = renames.contains(file.path);
			const fileInMap = map.has(file.path.slice(this.path.length));
			const synced = this._provider?.synced && this._persistence?.synced;
			if (fileInFolder && !fileInMap && !wasRenamed) {
				if (synced) {
					diffLog.push(
						`deleted local file ${file.path} for remotely deleted doc`
					);
					this.log(`Trashing File... ${this.path} ${file.path}`);
					this.vault.trashLocal(file.path);
					deletes.push(file.path);
				}
			}
		});
		if ([...renames, ...creates, ...deletes].length > 0) {
			this.docset.update();
		}
		this.log("syncFileTree diff:\n" + diffLog.join("\n"));
	}

	readFileSync(doc: Document): string {
		const fullPath = this.vault.root + this.path + doc.path;
		return readFileSync(fullPath, "utf-8");
	}

	existsSync(doc: Document): boolean {
		const fullPath = this.vault.root + this.path + doc.path;
		return existsSync(fullPath);
	}

	writeFileSync(doc: Document, content: string): void {
		const fullPath = this.vault.root + this.path + doc.path;
		writeFileSync(fullPath, content);
	}

	getPath(path: string): string {
		return this.path + path;
	}

	assertPath(path: string) {
		if (!this.checkPath(path)) {
			throw new Error("Path is not in shared folder: " + path);
		}
	}

	checkPath(path: string): boolean {
		return path.startsWith(this.path + "/");
	}

	getVirtualPath(path: string): string {
		this.assertPath(path);

		const vPath = path.slice(this.path.length);
		return vPath;
	}

	getFile(path: string, create = true, update = true): Document {
		const vPath = this.getVirtualPath(path);
		try {
			return this.getDoc(vPath, create, update);
		} catch (e) {
			console.log(e, path);
			throw e;
		}
	}

	getDoc(vPath: string, create = true, update = true): Document {
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
			return this.createDoc(vPath, true, update);
		} else {
			throw new Error("No shared doc for vpath: " + vPath);
		}
	}

	createFile(path: string, loadFromDisk = false, update = true): Document {
		const vPath = this.getVirtualPath(path);
		return this.createDoc(vPath, loadFromDisk, update);
	}

	placeHold(vpaths: string[]) {
		this.ydoc.transact(() => {
			vpaths.forEach((vpath) => {
				if (!this.ids.has(vpath)) {
					const guid = randomUUID();
					this.ids.set(vpath, guid);
				}
			});
		}, this);
	}

	createDoc(vpath: string, loadFromDisk = false, update = true): Document {
		if (!this._provider?.synced && !this.ids.get(vpath)) {
			this.log("WARNING may cause document split");
		}
		const maybeGuid: string | undefined = this.ids.get(vpath);
		let guid: string;
		if (maybeGuid === undefined) {
			guid = randomUUID();
			this.ydoc.transact(() => {
				this.ids.set(vpath, guid); // Register the doc as soon as possible to avoid a race condition
			}, this);
		} else {
			guid = maybeGuid;
		}
		const doc =
			this.docs.get(guid) ||
			new Document(vpath, guid, this.loginManager, this);
		if (loadFromDisk && this.existsSync(doc)) {
			const contents = this.readFileSync(doc);
			const text = doc.ydoc.getText("contents");
			doc.whenSynced()
				.then(async () => {
					return await doc.locallyRaised();
				})
				.then((locallyRaised: boolean) => {
					if (
						locallyRaised &&
						contents &&
						text.toString() != contents
					) {
						this.log(`Locally Raised; Syncing file into ytext.`);
						text.insert(0, contents);
					}
				});
		}

		if (!vpath) {
			throw new Error("empty vpath!");
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
			this.createDoc(newVPath, true);
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
					console.warn("unexpected missing guid");
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
		if (this._persistence) {
			this._persistence.destroy();
		}
		this.docset.clear();
	}
}
export class SharedFolders extends ObservableSet<SharedFolder> {
	private folderBuilder: (path: string, guid: string) => SharedFolder;

	public toSettings(): SharedFolderSettings[] {
		return this.items().map((folder) => folder.settings);
	}

	public delete(item: SharedFolder): boolean {
		item?.destroy();
		return super.delete(item);
	}

	update() {
		this.notifyListeners();
		return;
	}

	lookup(path: string): SharedFolder | null {
		const folder = this.find((sharedFolder: SharedFolder) => {
			return path.startsWith(sharedFolder.path + "/");
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
	}

	constructor(folderBuilder: (guid: string, path: string) => SharedFolder) {
		super();
		this.folderBuilder = folderBuilder;
	}

	new(path: string, guid: string) {
		const existing = this.find((folder) => folder.path == path);
		if (existing) {
			return existing;
		}
		const folder = this.folderBuilder(path, guid);
		this.add(folder);
		return folder;
	}
}
