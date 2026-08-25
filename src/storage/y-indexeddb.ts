import * as Y from "yjs";
import * as idb from "lib0/indexeddb";
import { ObservableV2 } from "lib0/observable";
import { metrics, curryLog } from "../debug";
import { OpCapture, type SerializedCapturedOp } from "../merge-hsm/undo";
import type { OpCaptureOptions } from "../merge-hsm/undo/OpCapture";
import type { TimeProvider } from "../TimeProvider";

const idbWarn = curryLog("[IndexeddbPersistence]", "warn");

const customStoreName = "custom";
const updatesStoreName = "updates";
const historyStoreName = "history";
const DB_VERSION = 2;
const DESTROY_DRAIN_TIMEOUT_MS = 2000;
const requiredStores: Array<[string, IDBObjectStoreParameters?]> = [
	[updatesStoreName, { autoIncrement: true }],
	[customStoreName],
	[historyStoreName, { autoIncrement: true }],
];

/** The capture configuration persistence accepts; `map` scopes resolve Y.Map roots. */
export interface PersistenceCaptureOpts extends OpCaptureOptions {
	scope: string | string[];
	scopeType?: "map" | "text";
}

/** Events the persistence emits while loading stored updates. */
export interface PersistenceEvents {
	synced: (persistence: IndexeddbPersistence) => void;
	failed: (error: Error) => void;
}

/** The yjs type family OpCapture scopes over; yjs declares it invariantly. */
type YType = Parameters<Y.Transaction["changed"]["has"]>[0];

/** Settle an IndexedDB request as a promise of its typed result. */
const request = <T>(req: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});

const createMissingStores = (db: IDBDatabase): void => {
	for (const [storeName, options] of requiredStores) {
		if (!db.objectStoreNames.contains(storeName)) {
			if (options) {
				db.createObjectStore(storeName, options);
			} else {
				db.createObjectStore(storeName);
			}
		}
	}
};

const isVersionError = (err: unknown): boolean =>
	err instanceof Error && err.name === "VersionError";

const openDbRequest = (name: string, version: number | undefined): Promise<IDBDatabase> =>
	new Promise((resolve, reject) => {
		let abandoned = false;
		const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
		req.onupgradeneeded = () => {
			createMissingStores(req.result);
		};
		req.onblocked = () => {
			abandoned = true;
			const error = new Error(`indexedDB.open blocked for ${name}`);
			idbWarn(error.message);
			reject(error);
		};
		req.onerror = () => reject(req.error ?? new Error(`indexedDB.open failed for ${name}`));
		req.onsuccess = () => {
			if (abandoned) {
				req.result.close();
				return;
			}
			resolve(req.result);
		};
	});

/**
 * Opens the persistence DB at this release's target version. If the browser
 * reports that the DB is newer than this build, reopen the current version and
 * rely on additive store compatibility.
 */
export const openIndexeddbPersistenceDb = (name: string): Promise<IDBDatabase> =>
	openDbRequest(name, DB_VERSION).catch((err: unknown) => {
		if (!isVersionError(err)) throw err;
		idbWarn(`indexedDB.open(${name}, ${DB_VERSION}) hit VersionError; reopening current version`);
		return openDbRequest(name, undefined);
	});

const uint8ArrayEquals = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
};

/**
 * Validate a Yjs update by applying it to a throwaway doc.
 * Returns null if valid, or the Error if invalid.
 */
const validateUpdate = (update: Uint8Array): Error | null => {
	const doc = new Y.Doc();
	try {
		Y.applyUpdate(doc, update);
		return null;
	} catch (e) {
		return e instanceof Error ? e : new Error(String(e));
	} finally {
		doc.destroy();
	}
};

// Use a higher threshold on startup to avoid slow initial compaction
// After sync, use the lower threshold to keep the database lean
export const STARTUP_TRIM_SIZE = 500;
export const RUNTIME_TRIM_SIZE = 50;

type StoreCallback = (updatesStore: IDBObjectStore) => void;

