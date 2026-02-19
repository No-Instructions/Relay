/**
 * OpCapture — reversible CRDT operation capture.
 *
 * A thin wrapper over Y.js undo internals that captures CRDT operations,
 * stores their origin, and can reverse selected entries on demand. The HSM
 * decides *which* entries to reverse; this component provides the primitives.
 *
 * Ported from yjs/src/utils/UndoManager.js, restructured as a simpler
 * component: no LIFO constraint, no redo stack, no events.
 */

import {
	iterateDeletedStructs,
	keepItem,
	redoItem,
	isParentOf,
	followRedone,
	getItemCleanStart,
	createID,
	isDeleted,
	addToDeleteSet,
	mergeDeleteSets,
	transact,
	DSEncoderV1,
	DSDecoderV1,
	writeDeleteSet,
	readDeleteSet,
	Item,
	GC,
	DeleteSet,
	AbstractType,
	Transaction,
	Doc,
} from "yjs/dist/src/internals";

import * as time from "lib0/time";
import * as decoding from "lib0/decoding";

import type { SerializedCapturedOp, SerializedCaptureState } from "./types";
import { serializeOrigin, deserializeOrigin } from "./origins";

// ---------------------------------------------------------------------------
// CapturedOp
// ---------------------------------------------------------------------------

/**
 * A captured CRDT operation: insertions + deletions from one or more
 * coalesced transactions.
 */
export class CapturedOp {
	readonly insertions: DeleteSet;
	readonly deletions: DeleteSet;
	readonly origin: any;
	readonly timestamp: number;
	readonly meta: Map<any, any>;

	/** IDB key when persisted via _storage. Null for in-memory-only entries. */
	_storeKey: number | null = null;

	/** Resolves to IDB key once the append write completes. */
	_pendingKey: Promise<number> | null = null;

	constructor(
		deletions: DeleteSet,
		insertions: DeleteSet,
		origin: any,
		timestamp: number,
	) {
		this.insertions = insertions;
		this.deletions = deletions;
		this.origin = origin;
		this.timestamp = timestamp;
		this.meta = new Map();
	}
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpCaptureOptions {
	trackedOrigins: Set<any>;
	captureTimeout?: number;
	deleteFilter?: (item: Item) => boolean;
}

// ---------------------------------------------------------------------------
// OpCapture
// ---------------------------------------------------------------------------

/**
 * Releases keepItem holds on a captured entry's deletions within `scope`.
 */
function releaseEntry(
	tr: Transaction,
	scope: AbstractType<any>[],
	entry: CapturedOp,
): void {
	iterateDeletedStructs(tr, entry.deletions, (item: Item | GC) => {
		if (item instanceof Item && scope.some((type) => isParentOf(type, item))) {
			keepItem(item, false);
		}
	});
}

/** Internal persistence hooks set by the storage layer (y-indexeddb). */
export interface OpCaptureStorage {
	append(serialized: SerializedCapturedOp): Promise<number>;
	update(key: number, serialized: SerializedCapturedOp): Promise<void>;
	remove(keys: number[]): Promise<void>;
	clear(): Promise<void>;
}

export class OpCapture {
	readonly entries: CapturedOp[] = [];

	private readonly doc: Doc;
	private readonly scope: AbstractType<any>[];
	private readonly trackedOrigins: Set<any>;
	private readonly captureTimeout: number;
	private readonly deleteFilter: (item: Item) => boolean;
	private lastChange: number = 0;
	private _suppressCapture: boolean = false;
	private readonly afterTransactionHandler: (tr: Transaction) => void;

	/**
	 * Internal persistence hooks. Set by the storage layer (y-indexeddb).
	 * When null (standalone use, tests), OpCapture is purely in-memory.
	 */
	_storage: OpCaptureStorage | null = null;

