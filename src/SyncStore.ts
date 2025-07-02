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
import type { SyncSettingsManager } from "./SyncSettings";

export class SyncStore extends Observable<SyncStore> {
	private legacyIds: Y.Map<string>; // Maps file paths to Document guids
	private meta: Y.Map<Meta>;
	overlay: Map<string, Meta>;
	deleteSet: Set<string>;
	typeRegistry: TypeRegistry;
	renames: Map<string, string>;

	constructor(
		public ydoc: Y.Doc,
		private namespace: string,
		public pendingUpload: Map<string, string>,
		private syncSettingsManager: SyncSettingsManager,
	) {
		super();
		this.legacyIds = this.ydoc.getMap("docs");
		this.meta = this.ydoc.getMap("filemeta_v0");
		this.overlay = new Map();
		this.renames = new Map();
		this.deleteSet = new Set();
		this.typeRegistry = new TypeRegistry(this.syncSettingsManager);
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

	resolveMove(oldVPath: string) {
		// Moves are an async operation, so we keep the old path pointer around until the move has resolved.
		this.log("resolving alias", oldVPath);
		this.renames.delete(oldVPath);
	}

	resolveAll() {
		this.renames.clear();
	}

	move(oldVPath: string, newVPath: string) {
		// This move must be finalized with a vault rename event
		this.log("moving file", oldVPath, "to", newVPath);
		this.assertVPath(oldVPath);
		this.assertVPath(newVPath);
		this.renames.set(oldVPath, newVPath);
		const guid = this.pendingUpload.get(oldVPath);
		if (guid) {
			this.pendingUpload.set(newVPath, guid);
			this.pendingUpload.delete(oldVPath);
		}
		if (this.deleteSet.has(oldVPath)) {
			this.deleteSet.add(newVPath);
			this.deleteSet.delete(oldVPath);
		}
		const overlayMeta = this.overlay.get(oldVPath);
		if (overlayMeta) {
			this.overlay.set(newVPath, overlayMeta);
			this.overlay.delete(oldVPath);
		}
		const meta = this.meta.get(oldVPath);
		if (isSyncFolderMeta(meta)) {
			this.moveFolder(oldVPath, newVPath);
		} else if (meta) {
			this.set(newVPath, meta);
			this.delete(oldVPath);
		}
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
		if (this.renames.has(path)) {
			path = this.renames.get(path)!;
		}
		if (this.deleteSet.has(path)) {
			return false;
		}
		return (
			this.meta.has(path) ||
			this.legacyIds.has(path) ||
			this.overlay.has(path) ||
			this.pendingUpload.has(path)
		);
	}

	willSet(vpath: string, meta: Meta): boolean {
		this.assertVPath(vpath);
		if (isDocumentMeta(meta) && this.legacyIds.get(vpath) !== meta.id) {
			this.log(
				"legacy vpath set to a different ID",
				this.legacyIds.get(vpath),
				meta.id,
			);
			return true;
		}
		const existing = this.meta.get(vpath);
		if (
			existing &&
			existing.id === meta.id &&
			existing.mimetype == meta.mimetype &&
			existing.type === meta.type &&
			existing.hash === meta.hash
		) {
			return false;
		}
		this.log("new meta diff", existing, meta);
		return true;
	}

	set(vpath: string, meta: Meta) {
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
			existing.hash === meta.hash
		) {
			return;
		}
		this.log("metadata write (path, existing, meta)", vpath, existing, meta);
		this.meta.set(vpath, meta);
		if (this.pendingUpload.has(vpath)) {
			this.pendingUpload.delete(vpath);
		}
	}

	processFolderOperation(event: Y.YMapEvent<Meta>) {
		const deletedFolders = new Map<string, string>();
		const addedFolders = new Map<string, string>();

		event.changes.keys.forEach((change, path) => {
			if (change.action === "delete") {
				const oldMeta = change.oldValue as Meta;
				if (oldMeta?.type === SyncType.Folder) {
					deletedFolders.set(oldMeta.id, path);
				}
			} else if (change.action === "add" || change.action === "update") {
				const newMeta = this.meta.get(path);
				if (newMeta?.type === SyncType.Folder) {
					addedFolders.set(newMeta.id, path);
				}
			}
		});

		deletedFolders.forEach((oldFolderPath, folderId) => {
			const newFolderPath = addedFolders.get(folderId);
			if (newFolderPath && oldFolderPath !== newFolderPath) {
				this.log(
					`Detected folder move from ${oldFolderPath} to ${newFolderPath}`,
				);

				const pathsMoved = new Map<string, Meta>();
				this.meta.forEach((meta, path) => {
					if (path.startsWith(newFolderPath + sep)) {
						pathsMoved.set(path, meta);
					}
				});

				this.renames.set(oldFolderPath, newFolderPath);
				this.log("setting alias", oldFolderPath, newFolderPath);
				this.log("paths to move", pathsMoved);
				pathsMoved.forEach((meta, vpath) => {
					const relativePath = vpath.slice(newFolderPath.length);
					const oldVPath = oldFolderPath + relativePath;
					this.renames.set(oldVPath, vpath);
					this.log("setting alias", oldVPath, vpath);
				});
			}
		});
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

			this.processFolderOperation(event);
			this.notifyListeners();
		};
		const legacyListener = async (event: Y.YMapEvent<string>) => {
			this.migrateUp();
			this.notifyListeners();
		};
		this.legacyIds.observe(legacyListener);
		this.meta.observe(syncFileObserver);
		this.unsubscribes.push(() => {
			this.legacyIds.unobserve(legacyListener);
		});
		this.unsubscribes.push(() => {
			this.meta.unobserve(syncFileObserver);
		});
		this.unsubscribes.push(
			this.typeRegistry.subscribe(() => {
				this.log("type registry change");
				this.notifyListeners();
			}),
		);
	}

	get(vpath: string): string | undefined {
		this.assertVPath(vpath);
		if (this.renames.has(vpath)) {
			vpath = this.renames.get(vpath)!;
		}
		if (this.deleteSet.has(vpath)) {
			return undefined;
		}

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
		if (this.renames.has(vpath)) {
			vpath = this.renames.get(vpath)!;
		}
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
		this.overlay.forEach((meta, path) => {
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
		this.set(vpath, meta);
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
		this.renames.clear();
		this.legacyIds = null as any;
		this.meta = null as any;
	}
}