export const fetchUpdates = (
	idbPersistence: IndexeddbPersistence,
	beforeApplyUpdatesCallback: StoreCallback = () => {},
	afterApplyUpdatesCallback: StoreCallback = () => {},
): Promise<IDBObjectStore> => {
	const [updatesStore] = idb.transact(idbPersistence.db!, [updatesStoreName]);
	return idb
		.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(idbPersistence._dbref, false))
		.then((stored) => {
			const updates = stored as Uint8Array[];
			if (!idbPersistence._destroyed) {
				beforeApplyUpdatesCallback(updatesStore);
				// Validate each update on a throwaway doc BEFORE applying to the real doc.
				// A corrupted update can partially integrate items (advancing the client clock)
				// before throwing. If we catch after the fact, the doc has phantom clock entries
				// that make future remote diffs compute as empty — causing silent data divergence.
				const validUpdates = updates.filter((val) => {
					const err = validateUpdate(val);
					if (!err) return true;
					console.error(
						`[y-indexeddb] Filtering out corrupted update from IDB for ${idbPersistence.name} (${val.byteLength} bytes):`,
						err,
					);
					return false;
				});
				if (validUpdates.length < updates.length) {
					console.error(
						`[y-indexeddb] Filtered ${updates.length - validUpdates.length}/${updates.length} corrupted updates from IDB for ${idbPersistence.name}`,
					);
				}
				Y.transact(
					idbPersistence.doc,
					() => {
						validUpdates.forEach((val) => Y.applyUpdate(idbPersistence.doc, val));
					},
					idbPersistence,
					false,
				);
			}
		})
		.then(() =>
			idb.getLastKey(updatesStore).then((lastKey: unknown) => {
				idbPersistence._dbref = (typeof lastKey === "number" ? lastKey : 0) + 1;
			}),
		)
		.then(() =>
			idb.count(updatesStore).then((cnt) => {
				idbPersistence._dbsize = cnt;
				metrics.setDbSize(idbPersistence.name, cnt);
			}),
		)
		.then(() => {
			if (!idbPersistence._destroyed) {
				afterApplyUpdatesCallback(updatesStore);
			}
			return updatesStore;
		});
};

export const storeState = (
	idbPersistence: IndexeddbPersistence,
	forceStore = true,
): Promise<void> =>
	fetchUpdates(idbPersistence).then((updatesStore) => {
		if (forceStore || idbPersistence._dbsize >= RUNTIME_TRIM_SIZE) {
			const compactedState = Y.encodeStateAsUpdate(idbPersistence.doc);
			const startTime = performance.now();
			// Return the promise chain so callers can await the writes
			return request(updatesStore.add(compactedState))
				.then(() =>
					idb.del(updatesStore, idb.createIDBKeyRangeUpperBound(idbPersistence._dbref, true)),
				)
				.then(() =>
					idb.count(updatesStore).then((cnt) => {
						idbPersistence._dbsize = cnt;
						metrics.setDbSize(idbPersistence.name, cnt);
					}),
				)
				.then(() => {
					const durationSeconds = (performance.now() - startTime) / 1000;
					metrics.recordCompaction(idbPersistence.name, durationSeconds);
				});
		}
	});

export const clearDocument = (name: string): Promise<unknown> => idb.deleteDB(name);

export class IndexeddbPersistence {
	private readonly events = new ObservableV2<PersistenceEvents>();
	doc: Y.Doc;
	name: string;
	timeProvider: TimeProvider;
	_dbref: number;
	_dbsize: number;
	_destroyed: boolean;
	_captureOpts: PersistenceCaptureOpts | null;
	_migrateFromName: string | null;
	db: IDBDatabase | null;
	synced: boolean;
	_syncFailed: boolean;
	_syncError: Error | null;
	_destroyError: Error | null;
	_rejectDbForDestroy: ((reason: Error) => void) | null;
	_rejectWhenSynced: ((reason: Error) => void) | null;
	_destroyPromise: Promise<void> | null;
	_serverSynced: boolean | undefined;
	_origin: "local" | "remote" | undefined;
	/**
	 * OpCapture instance managed by this persistence.
	 * Created during the sync lifecycle if captureOpts is provided.
	 */
	opCapture: OpCapture | null;
	_openDb: Promise<IDBDatabase>;
	_db: Promise<IDBDatabase>;
	whenSynced: Promise<IndexeddbPersistence>;
	/** Timeout in ms until data is merged and persisted in idb. */
	_storeTimeout: number;
	_storeTimeoutId: number | null;
	/** Track pending write operations for proper teardown. */
	_pendingWrites: Set<Promise<unknown>>;
	_compactionRequested: boolean;
	/** Track pending compaction operation for proper teardown. */
	_pendingCompaction: Promise<void> | null;
	_storeUpdate: (update: Uint8Array, origin: unknown) => void;
	private readonly onDocDestroy = () => {
		void this.destroy();
	};

