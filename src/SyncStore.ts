"use strict";
import * as Y from "yjs";
import { sep, dirname, join } from "path-browserify";
import { v4 as uuidv4 } from "uuid";
import { Observable } from "./observable/Observable";
import { withFlag } from "./flagManager";
import { flag } from "./flags";
import {
	SyncType,
	TypeRegistry,
	isCanvasMeta,
	isDocumentMeta,
	isSyncFolderMeta,
	makeDocumentMeta,
	makeFolderMeta,
	type Meta,
} from "./SyncTypes";
import type { SyncSettingsManager } from "./SyncSettings";

export interface MapDeltaEntry {
	path: string;
	guid: string;
	type?: string;
}

export interface MapDeltaRemoval {
	path: string;
	oldValue: { id: string; type?: string } | undefined;
}

export interface MapDeltaPairedMove {
	guid: string;
	from: string;
	to: string;
}

export interface FolderMapDelta {
	adds: MapDeltaEntry[];
	updates: MapDeltaEntry[];
	deletes: MapDeltaRemoval[];
	moves: MapDeltaPairedMove[];
}

/**
 * Convert a Y.Map observer event into a membership delta with move pairing:
 * within one transaction, a delete paired with an add carrying the same guid
 * is a move. Folder and child moves use the same representation, so a
 * paired move is structurally incapable of being misread as
 * delete-then-create. A delete+re-add of one guid at one path collapses
 * into an update.
 *
 * `oldValue` is captured live from the observer event, before GC erases the
 * deleted Meta.
 */
export function extractMapDelta(
	event: Y.YMapEvent<Meta>,
	meta: Y.Map<Meta>,
): FolderMapDelta {
	const adds: MapDeltaEntry[] = [];
	const updates: MapDeltaEntry[] = [];
	const deletes: MapDeltaRemoval[] = [];
	const moves: MapDeltaPairedMove[] = [];
	const deletedByGuid = new Map<string, MapDeltaRemoval>();
	const addedByGuid = new Map<string, MapDeltaEntry>();

	event.changes.keys.forEach((change, path) => {
		if (change.action === "delete") {
			const oldValue = change.oldValue as Meta | undefined;
			if (oldValue?.id) {
				deletedByGuid.set(oldValue.id, {
					path,
					oldValue: { id: oldValue.id, type: oldValue.type },
				});
			} else {
				deletes.push({ path, oldValue: undefined });
			}
			return;
		}
		const newMeta = meta.get(path);
		if (!newMeta) return;
		const summary: MapDeltaEntry = {
			path,
			guid: newMeta.id,
			type: newMeta.type,
		};
		// Updates participate in move pairing too: a move onto an occupied
		// path arrives as delete(old)+update(new) since the destination key
		// already existed.
		addedByGuid.set(newMeta.id, summary);
		if (change.action !== "add") {
			updates.push(summary);
		}
	});

	deletedByGuid.forEach((removal, guid) => {
		const added = addedByGuid.get(guid);
		if (added) {
			addedByGuid.delete(guid);
			const updateIndex = updates.indexOf(added);
			if (added.path !== removal.path) {
				if (updateIndex >= 0) updates.splice(updateIndex, 1);
				moves.push({ guid, from: removal.path, to: added.path });
			} else if (updateIndex < 0) {
				updates.push(added); // delete+re-add of one guid at one path
			}
			return;
		}
		deletes.push(removal);
	});
	addedByGuid.forEach((summary) => {
		if (!updates.includes(summary)) adds.push(summary);
	});

	return { adds, updates, deletes, moves };
}

export class SyncStore extends Observable<SyncStore> {
	private legacyIds: Y.Map<string>; // Maps file paths to Document guids
	private meta: Y.Map<Meta>;
	overlay: Map<string, Meta>;
	deleteSet: Set<string>;
	typeRegistry: TypeRegistry;

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

