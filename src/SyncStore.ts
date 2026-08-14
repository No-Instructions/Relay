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
 * is a move. This extends the
 * folder-move pairing that processFolderOperation has always done to files —
 * a paired move is structurally incapable of being misread as
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
	private committedMeta: Y.Map<Meta>;
	private committedLegacyIds: Y.Map<string>;
	overlay: Map<string, Meta>;
	deleteSet: Set<string>;
	typeRegistry: TypeRegistry;
	renames: Map<string, string>;
	/**
	 * The device's staged claims — un-flushed captured claim ops on the
	 * local document's maps. Null on a store constructed without a host
	 * ledger, where the only claims are pending-upload holds.
	 *
	 * `pendingUpload` itself is a draining migration namespace: sessions
	 * predating capture staging recorded claims there, those entries flow
	 * through the same reconciliation, and nothing writes new ones.
	 */
	stagedClaims: ((path: string) => boolean) | null = null;
	/**
	 * Keys whose local deletions are held at the bridge. Their rows remain
	 * committed membership until the burst resolves, so the boot baseline
	 * counts them even though the local maps carry their tombstones.
	 */
	heldDeletionPaths: (() => Set<string>) | null = null;
	/**
	 * A staged claim is moving paths. The plain committed-entry move would
	 * rewrite the map outside the claim origin — an uncaptured, flushable
	 * write for content that never uploaded — so the host re-stages the
	 * claim at the new key instead.
	 */
	moveClaim: ((oldVPath: string, newVPath: string) => void) | null = null;

	constructor(
		public ydoc: Y.Doc,
		private namespace: string,
		public pendingUpload: Map<string, string>,
		private syncSettingsManager: SyncSettingsManager,
		committedDoc?: Y.Doc,
	) {
		super();
		this.legacyIds = this.ydoc.getMap("docs");
		this.meta = this.ydoc.getMap("filemeta_v0");
		// Committed reads answer from the server's realm. With one blended
		// document (no committedDoc) these are the same map objects and
		// every accessor behaves as it always has; with split realms the
		// committed accessors read the remote document, so the blended-view
		// hazard — asking "is this committed" of a map local staging is
		// also writing — cannot be expressed.
		this.committedMeta = (committedDoc ?? this.ydoc).getMap("filemeta_v0");
		this.committedLegacyIds = (committedDoc ?? this.ydoc).getMap("docs");
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
		if (this.moveClaim && this.stagedClaims?.(oldVPath)) {
			this.moveClaim(oldVPath, newVPath);
			return;
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
		this.log("minted identity", vpath, guid);
		return guid;
	}

	/**
	 * Stage a minted claim into the local maps under the claim origin, in
	 * its own transaction so the capture records it granular — one entry,
	 * one fate. The captured entry is the claim's record: identity is read
	 * back from it, and the bridge holds the write until the publication
	 * decision flushes it. Callers stage one path per call; batching would
	 * merge entries with different fates into one uncancellable unit.
	 */
	stageClaim(vpath: string, meta: Meta, origin: unknown): void {
		this.assertVPath(vpath);
		this.ydoc.transact(() => {
			this.meta.set(vpath, meta);
			if (isDocumentMeta(meta)) {
				this.legacyIds.set(vpath, meta.id);
			}
		}, origin);
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

	/**
	 * Document and canvas guids the device's own records enroll in this
	 * folder. Scoping reads local knowledge — it must answer offline, and
	 * a record for membership the device holds belongs to the folder
	 * whether or not the server has confirmed it this session.
	 */
	getCommittedSubdocGuids(): string[] {
		const guids = new Set<string>();
		this.meta.forEach((value, path) => {
			if (this.deleteSet.has(path)) return;
			if (isDocumentMeta(value) || isCanvasMeta(value)) {
				guids.add(value.id);
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
	 * the legacy map, or the migration overlay. `has()` is exactly
	 * `hasKnown() || hasClaim()` — the blended answer, split so realm
	 * classification can ask about the remote realm without the device's
	 * pending claims vouching for themselves.
	 */
	hasKnown(path: string): boolean {
		if (this.renames.has(path)) {
			path = this.renames.get(path)!;
		}
		if (this.deleteSet.has(path)) {
			return false;
		}
		// Staged claims sit in the local maps too. They may answer "known"
		// here: classification asks about claims first, and the two
		// decision sites that must never let a claim vouch for itself —
		// the boot baseline and the crossing's deletion probe — subtract
		// claims explicitly.
		return (
			this.meta.has(path) ||
			this.legacyIds.has(path) ||
			this.overlay.has(path)
		);
	}

	/** The device holds unpublished identity for this path. */
	hasClaim(path: string): boolean {
		if (this.renames.has(path)) {
			path = this.renames.get(path)!;
		}
		if (this.deleteSet.has(path)) {
			return false;
		}
		return this.pendingUpload.has(path) || (this.stagedClaims?.(path) ?? false);
	}

	/**
	 * Every path the device's records hold committed membership for: the
	 * local maps minus staged claims, plus keys whose local deletions are
	 * held at the bridge — their rows stay committed until the burst
	 * resolves. The boot baseline is taken from exactly this set at replay
	 * completion, before any traffic can move it; the claims subtraction
	 * is the baseline's purity (a claim that never published is absent
	 * from the server's view for the innocent reason that it never
	 * reached it). The migration overlay is excluded — the baseline holds
	 * membership only.
	 */
	committedPaths(): Set<string> {
		const paths = new Set<string>();
		this.meta.forEach((_meta, path) => {
			if (!this.stagedClaims?.(path)) paths.add(path);
		});
		this.legacyIds.forEach((_guid, path) => {
			if (!this.stagedClaims?.(path)) paths.add(path);
		});
		for (const path of this.heldDeletionPaths?.() ?? []) {
			paths.add(path);
		}
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
			// The hold settles whether or not the map needs a write: a staged
			// claim already carries this exact meta, so publication over it
			// is a no-op write whose hold must still clear.
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
				// String() explicitly: a Symbol origin throws in a template
				// literal's implicit conversion.
				log += `Transaction origin: ${String(event.transaction.origin)}${event.transaction.origin?.constructor?.name}\n`;
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

		const syncFileObserver = async (event: Y.YMapEvent<Meta>) => {
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

			this.processFolderOperation(event);
			// Compute a delta only when at least one consumer is installed;
			// otherwise the legacy path above is the only logic that runs.
			if (this.onMapDelta || this.mapDeltaSubscribers.size > 0) {
				const delta = extractMapDelta(event, this.meta);
				this.onMapDelta?.(delta, origin);
				this.mapDeltaSubscribers.forEach((listener) => listener(delta, origin));
			}
			this.notifyListeners();
		};
		const legacyListener = async (event: Y.YMapEvent<string>) => {
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
	 * Get committed file metadata from the committed realm only.
	 * Does not include pending uploads, staged claims, overlay migration
	 * entries, or legacy ids.
	 */
	getCommittedMeta(vpath: string): Meta | undefined {
		this.assertVPath(vpath);
		if (this.renames.has(vpath)) {
			vpath = this.renames.get(vpath)!;
		}
		if (
			this.deleteSet.has(vpath) ||
			(this.heldDeletionPaths?.().has(vpath) ?? false)
		) {
			return undefined;
		}
		return this.committedMeta.get(vpath);
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
		this.renames.clear();
		this.legacyIds = null as any;
		this.meta = null as any;
	}
}