	/**
	 * @param captureOpts OpCapture config (null = no capture); scopeType 'map'
	 * resolves Y.Map roots (folder membership capture)
	 * @param migrateFrom Old DB name to migrate data from (one-time, then deleted)
	 */
	constructor(
		name: string,
		doc: Y.Doc,
		captureOpts: PersistenceCaptureOpts | null = null,
		migrateFrom: string | null = null,
		timeProvider?: TimeProvider,
	) {
		if (!timeProvider) {
			throw new Error("IndexeddbPersistence requires a TimeProvider");
		}
		this.doc = doc;
		this.name = name;
		this.timeProvider = timeProvider;
		this._dbref = 0;
		this._dbsize = 0;
		this._destroyed = false;
		this._captureOpts = captureOpts;
		this._migrateFromName = migrateFrom;
		this.db = null;
		this.synced = false;
		this._syncFailed = false;
		this._syncError = null;
		this._destroyError = null;
		this._rejectDbForDestroy = null;
		this._rejectWhenSynced = null;
		this._destroyPromise = null;
		this._serverSynced = undefined;
		this._origin = undefined;
		this.opCapture = null;
		this._openDb = openIndexeddbPersistenceDb(name);
		this._db = new Promise((resolve, reject) => {
			this._rejectDbForDestroy = reject;
			this._openDb.then(resolve, reject);
		});
		this.whenSynced = new Promise((resolve, reject) => {
			if (this.synced) {
				resolve(this);
				return;
			}
			if (this._syncFailed) {
				reject(this._syncError ?? new Error(`IndexedDB sync failed for ${this.name}`));
				return;
			}
			const onSynced = () => {
				this.off("failed", onFailed);
				this._rejectWhenSynced = null;
				resolve(this);
			};
			const onFailed = (err: Error) => {
				this.off("synced", onSynced);
				this._rejectWhenSynced = null;
				reject(err ?? this._syncError ?? new Error(`IndexedDB sync failed for ${this.name}`));
			};
			this._rejectWhenSynced = (err: Error) => {
				this.off("synced", onSynced);
				this.off("failed", onFailed);
				reject(
					err ??
						new Error(`IndexedDB persistence destroyed before sync completed for ${this.name}`),
				);
			};
			this.on("synced", onSynced);
			this.on("failed", onFailed);
		});
		this.whenSynced.catch(() => {});

		this._db.catch((err: unknown) => {
			this._failSync(err);
		});

		this._db
			.then((db) => {
				this.db = db;

				const migrationDone = this._migrateFromName
					? this._migrateFromOldDb(this._migrateFromName)
					: Promise.resolve();

				return migrationDone.then(() => {
					// Capture pending state before loading from IDB
					let pendingState: Uint8Array | null = null;
					const beforeApplyUpdatesCallback = () => {
						// Capture any in-memory state before loading from IDB
						pendingState = Y.encodeStateAsUpdate(doc);
					};
					const afterApplyUpdatesCallback = (updatesStore: IDBObjectStore) => {
						if (this._destroyed) return;
						// After loading from IDB, check if pending state had anything new
						if (pendingState && pendingState.length > 2) {
							const vectorBeforePending = Y.encodeStateVector(doc);
							Y.applyUpdate(doc, pendingState, this);
							const vectorAfterPending = Y.encodeStateVector(doc);
							const changed = !uint8ArrayEquals(vectorBeforePending, vectorAfterPending);
							// Only write if applying pending state actually changed something
							if (changed) {
								void request(updatesStore.add(pendingState));
							}
						}
						// 'synced' is emitted after capture init (see below)
					};
					fetchUpdates(this, beforeApplyUpdatesCallback, afterApplyUpdatesCallback)
						.then(() => {
							if (this._captureOpts && !this._destroyed) {
								return this._initCapture();
							}
						})
						.then(() => {
							if (!this._destroyed) {
								this.synced = true;
								this.events.emit("synced", [this]);
							}
						})
						.catch((err: unknown) => {
							this._failSync(err);
						});
				});
			})
			.catch((err: unknown) => {
				this._failSync(err);
			});
		this._storeTimeout = 1000;
		this._storeTimeoutId = null;
		this._pendingWrites = new Set();
		this._compactionRequested = false;
		this._pendingCompaction = null;
		this._storeUpdate = (update: Uint8Array, origin: unknown) => {
			if (this.db && origin !== this) {
				const storeErr = validateUpdate(update);
				if (storeErr) {
					console.error(
						`[y-indexeddb] Dropping invalid update for ${this.name} (${update.byteLength} bytes, not persisted):`,
						storeErr,
					);
					return;
				}
				const [updatesStore] = idb.transact(this.db, [updatesStoreName]);
				const writePromise = request(updatesStore.add(update));
				this._trackWrite(writePromise);
				++this._dbsize;
				metrics.setDbSize(this.name, this._dbsize);
				const trimSize = this.synced ? RUNTIME_TRIM_SIZE : STARTUP_TRIM_SIZE;
				if (this._dbsize >= trimSize) {
					this._scheduleCompaction();
				}
			}
		};
		doc.on("update", this._storeUpdate);
		doc.on("destroy", this.onDocDestroy);
	}