	constructor(
		typeScope: AbstractType<any> | AbstractType<any>[],
		opts: OpCaptureOptions,
	) {
		const scopeArr = Array.isArray(typeScope) ? typeScope : [typeScope];
		this.scope = scopeArr;
		this.doc = scopeArr[0].doc!;
		this.trackedOrigins = opts.trackedOrigins;
		this.captureTimeout = opts.captureTimeout ?? 0;
		this.deleteFilter = opts.deleteFilter ?? (() => true);

		this.afterTransactionHandler = (transaction: Transaction) => {
			if (this._suppressCapture) return;

			// Origin/scope filtering — same logic as stock UndoManager
			if (
				!this.scope.some((type) =>
					transaction.changedParentTypes.has(type),
				) ||
				(!this.trackedOrigins.has(transaction.origin) &&
					(!transaction.origin ||
						!this.trackedOrigins.has(transaction.origin.constructor)))
			) {
				return;
			}

			// Build insertions DeleteSet from before/after state vectors
			const insertions = new DeleteSet();
			transaction.afterState.forEach((endClock: number, client: number) => {
				const startClock = transaction.beforeState.get(client) || 0;
				const len = endClock - startClock;
				if (len > 0) {
					addToDeleteSet(insertions, client, startClock, len);
				}
			});

			const now = time.getUnixTime();
			const origin = transaction.origin;

			let coalesced = false;

			if (
				this.lastChange > 0 &&
				now - this.lastChange < this.captureTimeout &&
				this.entries.length > 0
			) {
				// Coalesce into last entry
				const lastOp = this.entries[this.entries.length - 1];
				// Only coalesce if same origin
				if (lastOp.origin === origin) {
					// Mutate the existing entry's DeleteSets
					(lastOp as { deletions: DeleteSet }).deletions = mergeDeleteSets([
						lastOp.deletions,
						transaction.deleteSet,
					]);
					(lastOp as { insertions: DeleteSet }).insertions = mergeDeleteSets([
						lastOp.insertions,
						insertions,
					]);
					coalesced = true;
				} else {
					// Different origin — start a new entry
					this.entries.push(
						new CapturedOp(transaction.deleteSet, insertions, origin, now),
					);
				}
			} else {
				this.entries.push(
					new CapturedOp(transaction.deleteSet, insertions, origin, now),
				);
			}

			this.lastChange = now;

			// Prevent GC of deleted items in scope
			iterateDeletedStructs(
				transaction,
				transaction.deleteSet,
				(item: Item | GC) => {
					if (
						item instanceof Item &&
						this.scope.some((type) => isParentOf(type, item))
					) {
						keepItem(item, true);
					}
				},
			);

			// Persist to storage
			if (this._storage) {
				if (coalesced) {
					const lastOp = this.entries[this.entries.length - 1];
					const serialized = this.serializeEntry(lastOp);
					if (lastOp._storeKey !== null) {
						this._storage.update(lastOp._storeKey, serialized);
					} else if (lastOp._pendingKey) {
						// Key not resolved yet — chain the update
						lastOp._pendingKey.then((key) => {
							if (this._storage) {
								this._storage.update(key, serialized);
							}
						});
					}
				} else {
					const entry = this.entries[this.entries.length - 1];
					const serialized = this.serializeEntry(entry);
					const keyPromise = this._storage.append(serialized);
					entry._pendingKey = keyPromise;
					keyPromise.then((key) => {
						entry._storeKey = key;
						entry._pendingKey = null;
					});
				}
			}
		};

		this.doc.on("afterTransaction", this.afterTransactionHandler);
	}

	// -----------------------------------------------------------------------
	// Serialization helpers
	// -----------------------------------------------------------------------

	/** Serialize a single entry for storage. */
	private serializeEntry(entry: CapturedOp): SerializedCapturedOp {
		const insEncoder = new DSEncoderV1();
		writeDeleteSet(insEncoder, entry.insertions);
		const delEncoder = new DSEncoderV1();
		writeDeleteSet(delEncoder, entry.deletions);
		return {
			insertions: insEncoder.toUint8Array(),
			deletions: delEncoder.toUint8Array(),
			origin: serializeOrigin(entry.origin),
			timestamp: entry.timestamp,
		};
	}

	// -----------------------------------------------------------------------
	// Query
	// -----------------------------------------------------------------------

	/** Bookmark the current position in the log. */
	mark(): number {
		return this.entries.length;
	}

	/** All entries captured since a mark. */
	since(mark: number): CapturedOp[] {
		return this.entries.slice(mark);
	}

	/** All entries with a specific origin. */
	byOrigin(origin: any): CapturedOp[] {
		return this.entries.filter((e) => e.origin === origin);
	}

