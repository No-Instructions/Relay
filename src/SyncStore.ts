"use strict";
import * as Y from "yjs";
import { sep, dirname } from "path-browserify";
import { v4 as uuidv4 } from "uuid";
import { Observable } from "./observable/Observable";
import { withFlag } from "./flagManager";
import { flag } from "./flags";
import {
	SyncType,
	TypeRegistry,
	isDocumentMeta,
	isSyncFolderMeta,
	makeDocumentMeta,
	makeFolderMeta,
	type Meta,
} from "./SyncTypes";

export class SyncStore extends Observable<SyncStore> {
	private legacyIds: Y.Map<string>; // Maps file paths to Document guids
	private meta: Y.Map<Meta>;
	overlay: Map<string, Meta>;
	deleteSet: Set<string>;
	typeRegistry: TypeRegistry;

	constructor(
		public ydoc: Y.Doc,
		private namespace: string,
		private pendingUpload: Map<string, string>,
	) {
		super();
		this.legacyIds = this.ydoc.getMap("docs");
		this.meta = this.ydoc.getMap("filemeta_v0");
		this.overlay = new Map();
		this.deleteSet = new Set();
		this.typeRegistry = new TypeRegistry();
	}

	assertVPath(path: string) {
		if (path.startsWith(this.namespace + sep)) {
			throw new Error("Expected virtual path" + path);
		}
	}

	print() {
		this.log(
			"files",
			Array.from(this.meta.entries()).map(([path, meta]) => {
				return { path, ...meta };
			}),
		);
		this.log(
			"pending...",
			Array.from(this.pendingUpload.entries()).map(([path, guid]) => {
				return { path, guid };
			}),
		);
	}

	canSync(vpath: string): boolean {
		const meta = this.getMeta(vpath);
		return this.typeRegistry.canSync(vpath, meta);
	}

	new(vpath: string): string {
		this.assertVPath(vpath);
		const guid = uuidv4();
		this.pendingUpload.set(vpath, guid);
		return guid;
	}

	forEach(callbackFn: (meta: Meta, path: string) => void) {
		//this.migrateUp();
		this.meta.forEach((meta, path) => {
			if (!this.deleteSet.has(path)) {
				callbackFn(meta, path);
			}
		});
		this.overlay.forEach((meta, path) => {
			if (!this.deleteSet.has(path)) {
				callbackFn(meta, path);
			}
		});
	}

	has(path: string) {
		if (this.deleteSet.has(path)) {
			return false;
		}
		return (
			this.meta.has(path) ||
			this.legacyIds.has(path) ||
			this.pendingUpload.has(path)
		);
	}

	set(vpath: string, meta: Meta, commit = false) {
		this.assertVPath(vpath);
		if (isDocumentMeta(meta) && this.legacyIds.get(vpath) !== meta.id) {
			this.legacyIds.set(vpath, meta.id);
		}
		const existing = this.meta.get(vpath);
		if (
			existing &&
			existing.id === meta.id &&
			existing.mimetype == meta.mimetype &&
			existing.type === meta.type &&
			!meta?.synctime &&
			!meta?.hash
		) {
			this.log("skipping metadata write", existing, meta);
			return;
		}
		this.warn("metadata write (path, existing, meta)", vpath, existing, meta);
		if (commit) {
			this.ydoc.transact(() => {
				this.meta.set(vpath, meta);
			}, this);
		} else {
			this.meta.set(vpath, meta);
		}
	}