	on<Name extends keyof PersistenceEvents>(name: Name, f: PersistenceEvents[Name]): void {
		this.events.on(name, f);
	}

	off<Name extends keyof PersistenceEvents>(name: Name, f: PersistenceEvents[Name]): void {
		this.events.off(name, f);
	}

	/** Subscribe once; an event that already fired is delivered on the next tick. */
	once<Name extends keyof PersistenceEvents>(name: Name, f: PersistenceEvents[Name]): void {
		if (name === "synced" && this.synced) {
			const onSynced = f as PersistenceEvents["synced"];
			// If already synced, call immediately in next tick
			this.timeProvider.setTimeout(() => onSynced(this), 0);
			return;
		}
		if (name === "failed" && this._syncFailed) {
			const onFailed = f as PersistenceEvents["failed"];
			this.timeProvider.setTimeout(
				() => onFailed(this._syncError ?? new Error(`IndexedDB sync failed for ${this.name}`)),
				0,
			);
			return;
		}
		this.events.once(name, f);
	}

	_failSync(err: unknown): void {
		if (this._destroyed || this._syncFailed) return;
		this._syncFailed = true;
		this._syncError = err instanceof Error ? err : new Error(String(err));
		idbWarn(`sync failed for ${this.name}:`, this._syncError);
		this.events.emit("failed", [this._syncError]);
	}

	_trackWrite(p: Promise<unknown>): void {
		this._pendingWrites.add(p);
		p.then(
			() => this._pendingWrites.delete(p),
			() => this._pendingWrites.delete(p),
		);
	}

	_settleOrTimeout(promise: Promise<unknown>): Promise<boolean> {
		return new Promise((resolve) => {
			let finished = false;
			const finish = (settled: boolean) => {
				if (finished) return;
				finished = true;
				this.timeProvider.clearTimeout(timer);
				resolve(settled);
			};
			const timer = this.timeProvider.setTimeout(() => finish(false), DESTROY_DRAIN_TIMEOUT_MS);
			promise.then(
				() => finish(true),
				() => finish(true),
			);
		});
	}

	async _drainPendingWritesForDestroy(): Promise<void> {
		while (this._pendingWrites.size > 0) {
			const pendingWrites = Promise.allSettled(Array.from(this._pendingWrites)).then(() => {});
			const drained = await this._settleOrTimeout(pendingWrites);
			if (!drained) return;
		}
	}

	async _drainCompactionForDestroy(): Promise<void> {
		if (!this._pendingCompaction) return;
		await this._settleOrTimeout(
			this._pendingCompaction.catch((err: unknown) => {
				idbWarn(`compaction failed during destroy for ${this.name}:`, err);
			}),
		);
	}

	_closeDb(db: IDBDatabase): void {
		// lib0/indexeddb.openDB sets `db.onversionchange = () => db.close()`. The
		// arrow function captures the surrounding module's lexical scope. Even
		// after db.close(), Chrome's "Pending activities" tracker keeps the
		// listener registered and pins the V8 context (and every class defined in
		// the plugin module with it) until the listener is cleared. Clearing
		// onversionchange and the other handlers explicitly lets the IDBDatabase
		// graph go away on the next GC cycle.
		db.onversionchange = null;
		db.onerror = null;
		db.onabort = null;
		db.onclose = null;
		db.close();
	}

