"use strict";
import * as Y from "yjs";
import { TFolder } from "obsidian";
import { IndexeddbPersistence } from "y-indexeddb";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, open, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Doc } from "yjs";
import type { Vault } from "./obsidian-api/Vault";
import { HasProvider } from "./HasProvider";
import { Document } from "./Document";
import { curryLog } from "./debug";
import { ObservableSet } from "./ObservableSet";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";

export interface SharedFolderSettings {
	guid: string;
	path: string;
}

export class SharedFolder extends HasProvider {
	path: string;
	ids: Y.Map<string>; // Maps document paths to guids
	docs: Map<string, Document>; // Maps guids to SharedDocs
	private vault: Vault;
	readyPromise: Promise<SharedFolder> | null = null;

	private _persistence: IndexeddbPersistence;

	private addLocalDocs = () => {
		const files = this.vault.getFiles();
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
				this.createFile(file.path, true);
			}
		});
	};

	constructor(
		guid: string,
		path: string,
		loginManager: LoginManager,
		vault: Vault,
		tokenStore: LiveTokenStore
	) {
		super(guid, tokenStore, loginManager);
		this.vault = vault;
		this.path = path;
		this.ids = this.ydoc.getMap("docs");
		this.docs = new Map();
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
		return this._provider?.wsconnected && this._provider?.synced;
	}

	async whenReady(): Promise<SharedFolder> {
		//Note this doesn't guarantee that the map is actually synced...
		if (this.readyPromise) {
			return this.readyPromise;
		}
		this.readyPromise = new Promise((resolve) => {
			Promise.all([this.onceConnected(), this.onceProviderSynced()]).then(
				() => {
					console.log("connected and synced!");
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
		const map = doc.getMap<string>("docs");
		this.ydoc.transact(() => {
			map.forEach((guid, path) => {
				const fullPath = this.vault.root + this.path + path;

				try {
					this.assertPath(this.path + path);
				} catch {
					this.ids.delete(path);
					return;
				}

				if (!existsSync(fullPath)) {
					const dir = dirname(fullPath);
					if (!existsSync(dir)) {
						mkdirSync(dir, { recursive: true });
					}

					const pathInIDs = this.ids.get(path);
					const inIds = Array.from(this.ids.values()).includes(guid);
					const inDocs = this.docs.get(guid);
					if (!pathInIDs && inIds && inDocs) {
						// it was a rename
						let keyFound = null;
						for (const [key, value] of map.entries()) {
							if (value === guid) {
								keyFound = key;
								break;
							}
						}
						this.log(`${keyFound} was renamed to ${path}`);
					}

					// this will trigger `create` which will read the file from disk by default.
					// so we need to pre-empt that by loading the file into docs.
					open(fullPath, "w", (err, fd) => {
						if (err) {
							throw err;
						}
						this.log(
							`Sync Message for ${this.path + path}: opening`
						);
					});
				}
			});
		}, this);

		// Delete files that are no longer shared
		const files = this.vault.getFiles();
		files.forEach((file) => {
			// If the file is in the shared folder and not in the map, move it to the Trash
			const fileInFolder = this.checkPath(file.path);
			const fileInMap = map.has(file.path.slice(this.path.length));
			const synced = this._provider?.synced && this._persistence?.synced;
			if (fileInFolder && !fileInMap) {
				if (synced) {
					this.log("Trashing File...", file.path, this.path);
					this.vault.trashLocal(file.path);
				}
			}
		});
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

	getFile(path: string, create = true): Document {
		const vPath = this.getVirtualPath(path);
		try {
			return this.getDoc(vPath, create);
		} catch (e) {
			console.log(e, path);
			throw e;
		}
	}

	getDoc(vPath: string, create = true): Document {
		const id = this.ids.get(vPath);
		if (id !== undefined) {
			const doc = this.docs.get(id);
			if (doc !== undefined) {
				doc.path = vPath;
				return doc;
			} else {
				// the ID exists, but the file doesn't
				this.log("[getDoc]: creating doc for shared ID");
				return this.createDoc(vPath, false);
			}
		} else if (create) {
			// the File exists, but the ID doesn't
			this.log("[getDoc]: creating new shared ID for existing file");
			return this.createDoc(vPath, true);
		} else {
			throw new Error("No shared doc for vpath: " + vPath);
		}
	}

	createFile(path: string, loadFromDisk = false): Document {
		const vPath = this.getVirtualPath(path);
		return this.createDoc(vPath, loadFromDisk);
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

	createDoc(vpath: string, loadFromDisk = false): Document {
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
		let doc = this.docs.get(guid);
		if (!doc) {
			doc = new Document(vpath, guid, this.loginManager, this);
		}

		let contents = "";
		if (loadFromDisk && this.existsSync(doc)) {
			contents = this.readFileSync(doc);
			const text = doc.ydoc.getText("contents");
			doc.whenSynced()
				.then(async () => {
					return await doc?.locallyRaised();
				})
				.then((locallyRaised) => {
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
				this.docs.get(guid)?.destroy();
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
				doc?.destroy();
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
					this.docs.delete(guid); // let it be recreated with the right info
				}, this);
				doc?.destroy();
				//XXX holy coupling batman
			}
		}
	}

	destroy() {
		this.docs.forEach((doc) => {
			doc.destroy();
			this.docs.delete(doc.guid);
		});
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
			return path.contains(sharedFolder.path + "/");
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