	start() {
		withFlag(flag.enableDeltaLogging, () => {
			const logObserver = (event: Y.YMapEvent<any>) => {
				let log = "";
				log += `Transaction origin: ${event.transaction.origin}${event.transaction.origin?.constructor?.name}\n`;
				event.changes.keys.forEach((change, key) => {
					if (change.action === "add") {
						log += `Added ${key}: ${this.get(key)}\n`;
					}
					if (change.action === "update") {
						log += `Updated ${key}: ${this.get(key)}\n`;
					}
					if (change.action === "delete") {
						log += `Deleted ${key}\n`;
					}
				});
				this.debug(log);
			};
			this.legacyIds.observe(logObserver);
			this.meta.observe(logObserver);
			this.unsubscribes.push(() => {
				this.legacyIds.unobserve(logObserver);
			});
			this.unsubscribes.push(() => {
				this.meta.unobserve(logObserver);
			});
		});

		const syncFileObserver = async (event: Y.YMapEvent<Meta>) => {
			if (event.changes.keys.size === 0) {
				this.log("no changes detected");
				return;
			}

			const origin = event.transaction.origin;
			if (origin == this) return;

			this.notifyListeners();
		};
		const legacyListener = async (event: Y.YMapEvent<string>) => {
			this.migrateUp();
		};
		this.legacyIds.observe(legacyListener);
		this.meta.observe(syncFileObserver);
		this.unsubscribes.push(() => {
			this.legacyIds.unobserve(legacyListener);
		});
		this.unsubscribes.push(() => {
			this.meta.unobserve(syncFileObserver);
		});
	}

	move(oldPath: string, newPath: string) {
		this.assertVPath(oldPath);
		this.assertVPath(newPath);

		const guid = this.pendingUpload.get(oldPath);
		if (guid) {
			this.pendingUpload.set(newPath, guid);
			this.pendingUpload.delete(oldPath);
			return;
		}

		const meta = this.getMeta(oldPath);
		if (!meta) {
			this.print();
			this.warn(
				`missing metadata for ${oldPath}...${newPath} during move operation`,
			);
			return;
		}

		if (isSyncFolderMeta(meta)) {
			// Move the folder and all its contents
			this.meta.forEach((entryMeta, path) => {
				if (path === oldPath || path.startsWith(oldPath + sep)) {
					const relativePath = path.slice(oldPath.length);
					const newEntryPath = newPath + relativePath;

					// Move the entry
					this.meta.delete(path);
					this.meta.set(newEntryPath, entryMeta);

					// Update legacy_ids if needed
					if (entryMeta.type === SyncType.Document) {
						this.legacyIds.delete(path);
						this.legacyIds.set(newEntryPath, entryMeta.id);
					}
				}
			});
		} else {
			// Move single file
			if (isDocumentMeta(meta)) {
				this.legacyIds.delete(oldPath);
				this.legacyIds.set(newPath, meta.id);
			}
			this.meta.delete(oldPath);
			this.meta.set(newPath, meta);
		}
	}

	get(vpath: string): string | undefined {
		const guid = this.pendingUpload.get(vpath);
		if (guid) {
			return guid;
		}
		const meta = this.getMeta(vpath);
		if (meta) {
			return meta.id;
		}
	}

	getMeta(vpath: string): Meta | undefined {
		this.assertVPath(vpath);
		if (this.deleteSet.has(vpath)) {
			return undefined;
		}

		const meta = this.meta.get(vpath) || this.overlay.get(vpath);
		const legacy = this.legacyIds.has(vpath);

		if (!meta && this.legacyIds.has(vpath)) {
			const guid = this.legacyIds.get(vpath)!;
			const newMeta = makeDocumentMeta(guid);
			this.overlay.set(vpath, newMeta);
			return newMeta;
		}

		if (!meta) {
			return undefined;
		}

		if (isDocumentMeta(meta) && !legacy) {
			this.deleteSet.add(vpath);
			return undefined;
		}
		return meta;
	}

	delete(vpath: string) {
		this.assertVPath(vpath);
		this.legacyIds.delete(vpath);
		this.pendingUpload.delete(vpath);
		return this.meta.delete(vpath);
	}

	public get remoteIds(): Set<string> {
		const ids = new Set<string>();
		this.forEach((meta) => {
			ids.add(meta.id);
		});
		return ids;
	}

	commit() {
		if (this.overlay.size > 0) {
			this.log("committing overlay", [...this.overlay.keys()]);
		}
		this.overlay.forEach((meta, path) => {
			this.set(path, meta);
			// Update legacy ids if needed
			if (
				meta.type === SyncType.Document &&
				this.legacyIds.get(path) !== meta.id
			) {
				this.legacyIds.set(path, meta.id);
			}
		});
		this.overlay = new Map();

		if (this.deleteSet.size > 0) {
			this.log("committing deleteSet", [...this.deleteSet]);
		}
		this.deleteSet.forEach((path) => this.delete(path));
		this.deleteSet = new Set<string>();
	}