	/** Load capture entries from the history object store. */
	private async _loadCaptureEntries(): Promise<Array<{ k: number; v: SerializedCapturedOp }>> {
		const db = await this._db;
		const [store] = idb.transact(db, [historyStoreName], "readonly");
		return idb.getAllKeysValues(store);
	}

	/**
	 * Initialize OpCapture from IDB and wire storage hooks.
	 * Called from the constructor's sync chain, AFTER fetchUpdates (so items
	 * exist for keepItem restoration) and BEFORE 'synced' fires.
	 */
	private async _initCapture(): Promise<void> {
		const captureOpts = this._captureOpts;
		if (!captureOpts) return;
		const saved = await this._loadCaptureEntries();
		// scope: string | string[]; scopeType 'map' resolves Y.Map roots
		// (folder membership capture), default resolves a Y.Text root
		// (document content capture).
		const scopeNames = Array.isArray(captureOpts.scope) ? captureOpts.scope : [captureOpts.scope];
		const resolved = scopeNames.map(
			(name) =>
				(captureOpts.scopeType === "map"
					? this.doc.getMap(name)
					: this.doc.getText(name)) as unknown as YType,
		);
		const scope = resolved.length === 1 ? resolved[0] : resolved;

		if (saved.length > 0) {
			this.opCapture = OpCapture.restore(this.doc, scope, { entries: [] }, captureOpts, saved);
		} else {
			this.opCapture = new OpCapture(scope, captureOpts);
		}

		// Wire internal persistence hooks
		this.opCapture._storage = {
			append: (serialized) => {
				const p = this._db.then((db) => {
					const [store] = idb.transact(db, [historyStoreName]);
					return request(store.add(serialized)).then((key) => Number(key));
				});
				this._trackWrite(p);
				return p;
			},
			update: (key, serialized) => {
				const p = this._db.then((db) => {
					const [store] = idb.transact(db, [historyStoreName]);
					return request(store.put(serialized, key)).then(() => undefined);
				});
				this._trackWrite(p);
				return p;
			},
			remove: (keys) => {
				if (keys.length === 0) return Promise.resolve();
				const p = this._db.then((db) => {
					const [store] = idb.transact(db, [historyStoreName]);
					return Promise.all(keys.map((k) => idb.del(store, k))).then(() => undefined);
				});
				this._trackWrite(p);
				return p;
			},
			clear: () => {
				const p = this._db.then((db) => {
					const [store] = idb.transact(db, [historyStoreName]);
					return request(store.clear());
				});
				this._trackWrite(p);
				return p;
			},
		};
	}

	_scheduleCompaction(): void {
		this._compactionRequested = true;
		if (this._destroyed) return;
		if (this._storeTimeoutId !== null) {
			this.timeProvider.clearTimeout(this._storeTimeoutId);
		}
		this._storeTimeoutId = this.timeProvider.setTimeout(() => {
			this._storeTimeoutId = null;
			this._requestCompaction().catch((err: unknown) => {
				idbWarn(`compaction failed for ${this.name}:`, err);
			});
		}, this._storeTimeout);
	}

	_requestCompaction(): Promise<void> {
		if (this._pendingCompaction) return this._pendingCompaction;
		this._pendingCompaction = Promise.resolve()
			.then(async () => {
				if (!this._compactionRequested || this._destroyed || !this.db) return;
				this._compactionRequested = false;
				while (this._pendingWrites.size > 0) {
					await Promise.all(Array.from(this._pendingWrites));
				}
				if (!this._destroyed && this.db && this._dbsize >= RUNTIME_TRIM_SIZE) {
					await storeState(this, false);
				}
			})
			.finally(() => {
				this._pendingCompaction = null;
				if (this._compactionRequested && !this._destroyed) {
					this._scheduleCompaction();
				}
			});
		return this._pendingCompaction;
	}