	move(oldVPath: string, newVPath: string) {
		this.log("moving file", oldVPath, "to", newVPath);
		this.assertVPath(oldVPath);
		this.assertVPath(newVPath);
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
		this.log("minted identity", vpath, guid);
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

	getCommittedSubdocGuids(): string[] {
		const guids = new Set<string>();
		this.meta.forEach((meta, path) => {
			if (this.deleteSet.has(path)) return;
			if (isDocumentMeta(meta) || isCanvasMeta(meta)) {
				guids.add(meta.id);
			}
		});
		this.legacyIds.forEach((guid, path) => {
			if (this.deleteSet.has(path)) return;
			guids.add(guid);
		});
		return Array.from(guids).sort();
	}

	/**
	 * Like forEach, but also yields pending-upload-only paths (where no meta
	 * has been written yet). The callback receives `null` for those entries.
	 * Used by reconciliation sweeps that need to retry uploads which never
	 * completed (and thus never wrote meta locally).
	 */
	forEachWithPending(
		callbackFn: (meta: Meta | null, path: string) => void,
	) {
		const seen = new Set<string>();
		this.meta.forEach((meta, path) => {
			if (this.deleteSet.has(path)) return;
			seen.add(path);
			callbackFn(meta, path);
		});
		this.overlay.forEach((meta, path) => {
			if (seen.has(path) || this.deleteSet.has(path)) return;
			seen.add(path);
			callbackFn(meta, path);
		});
		this.pendingUpload.forEach((_guid, path) => {
			if (seen.has(path) || this.deleteSet.has(path)) return;
			callbackFn(null, path);
		});
	}

	has(path: string) {
		return this.hasKnown(path) || this.hasClaim(path);
	}

	/**
	 * Membership known outside the device's own claims: the committed map,
	 * the legacy map, or the migration overlay. Split from `has()` so boot
	 * classification can ask about membership without the device's pending
	 * claims vouching for themselves.
	 */
	hasKnown(path: string): boolean {
		if (this.deleteSet.has(path)) {
			return false;
		}
		return (
			this.meta.has(path) ||
			this.legacyIds.has(path) ||
			this.overlay.has(path)
		);
	}

	/** The device holds unpublished identity for this path. */
	hasClaim(path: string): boolean {
		if (this.deleteSet.has(path)) {
			return false;
		}
		return this.pendingUpload.has(path);
	}

	/**
	 * Every path persisted membership holds: the committed and legacy maps,
	 * raw. Claims and the migration overlay are excluded — the boot
	 * snapshot holds membership only.
	 */
	membershipPaths(): Set<string> {
		const paths = new Set<string>();
		this.meta.forEach((_meta, path) => {
			paths.add(path);
		});
		this.legacyIds.forEach((_guid, path) => {
			paths.add(path);
		});
		return paths;
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
		// Both membership maps commit in one transaction: a document entry
		// must never be observable in one map without the other. A nested
		// transact inherits the caller's transaction and origin; a bare
		// call keeps the null origin its implicit transactions carried.
		this.ydoc.transact(() => {
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
			const pendingGuid = this.pendingUpload.get(vpath);
			if (pendingGuid && pendingGuid === meta.id) {
				this.pendingUpload.delete(vpath);
			} else if (pendingGuid) {
				// The pending-upload hold is now stale; if nothing clears it,
				// the path re-publishes when this committed entry is deleted.
				this.warn("committed claim shadows a pending-upload hold", vpath, {
					pending: pendingGuid,
					committed: meta.id,
				});
			}
		});
	}

	/** Receives map deltas plus their transaction origin. */
	onMapDelta: ((delta: FolderMapDelta, origin: unknown) => void) | null =
		null;
	private readonly mapDeltaSubscribers = new Set<
		(delta: FolderMapDelta, origin: unknown) => void
	>();

	subscribeMapDelta(
		listener: (delta: FolderMapDelta, origin: unknown) => void,
	): () => void {
		this.mapDeltaSubscribers.add(listener);
		return () => this.mapDeltaSubscribers.delete(listener);
	}

	/**
	 * Observer for committed claims landing on paths that still carry a
	 * pending upload hold under a different identity. Membership publishes
	 * only after content transfer, so a competing claim can commit while
	 * the transfer is in flight; this feed lets the host cancel that
	 * transfer instead of paying for bytes whose publication the
	 * markUploaded recheck will refuse. Local transactions cannot contest
	 * their own hold (publication clears the hold in the same transaction),
	 * so every claim surfaced here came from another writer.
	 */
	onCompetingClaim: ((path: string, meta: Meta) => void) | null = null;

	start() {
		withFlag(flag.enableDeltaLogging, () => {
			const logObserver = (event: Y.YMapEvent<string> | Y.YMapEvent<Meta>) => {
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
				this.legacyIds?.unobserve(logObserver);
			});
			this.unsubscribes.push(() => {
				this.meta?.unobserve(logObserver);
			});
		});

		const syncFileObserver = (event: Y.YMapEvent<Meta>) => {
			if (event.changes.keys.size === 0) {
				this.log("no changes detected");
				return;
			}

			// A re-added entry supersedes any masked deletion for its path,
			// whatever the transaction origin: a stale deleteSet entry would
			// hide the live entry from every accessor and commit() would
			// delete it outright.
			event.changes.keys.forEach((change, path) => {
				if (change.action !== "delete" && this.deleteSet.has(path)) {
					this.deleteSet.delete(path);
				}
			});

			const origin = event.transaction.origin;
			if (origin == this) return;

			// Compute a delta only when at least one consumer is installed.
			if (this.onMapDelta || this.mapDeltaSubscribers.size > 0) {
				const delta = extractMapDelta(event, this.meta);
				this.onMapDelta?.(delta, origin);
				this.mapDeltaSubscribers.forEach((listener) => listener(delta, origin));
			}
			// The size gate reads the in-memory hold index, so the default
			// path (no pending upload — the steady state) pays nothing per
			// membership transaction. Without it, every changed key costs a
			// backing-storage read — and the initial provider sync of a large
			// folder lands its whole membership map as one transaction.
			if (this.onCompetingClaim && this.pendingUpload.size > 0) {
				event.changes.keys.forEach((change, path) => {
					if (change.action === "delete") return;
					const committed = this.meta.get(path);
					if (!committed) return;
					const pendingGuid = this.pendingUpload.get(path);
					if (pendingGuid && pendingGuid !== committed.id) {
						this.onCompetingClaim?.(path, committed);
					}
				});
			}
			this.notifyListeners();
		};
		const legacyListener = (event: Y.YMapEvent<string>) => {
			// Old clients write the docs map alone: their deletion of a
			// path tombstones it (getMeta's meta-without-legacy check), and
			// their later re-add of the same path must clear that tombstone
			// — otherwise the stale entry masks the re-created file from
			// every accessor and commit() deletes it outright.
			event.changes.keys.forEach((change, path) => {
				if (change.action !== "delete" && this.deleteSet.has(path)) {
					this.deleteSet.delete(path);
				}
			});
			this.migrateUp();
			this.notifyListeners();
		};
		this.legacyIds.observe(legacyListener);
		this.meta.observe(syncFileObserver);
		this.unsubscribes.push(() => {
			this.legacyIds?.unobserve(legacyListener);
		});
		this.unsubscribes.push(() => {
			this.meta?.unobserve(syncFileObserver);
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
		if (this.deleteSet.has(vpath)) {
			return undefined;
		}

		const meta = this.meta.get(vpath) || this.overlay.get(vpath);
		const legacy = this.legacyIds.has(vpath);

		if (!meta && this.legacyIds.has(vpath)) {
			const guid = this.legacyIds.get(vpath)!;
			this.warn(
				"meta missing but legacy docs entry remains; scheduling meta re-creation",
				vpath,
				guid,
			);
			const newMeta = makeDocumentMeta(guid);
			this.overlay.set(vpath, newMeta);
			return newMeta;
		}

		if (!meta) {
			return undefined;
		}

		if (isDocumentMeta(meta) && !legacy) {
			// Old clients delete documents by removing the docs-map entry
			// only; meta-without-legacy converges that deletion. A re-added
			// entry clears this tombstone through the meta observer.
			this.deleteSet.add(vpath);
			return undefined;
		}
		return meta;
	}

	/**
	 * Get committed file metadata from the shared Y.Map only.
	 * Does not include pending uploads, overlay migration entries, or legacy ids.
	 */
	getCommittedMeta(vpath: string): Meta | undefined {
		this.assertVPath(vpath);
		if (this.deleteSet.has(vpath)) {
			return undefined;
		}
		return this.meta.get(vpath);
	}

	delete(vpath: string) {
		this.assertVPath(vpath);
		// Mirror of set(): removal leaves both maps in one transaction.
		return this.ydoc.transact(() => {
			this.legacyIds.delete(vpath);
			this.pendingUpload.delete(vpath);
			return this.meta.delete(vpath);
		});
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
		const documentPathsById = new Map<
			string,
			{ latest: string; previous?: string }
		>();

		// Index document paths once. A guid can temporarily exist at both its
		// old and new paths, so retain the two latest paths and select the one
		// that differs from the legacy client's path below.
		this.meta.forEach((meta, path) => {
			if (meta.type !== SyncType.Document) return;
			const existing = documentPathsById.get(meta.id);
			documentPathsById.set(meta.id, {
				latest: path,
				previous: existing?.latest,
			});
		});

		this.legacyIds.forEach((guid, newPath) => {
			const documentPaths = documentPathsById.get(guid);
			const oldPath =
				documentPaths?.latest === newPath
					? documentPaths.previous
					: documentPaths?.latest;

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
			const newPath = join(newFolder, relativePath);

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
				console.debug("creating folder path", folderPath, guid);
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
		this.legacyIds = null as unknown as typeof this.legacyIds;
		this.meta = null as unknown as typeof this.meta;
	}
}