	/** Entries captured since a mark with a specific origin. */
	sinceByOrigin(mark: number, origin: any): CapturedOp[] {
		return this.entries.slice(mark).filter((e) => e.origin === origin);
	}

	// -----------------------------------------------------------------------
	// Mutate
	// -----------------------------------------------------------------------

	/**
	 * Reverse specific entries: apply inverse ops, remove from log, release
	 * GC holds. All work happens in a single Y.js transaction.
	 */
	reverse(entries: CapturedOp[]): void {
		if (entries.length === 0) return;

		const toReverse = new Set(entries);

		// Shim for redoItem's UndoManager parameter — provides the stacks it
		// inspects for map-type conflict resolution. OpCapture only targets
		// array types (YText), so these are never read, but the parameter is
		// required by the function signature.
		const umShim = {
			undoStack: [] as CapturedOp[],
			redoStack: [] as CapturedOp[],
		};

		this._suppressCapture = true;
		try {
			transact(
				this.doc,
				(transaction: Transaction) => {
					const store = this.doc.store;

					// Process in reverse order (most recent first)
					for (let idx = entries.length - 1; idx >= 0; idx--) {
						const entry = entries[idx];

						const itemsToRedo = new Set<Item>();
						const itemsToDelete: Item[] = [];

						// Insertions → items to delete (reverse the insert)
						iterateDeletedStructs(
							transaction,
							entry.insertions,
							(struct: Item | GC) => {
								if (struct instanceof Item) {
									if (struct.redone !== null) {
										let { item, diff } = followRedone(store, struct.id);
										if (diff > 0) {
											item = getItemCleanStart(
												transaction,
												createID(item.id.client, item.id.clock + diff),
											);
										}
										struct = item;
									}
									if (
										!struct.deleted &&
										this.scope.some((type) =>
											isParentOf(type, struct as Item),
										)
									) {
										itemsToDelete.push(struct);
									}
								}
							},
						);

						// Deletions → items to redo (reverse the delete)
						iterateDeletedStructs(
							transaction,
							entry.deletions,
							(struct: Item | GC) => {
								if (
									struct instanceof Item &&
									this.scope.some((type) => isParentOf(type, struct)) &&
									!isDeleted(entry.insertions, struct.id)
								) {
									itemsToRedo.add(struct);
								}
							},
						);

						itemsToRedo.forEach((struct) => {
							redoItem(
								transaction,
								struct,
								itemsToRedo,
								entry.insertions,
								false, // ignoreRemoteMapChanges
								umShim as any,
							);
						});

						// Delete in reverse order so children are deleted before parents
						for (let i = itemsToDelete.length - 1; i >= 0; i--) {
							const item = itemsToDelete[i];
							if (this.deleteFilter(item)) {
								item.delete(transaction);
							}
						}

						// Release GC holds
						releaseEntry(transaction, this.scope, entry);
					}

					// Clear search markers on changed types
					transaction.changed.forEach(
						(subProps: Set<string | null>, type: AbstractType<any>) => {
							if (subProps.has(null) && (type as any)._searchMarker) {
								(type as any)._searchMarker.length = 0;
							}
						},
					);
				},
				this,
			);
		} finally {
			this._suppressCapture = false;
		}

		// Remove reversed entries from the log and collect store keys
		const keysToRemove: number[] = [];
		const pendingKeysToAwait: Promise<number>[] = [];
		for (let i = this.entries.length - 1; i >= 0; i--) {
			if (toReverse.has(this.entries[i])) {
				const entry = this.entries[i];
				if (entry._storeKey !== null) {
					keysToRemove.push(entry._storeKey);
				} else if (entry._pendingKey) {
					pendingKeysToAwait.push(entry._pendingKey);
				}
				this.entries.splice(i, 1);
			}
		}

		if (this._storage) {
			if (keysToRemove.length > 0) {
				this._storage.remove(keysToRemove);
			}
			if (pendingKeysToAwait.length > 0) {
				Promise.all(pendingKeysToAwait).then((keys) => {
					if (this._storage) {
						this._storage.remove(keys);
					}
				});
			}
		}
	}