	destroy(): Promise<void> {
		if (this._destroyPromise) return this._destroyPromise;
		this._destroyPromise = (async () => {
			if (this._storeTimeoutId !== null) {
				this.timeProvider.clearTimeout(this._storeTimeoutId);
				this._storeTimeoutId = null;
			}
			this.doc.off("update", this._storeUpdate);
			this.doc.off("destroy", this.onDocDestroy);
			this._destroyError = new Error(
				`IndexedDB persistence destroyed before sync completed for ${this.name}`,
			);
			this._destroyed = true;
			if (!this.synced && this._rejectWhenSynced) {
				this._rejectWhenSynced(this._destroyError);
				this._rejectWhenSynced = null;
			}
			if (this._rejectDbForDestroy) {
				this._rejectDbForDestroy(this._destroyError);
				this._rejectDbForDestroy = null;
			}
			// Destroy OpCapture (releases keepItem holds, no persistence needed)
			if (this.opCapture) {
				this.opCapture.destroy();
				this.opCapture = null;
			}
			// If indexedDB.open never resolved, `this.db` is null and queued
			// writes/compaction are chained on `_db`. Reject those chains so their
			// callers can unwind, and close the db if the browser eventually opens it.
			if (!this.db) {
				this._openDb
					.then((db) => {
						this._closeDb(db);
					})
					.catch(() => {});
				this._pendingWrites.clear();
				this._pendingCompaction = null;
				this.events.destroy();
				return;
			}

			try {
				await this._drainPendingWritesForDestroy();
				await this._drainCompactionForDestroy();
			} finally {
				this._closeDb(this.db);
				this.db = null;
				this._pendingWrites.clear();
				this._pendingCompaction = null;
				// Clear the lib0/observable _observers map. The whenSynced promise
				// registers an `on('synced', ...)` handler that only removes its sibling
				// `failed` handler when it fires — leaving the synced listener attached
				// for the lifetime of this instance. Each listener is an arrow whose
				// closure captures Document/SharedFolder lexical scope, so a forgotten
				// observer pins the entire plugin module across reload.
				this.events.destroy();
			}
		})();
		return this._destroyPromise;
	}

