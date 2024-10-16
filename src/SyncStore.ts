"use strict";
import * as Y from "yjs";
import { HasLogging } from "./debug";
import { sep, dirname } from "path-browserify";
import { v4 as uuidv4 } from "uuid";
import { getMimeType } from "./mimetypes";

export enum SyncType {
	Folder = "folder",
	Document = "markdown",
	File = "octet-stream",
}

interface MetaBase {
	id: string;
	version: 0;
	type: SyncType;
	hash?: string;
	synctime?: number;
	mimetype?: string;
}

export interface FolderMeta extends MetaBase {
	type: SyncType.Folder;
}

export interface DocumentMeta extends MetaBase {
	type: SyncType.Document;
}

export interface FileMeta extends MetaBase {
	type: SyncType.File;
	mimetype: string;
	hash?: string;
	synctime?: number;
}

export type Meta = FolderMeta | DocumentMeta | FileMeta;

export function isFileMeta(meta?: Meta): meta is FileMeta {
	return meta?.type === SyncType.File;
}

export function isDocMeta(meta?: Meta): meta is DocumentMeta {
	return meta?.type === SyncType.Document;
}

export function isSyncFolder(meta?: Meta): meta is FolderMeta {
	return meta?.type === SyncType.Folder;
}

export function isDocument(meta?: Meta): meta is DocumentMeta {
	return meta?.type === SyncType.Document;
}

export function isSyncFile(meta?: Meta): meta is FileMeta {
	return meta?.type === SyncType.File;
}

export function makeDocumentMeta(guid: string): Meta {
	return {
		version: 0,
		id: guid,
		type: SyncType.Document,
	};
}

export function makeFolderMeta(guid: string): Meta {
	return {
		version: 0,
		id: guid,
		type: SyncType.Folder,
	};
}

export function makeFileMeta(
	guid: string,
	mimetype: string,
	hash?: string,
	synctime?: number,
): Meta {
	return {
		version: 0,
		id: guid,
		type: SyncType.File,
		mimetype,
		synctime,
		hash,
	};
}

export class SyncStore extends HasLogging {
	private legacy_ids: Y.Map<string>; // Maps file paths to Document guids
	private meta: Y.Map<Meta>;
	overlay: Map<string, Meta>;
	deleteSet: Set<string>;

	constructor(public ydoc: Y.Doc) {
		super();
		this.legacy_ids = this.ydoc.getMap("docs");
		this.meta = this.ydoc.getMap("filemeta_v0");
		this.overlay = new Map();
		this.deleteSet = new Set();
	}

	print() {
		this.log(
			"files",
			Array.from(this.meta.entries()).map(([path, meta]) => {
				return { path, ...meta };
			}),
		);
	}

	new(vpath: string, isFolder: boolean): Meta {
		let meta;
		if (!isFolder) {
			if (this.checkExtension(vpath, "md")) {
				meta = makeDocumentMeta(uuidv4());
			} else {
				meta = makeFileMeta(uuidv4(), getMimeType(vpath));
			}
		} else {
			meta = makeFolderMeta(uuidv4());
		}
		this.set(vpath, meta);
		return meta;
	}

	forEach(callbackFn: (meta: Meta, path: string) => void) {
		this.migrateUp();
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
		this.log("has", path, [...this.deleteSet]);
		if (this.deleteSet.has(path)) {
			return false;
		}
		return this.meta.has(path) || this.legacy_ids.has(path);
	}

	set(path: string, meta: Meta) {
		this.log("set", path, meta);
		if (isDocument(meta)) {
			this.legacy_ids.set(path, meta.id);
		}
		this.meta.set(path, meta);
	}

	move(oldPath: string, newPath: string) {
		const meta = this.get(oldPath);
		if (!meta) {
			throw new Error(`missing metadata for ${newPath} during move operation`);
		}

		if (isSyncFolder(meta)) {
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
						this.legacy_ids.delete(path);
						this.legacy_ids.set(newEntryPath, entryMeta.id);
					}
				}
			});
		} else {
			// Move single file
			if (isDocument(meta)) {
				this.legacy_ids.delete(oldPath);
				this.legacy_ids.set(newPath, meta.id);
			}
			this.meta.delete(oldPath);
			this.meta.set(newPath, meta);
		}
	}

	get(path: string): Meta | undefined {
		if (this.deleteSet.has(path)) {
			return undefined;
		}

		const meta = this.meta.get(path) || this.overlay.get(path);
		const legacy = this.legacy_ids.has(path);

		if (!meta && this.legacy_ids.has(path)) {
			const guid = this.legacy_ids.get(path)!;
			const newMeta = makeDocumentMeta(guid);
			this.overlay.set(path, newMeta);
			return newMeta;
		}

		if (!meta) {
			return undefined;
		}

		if (isDocMeta(meta) && !legacy) {
			this.deleteSet.add(path);
			return undefined;
		}
		return meta;
	}

	delete(path: string) {
		this.legacy_ids.delete(path);
		return this.meta.delete(path);
	}

	checkExtension(path: string, extension = ".md"): boolean {
		return path.endsWith(extension);
	}

	public get remoteIds(): Set<string> {
		const ids = new Set<string>();
		this.forEach((meta) => {
			ids.add(meta.id);
		});
		return ids;
	}

	commit() {
		this.log("committing overlay", [...this.overlay.keys()]);
		this.overlay.forEach((meta, path) => {
			// Store in meta map
			this.meta.set(path, meta);

			// Update legacy ids if needed
			if (meta.type === SyncType.Document) {
				this.legacy_ids.set(path, meta.id);
			}
		});
		this.overlay = new Map();

		this.log("committing deleteSet", [...this.deleteSet]);
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
		this.legacy_ids.forEach((guid, newPath) => {
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
			this.meta.delete(oldPath);

			// Set new path
			this.meta.set(newPath, meta);

			// Update legacy_ids if it's a markdown file
			if (meta.type === SyncType.Document) {
				this.legacy_ids.delete(oldPath);
				this.legacy_ids.set(newPath, meta.id);
			}
		});
	}

	migrateFile(guid: string, path: string) {
		if (!this.checkExtension(path)) {
			this.warn("tried to upMigrate a non Document", guid, path);
			this.legacy_ids.delete(path);
			return;
		}

		const folders = new Set<string>();
		const parts = path.split(sep);
		let currentPath = "";
		for (let i = 0; i < parts.length - 1; i++) {
			currentPath = parts.slice(0, i + 1).join(sep);
			folders.add(currentPath);
		}

		if (!(this.meta.has(path) || this.overlay.has(path))) {
			this.overlay.set(path, makeDocumentMeta(guid));
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
		this.warn("overlay", [...this.overlay.keys()]);
	}

	migrateUp() {
		this.detectFolderMoves();
		this.legacy_ids.forEach((guid, path) => {
			this.migrateFile(guid, path);
		});
	}
}