	/**
	 * Drop entries without reversing: remove from log and release GC holds.
	 * The CRDT state is unchanged — Y.js is free to GC the released items.
	 */
	drop(entries: CapturedOp[]): void {
		if (entries.length === 0) return;

		const toDrop = new Set(entries);

		this.doc.transact((tr) => {
			for (const entry of entries) {
				releaseEntry(tr, this.scope, entry);
			}
		});

		const keysToRemove: number[] = [];
		const pendingKeysToAwait: Promise<number>[] = [];
		for (let i = this.entries.length - 1; i >= 0; i--) {
			if (toDrop.has(this.entries[i])) {
				const entry = this.entries[i];
				if (entry._storeKey !== null) {
					keysToRemove.push(entry._storeKey);
				} else if (entry._pendingKey) {
					pendingKeysToAwait.push(entry._pendingKey);
				}
				this.entries.splice(i, 1);
			}
		}

		if (this._storage) {
			if (keysToRemove.length > 0) {
				this._storage.remove(keysToRemove);
			}
			if (pendingKeysToAwait.length > 0) {
				Promise.all(pendingKeysToAwait).then((keys) => {
					if (this._storage) {
						this._storage.remove(keys);
					}
				});
			}
		}
	}

	/** Drop all entries older than a timestamp. */
	dropBefore(timestamp: number): void {
		const old = this.entries.filter((e) => e.timestamp < timestamp);
		if (old.length > 0) {
			this.drop(old);
		}
	}

	/** Stop coalescing — next capture starts a new entry. */
	stopCapturing(): void {
		this.lastChange = 0;
	}

	/** Clear all entries, releasing GC holds. */
	clear(): void {
		if (this.entries.length === 0) return;

		this.doc.transact((tr) => {
			for (const entry of this.entries) {
				releaseEntry(tr, this.scope, entry);
			}
		});

		this.entries.length = 0;

		this._storage?.clear();
	}

	// -----------------------------------------------------------------------
	// Persistence
	// -----------------------------------------------------------------------

	/** Serialize all entries for persistence. */
	serialize(): SerializedCaptureState {
		return {
			entries: this.entries.map((entry) => this.serializeEntry(entry)),
		};
	}

	/**
	 * Restore a previously serialized capture state. Re-establishes keepItem
	 * holds on all deletions (the keep flag is not persisted in Y.js update
	 * encoding).
	 *
	 * When `savedEntries` is provided (from IDB getAllKeysValues), entries are
	 * restored with their IDB keys so subsequent mutations can update/remove
	 * them in place. Otherwise falls back to `state.entries`.
	 */
	static restore(
		doc: Doc,
		typeScope: AbstractType<any> | AbstractType<any>[],
		state: SerializedCaptureState,
		opts: OpCaptureOptions,
		savedEntries?: Array<{ k: number; v: SerializedCapturedOp }>,
	): OpCapture {
		const capture = new OpCapture(typeScope, opts);
		const scopeArr = Array.isArray(typeScope) ? typeScope : [typeScope];

		const items: Array<{ serialized: SerializedCapturedOp; storeKey: number | null }> =
			savedEntries
				? savedEntries.map((e) => ({ serialized: e.v, storeKey: e.k }))
				: state.entries.map((e) => ({ serialized: e, storeKey: null }));

		doc.transact((tr) => {
			for (const { serialized, storeKey } of items) {
				const insDecoder = new DSDecoderV1(
					decoding.createDecoder(serialized.insertions),
				);
				const insertions = readDeleteSet(insDecoder);

				const delDecoder = new DSDecoderV1(
					decoding.createDecoder(serialized.deletions),
				);
				const deletions = readDeleteSet(delDecoder);

				const entry = new CapturedOp(
					deletions,
					insertions,
					deserializeOrigin(serialized.origin),
					serialized.timestamp,
				);
				entry._storeKey = storeKey;
				capture.entries.push(entry);

				// Re-establish keepItem holds
				iterateDeletedStructs(tr, deletions, (item: Item | GC) => {
					if (
						item instanceof Item &&
						scopeArr.some((type) => isParentOf(type, item))
					) {
						keepItem(item, true);
					}
				});
			}
		});

		return capture;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/** Detach from doc, release all GC holds, clean up. */
	destroy(): void {
		this.clear();
		this.doc.off("afterTransaction", this.afterTransactionHandler);
	}
}