	async clearDocumentData(): Promise<void> {
		await this.whenSynced;

		if (this._storeTimeoutId !== null) {
			this.timeProvider.clearTimeout(this._storeTimeoutId);
			this._storeTimeoutId = null;
		}
		this._compactionRequested = false;
		while (this._pendingWrites.size > 0) {
			await Promise.all(this._pendingWrites);
		}
		if (this._pendingCompaction) {
			await this._pendingCompaction;
		}
		const db = this.db;
		if (!db) return;

		const storeNames = [updatesStoreName, customStoreName, historyStoreName].filter((storeName) =>
			db.objectStoreNames.contains(storeName),
		);

		if (storeNames.length > 0) {
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(storeNames, "readwrite");
				for (const storeName of storeNames) {
					tx.objectStore(storeName).clear();
				}
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error ?? new Error(`Failed to clear ${this.name}`));
				tx.onabort = () => reject(tx.error ?? new Error(`Aborted clearing ${this.name}`));
			});
		}

		this._dbref = 0;
		this._dbsize = 0;
		this._serverSynced = undefined;
		this._origin = undefined;
	}

	/** Destroys this instance and removes all data from indexeddb. */
	clearData(): Promise<void> {
		return this.destroy().then(() => {
			void idb.deleteDB(this.name);
		});
	}

	get(key: IDBValidKey): Promise<unknown> {
		return this._db.then((db) => {
			const [custom] = idb.transact(db, [customStoreName], "readonly");
			return request(custom.get(key)) as Promise<unknown>;
		});
	}

	set(key: IDBValidKey, value: string | number | ArrayBuffer | Date): Promise<unknown> {
		const writePromise = this._db.then((db) => {
			const [custom] = idb.transact(db, [customStoreName]);
			return request(custom.put(value, key));
		});
		this._trackWrite(writePromise);
		return writePromise;
	}

	del(key: IDBValidKey): Promise<void> {
		const writePromise = this._db.then((db) => {
			const [custom] = idb.transact(db, [customStoreName]);
			return request(custom.delete(key));
		});
		this._trackWrite(writePromise);
		return writePromise;
	}

	/**
	 * Check if this database contains meaningful user data.
	 * Returns true if there are any stored updates in IndexedDB.
	 */
	hasUserData(): boolean {
		return this._dbsize > 0;
	}

	/**
	 * One-time migration: copy raw blobs from an old-named IDB into the new DB.
	 * The old DB is left in place — multiple vaults in the same process may share
	 * the same old DB name and each needs to migrate independently.
	 */
	private _migrateFromOldDb(oldName: string): Promise<void> {
		const db = this.db!;
		// Check if we already migrated (marker in custom store)
		const [customStore] = idb.transact(db, [customStoreName], "readonly");
		return request(customStore.get("migratedFrom")).then((existing: unknown) => {
			if (existing === oldName) return; // already migrated
			return new Promise<void>((resolve) => {
				let finished = false;
				// onupgradeneeded fires iff indexedDB.open had to create a new DB at
				// v1 (i.e. oldName did not previously exist). We use it as a sentinel
				// to distinguish "legacy data present" from "nothing to migrate, and
				// we just auto-created an empty husk we need to clean up".
				let didNotExist = false;
				const done = () => {
					if (finished) return;
					finished = true;
					resolve();
				};
				const markMigrated = () => {
					// Record completion in the new DB so subsequent boots skip this
					// whole path. Failure here is non-fatal — worst case we retry next
					// boot and converge then.
					const [writeStore] = idb.transact(db, [customStoreName]);
					return request(writeStore.put(oldName, "migratedFrom")).catch(() => {});
				};
				const req = indexedDB.open(oldName);
				req.onblocked = () => {
					idbWarn(`migration open blocked for ${oldName}`);
					done();
				};
				req.onerror = () => done();
				req.onupgradeneeded = () => {
					didNotExist = true;
				};
				req.onsuccess = () => {
					const oldDb = req.result;
					if (didNotExist) {
						// We auto-created an empty v1 DB. Drop it and mark migrated so
						// we don't re-enter this branch on every boot. Concurrent peers
						// sharing this oldName will each reach the same conclusion
						// independently; the deleteDatabase attempt races harmlessly.
						oldDb.close();
						const delReq = indexedDB.deleteDatabase(oldName);
						let deleteFinished = false;
						const finish = () => {
							if (deleteFinished) return;
							deleteFinished = true;
							void markMigrated().finally(done);
						};
						delReq.onsuccess = finish;
						delReq.onerror = finish;
						delReq.onblocked = () => {
							idbWarn(`deleteDatabase blocked for ${oldName}`);
							finish();
						};
						return;
					}
					const storeNames = [updatesStoreName, customStoreName, historyStoreName].filter((s) =>
						oldDb.objectStoreNames.contains(s),
					);
					if (storeNames.length === 0) {
						// Old DB exists but has no relevant stores (e.g. a husk from a
						// prior crashed run). Nothing to copy; record completion so we
						// stop probing it.
						oldDb.close();
						void markMigrated().finally(done);
						return;
					}
					// Read all entries from each store in the old DB
					type StoreEntries = { name: string; entries: Array<{ key: IDBValidKey; value: unknown }> };
					const readTx = oldDb.transaction(storeNames, "readonly");
					const reads = storeNames.map((name) => {
						const store = readTx.objectStore(name);
						return new Promise<StoreEntries>((res, rej) => {
							const entries: StoreEntries["entries"] = [];
							const cursor = store.openCursor();
							cursor.onsuccess = () => {
								const c = cursor.result;
								if (c) {
									entries.push({ key: c.key, value: c.value as unknown });
									c.continue();
								} else {
									res({ name, entries });
								}
							};
							cursor.onerror = () => rej(cursor.error ?? new Error(`cursor failed for ${name}`));
						});
					});
					Promise.all(reads)
						.then((stores) => {
							// Write all entries into the new DB, plus migration marker
							const writeStoreNames = [
								customStoreName,
								...stores.filter((s) => s.entries.length > 0).map((s) => s.name),
							];
							const unique = [...new Set(writeStoreNames)];
							const writeTx = db.transaction(unique, "readwrite");
							writeTx.objectStore(customStoreName).put(oldName, "migratedFrom");
							for (const { name, entries } of stores) {
								if (entries.length === 0) continue;
								const dest = writeTx.objectStore(name);
								for (const { key, value } of entries) {
									dest.put(value, key);
								}
							}
							writeTx.oncomplete = () => {
								oldDb.close();
								done();
							};
							writeTx.onerror = () => {
								oldDb.close();
								done();
							};
						})
						.catch(() => {
							oldDb.close();
							done();
						});
				};
			});
		});
	}

	_hasLiveDoc(): boolean {
		return !!this.doc && this.doc.store != null;
	}

	/** Mark this document as synced with the server. */
	async markServerSynced(): Promise<unknown> {
		this._serverSynced = true;
		return this.set("serverSync", 1);
	}

	/** Get server sync status. */
	async getServerSynced(): Promise<boolean> {
		if (this._serverSynced !== undefined) {
			return this._serverSynced;
		}
		const serverSync = await this.get("serverSync");
		this._serverSynced = serverSync === 1;
		return this._serverSynced;
	}

	/** Check if document has been synced with server (synchronous). */
	get hasServerSync(): boolean {
		return this._serverSynced === true;
	}

	/** Set the origin of this document. */
	async setOrigin(origin: "local" | "remote"): Promise<void> {
		this._origin = origin;
		await this.set("origin", origin);
	}

	/** Get the origin of this document. */
	async getOrigin(): Promise<"local" | "remote" | undefined> {
		if (this._origin !== undefined) {
			return this._origin;
		}
		const stored = await this.get("origin");
		this._origin = stored === "local" || stored === "remote" ? stored : undefined;
		return this._origin;
	}

	/**
	 * Initialize document with content if not already initialized.
	 * Checks origin in one IDB session, calls contentLoader only if needed.
	 * @param fieldName Y.Text field name
	 * @returns true if initialization happened, false if already initialized
	 */
	async initializeWithContent(
		contentLoader: () => Promise<{ content: string; hash: string; mtime: number }>,
		fieldName = "contents",
	): Promise<boolean> {
		await this.whenSynced;
		if (this._destroyed || !this._hasLiveDoc()) return false;

		// Check if already enrolled (origin set = previously initialized)
		const existingOrigin = await this.getOrigin();
		if (this._destroyed || !this._hasLiveDoc()) return false;
		if (existingOrigin !== undefined) {
			return false;
		}

		// Also check for user data (belt and suspenders)
		if (this.hasUserData()) {
			return false;
		}

		// Not initialized - load content lazily
		const { content } = await contentLoader();

		// Insert content. The `relay` map carries a single op so every enrolled
		// doc produces a non-empty state vector — lets the server (and peers)
		// tell "uploaded" from "never uploaded" for truly-empty content.
		this.doc.transact(() => {
			const header = this.doc.getMap("relay");
			if (!header.has("v")) header.set("v", 0);
			const ytext = this.doc.getText(fieldName);
			ytext.insert(0, content);
		});

		// Mark origin
		await this.setOrigin("local");
		if (this._destroyed || !this._hasLiveDoc()) return false;

		return true;
	}

	/**
	 * Initialize document from remote CRDT state if not already initialized.
	 * Used for downloaded documents where remoteDoc already has server content.
	 * @param update CRDT update from remoteDoc
	 * @param origin Origin to use for Y.applyUpdate (must differ from `this` so _storeUpdate persists to IDB)
	 * @returns true if initialization happened, false if already initialized
	 */
	async initializeFromRemote(update: Uint8Array, origin: unknown): Promise<boolean> {
		await this.whenSynced;
		if (this._destroyed || !this._hasLiveDoc()) return false;

		// Check if already initialized (origin set = previously initialized)
		const existingOrigin = await this.getOrigin();
		if (this._destroyed || !this._hasLiveDoc()) return false;
		if (existingOrigin !== undefined) {
			return false;
		}

		// Also check for user data (belt and suspenders)
		if (this.hasUserData()) {
			return false;
		}

		// Apply remote CRDT state — origin must differ from `this` so _storeUpdate persists to IDB
		Y.applyUpdate(this.doc, update, origin);

		// Mark origin
		await this.setOrigin("remote");
		if (this._destroyed || !this._hasLiveDoc()) return false;

		return true;
	}

	/** Check if the document is ready for use. */
	isReady(providerSynced = false): boolean {
		return this.synced && (providerSynced || this.hasServerSync || this._origin === "local");
	}

	/** Check if this document is awaiting server updates. */
	async awaitingServerUpdates(): Promise<boolean> {
		const serverSynced = await this.getServerSynced();
		const origin = await this.getOrigin();
		return !serverSynced && origin !== "local" && !this.hasUserData();
	}
}