	private detectFolderMoves() {
		const movedFolders = new Map<string, string>(); // old path -> new path
		const processedFolders = new Set<string>();

		// First detect explicit folder moves (for new clients)
		this.meta.forEach((meta, newPath) => {
			if (meta.type === SyncType.Folder) {
				this.meta.forEach((otherMeta, oldPath) => {
					if (
						oldPath !== newPath &&
						otherMeta.type === SyncType.Folder &&
						otherMeta.id === meta.id
					) {
						movedFolders.set(oldPath, newPath);
					}
				});
			}
		});

		// Then detect folder moves from markdown files (for legacy clients)
		this.legacyIds.forEach((guid, newPath) => {
			let oldPath: string | undefined;
			this.meta.forEach((meta, path) => {
				if (
					meta.type === SyncType.Document &&
					meta.id === guid &&
					path !== newPath
				) {
					oldPath = path;
				}
			});

			if (oldPath) {
				const oldDir = dirname(oldPath);
				const newDir = dirname(newPath);
				if (oldDir !== newDir) {
					movedFolders.set(oldDir, newDir);
				}
			}
		});

		// Process folder moves from deepest to shallowest
		const sortedMoves = Array.from(movedFolders.entries()).sort(
			([a], [b]) => b.length - a.length,
		);

		sortedMoves.forEach(([oldFolder, newFolder]) => {
			if (!processedFolders.has(oldFolder)) {
				this.moveFolder(oldFolder, newFolder);
				processedFolders.add(oldFolder);
			}
		});
	}

	private moveFolder(oldFolder: string, newFolder: string) {
		this.log("moving folder", oldFolder, "to", newFolder);

		// First, collect all metadata that needs to be moved
		const pathsToMove = new Map<string, Meta>();
		this.meta.forEach((meta, path) => {
			if (path === oldFolder || path.startsWith(oldFolder + sep)) {
				pathsToMove.set(path, meta);
			}
		});

		// Move the folder itself if it exists
		const folderMeta = this.meta.get(oldFolder);
		if (folderMeta) {
			this.meta.set(newFolder, folderMeta);
			this.meta.delete(oldFolder);
		}

		// Move each path to new location
		pathsToMove.forEach((meta, oldPath) => {
			// Skip folder itself as it's already handled
			if (oldPath === oldFolder) return;

			const relativePath = oldPath.slice(oldFolder.length);
			const newPath = newFolder + relativePath;

			// Delete old path
			this.move(oldPath, newPath);
		});
	}

	markUploaded(vpath: string, meta: Meta) {
		if (!this.has(vpath)) {
			throw new Error(`unexpected vpath ${vpath} marked uploaded`);
		}
		if (this.pendingUpload.has(vpath)) {
			this.set(vpath, meta);
			this.pendingUpload.delete(vpath);
		}
	}

	migrateFile(guid: string, vpath: string) {
		this.assertVPath(vpath);
		if (this.meta.get(vpath)?.id === guid) {
			return;
		}

		const folders = new Set<string>();
		const parts = vpath.split(sep);
		let currentPath = "";
		for (let i = 0; i < parts.length - 1; i++) {
			currentPath = parts.slice(0, i + 1).join(sep);
			folders.add(currentPath);
		}

		if (!(this.meta.has(vpath) || this.overlay.has(vpath))) {
			if (vpath.endsWith(".md")) {
				this.warn(`migrated legacy key on ${vpath}`);
				this.overlay.set(vpath, makeDocumentMeta(guid));
			}
		}

		folders.forEach((folderPath) => {
			if (
				folderPath &&
				!(this.meta.has(folderPath) || this.overlay.has(folderPath))
			) {
				const guid = uuidv4();
				console.log("creating folder path", folderPath, guid);
				this.overlay.set(folderPath, makeFolderMeta(guid));
			}
		});
	}

	migrateUp() {
		this.detectFolderMoves();
		this.legacyIds.forEach((guid, vpath) => {
			this.migrateFile(guid, vpath);
		});
	}

	destroy() {
		super.destroy();
		this.overlay.clear();
		this.deleteSet.clear();
		this.legacyIds = null as any;
		this.meta = null as any;
	}
}
