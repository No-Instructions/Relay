/**
 * FolderHSM IndexedDB Persistence
 *
 * Database: {appId}-folder-hsm
 * Stores:
 *   - states: one row per shared folder (PersistedFolderState), keyed by
 *     the folder guid.
 *
 * The row persists exactly the fork-class subset of the engine's state:
 *
 * - `fork` — the withheld local deletion divergence pending explicit
 *   resolution (the intent half): the held burst's deletions with the
 *   identity each observed at decision time, so resolution replays a
 *   deletion only while its target is still the thing it decided about;
 * - `retained` — the deferred-teardown ledger (the content half): the
 *   entries that keep deleted documents' local data restorable until
 *   they expire. It sits at row level, not inside the fork, because it
 *   serves every deletion's undo (single deletes included), not only
 *   gated bursts.
 *
 * Nothing else persists: the entry table is in-memory authority, rebuilt
 * at every boot by classification. Writes flow only through the folder
 * machine's PERSIST_STATE effect (plus the one-time migration of the
 * legacy custom-store keys); retirement is bound to the folder's
 * lifecycle — unsharing the folder removes the row.
 */

import * as idb from "lib0/indexeddb";
import { DestroyedError, isDestroyedError } from "../../DestroyedError";

// =============================================================================
// Database Configuration
// =============================================================================

const getDbName = (appId: string) => `${appId}-folder-hsm`;

const STORES = {
	states: "states",
} as const;

const DESTROY_DRAIN_TIMEOUT_MS = 2000;

export const PERSISTED_FOLDER_STATE_VERSION = 1;

// =============================================================================
// Row schema
// =============================================================================

export interface FolderForkDelete {
	mapName: string;
	key: string;
	/**
	 * The identity observed at decision time. Resolution replays the
	 * deletion only while the committed value still carries it; a
	 * mismatch surfaces instead of destroying. Absent only on rows
	 * migrated from the legacy format, which recorded no identity.
	 */
	guid?: string;
}

/** The withheld deletion divergence pending explicit resolution. */
export interface FolderFork {
	deletes: FolderForkDelete[];
	origin: "bulk-delete" | "root-detach";
	created: number;
	captureMark?: number;
}

/** One deleted document whose local data is retained for undo. */
export interface RetainedDoc {
	guid: string;
	/** Path at deletion time, for restore placement. */
	path: string;
	expiresAt: number;
}

/**
 * A cache of the provider-side folder doc, written at natural sync
 * moments (handshake complete, drain) — never streamed per-update.
 * Bounded staleness is acceptable: it is server-owned state, and loss
 * only costs a fuller resync. The provider doc boots from it when
 * present, from empty when absent.
 */
export interface RemoteIndexCache {
	snapshot: Uint8Array;
	stateVector: Uint8Array;
	/** When the picture was taken. */
	updated: number;
}

export interface PersistedFolderState {
	/** The folder guid — the row key. */
	guid: string;
	version: number;
	fork: FolderFork | null;
	retained: RetainedDoc[];
	remoteIndex: RemoteIndexCache | null;
}

/**
 * Allow-list every field so nothing beyond the approved subset (and no
 * non-serializable value) reaches IDB's structured clone algorithm.
 */
export function sanitizeFolderState(
	state: PersistedFolderState,
): PersistedFolderState {
	return {
		guid: state.guid,
		version: PERSISTED_FOLDER_STATE_VERSION,
		fork: state.fork
			? {
					deletes: state.fork.deletes.map((deleted) => ({
						mapName: deleted.mapName,
						key: deleted.key,
						...(deleted.guid !== undefined
							? { guid: deleted.guid }
							: {}),
					})),
					origin: state.fork.origin,
					created: state.fork.created,
					...(state.fork.captureMark !== undefined
						? { captureMark: state.fork.captureMark }
						: {}),
				}
			: null,
		retained: (state.retained ?? []).map((doc) => ({
			guid: doc.guid,
			path: doc.path,
			expiresAt: doc.expiresAt,
		})),
		remoteIndex: state.remoteIndex
			? {
					snapshot: state.remoteIndex.snapshot,
					stateVector: state.remoteIndex.stateVector,
					updated: state.remoteIndex.updated,
				}
			: null,
	};
}

// =============================================================================
// FolderHSMStore
// =============================================================================

/**
 * Persistence layer for the folder membership engine's fork-class state.
 * Holds a single IDB connection and tracks pending writes so callers can
 * flush before teardown.
 */
export class FolderHSMStore {
	private _openDb: Promise<IDBDatabase>;
	private _db: Promise<IDBDatabase>;
	private _dbInstance: IDBDatabase | null = null;
	private _pendingWrites = new Set<Promise<unknown>>();
	private _destroyed = false;
	private _dbClosed = false;
	private _destroyPromise: Promise<void> | null = null;
	private _rejectDbForDestroy?: (reason?: unknown) => void;

	constructor(appId: string) {
		this._openDb = idb
			.openDB(getDbName(appId), (db) => {
				idb.createStores(db, [[STORES.states, { keyPath: "guid" }]]);
			})
			.then((db) => {
				this._dbInstance = db;
				if (this._destroyed) {
					this._closeDb(db);
					this._dbInstance = null;
				}
				return db;
			});

		this._db = new Promise((resolve, reject) => {
			this._rejectDbForDestroy = reject;
			this._openDb.then(resolve, reject);
		});
		void this._db.catch(() => {});
	}

	async saveState(guid: string, state: PersistedFolderState): Promise<void> {
		if (this._destroyed) return;
		const sanitized = sanitizeFolderState({ ...state, guid });
		const p = this._db
			.then((db) => {
				if (this._dbClosed) return;
				const [store] = idb.transact(db, [STORES.states], "readwrite");
				return idb.put(store, sanitized as unknown as string);
			})
			.catch((err) => {
				if (this._shouldIgnoreClosingError(err)) return;
				throw err;
			});
		this._trackWrite(p);
		await p;
	}

	async loadState(guid: string): Promise<PersistedFolderState | null> {
		return this._read<PersistedFolderState | null>(null, async (db) => {
			const [store] = idb.transact(db, [STORES.states], "readonly");
			const result = await idb.get(store, guid);
			return (result as unknown as PersistedFolderState) ?? null;
		});
	}

	async deleteState(guid: string): Promise<void> {
		if (this._destroyed) return;
		const p = this._db
			.then((db) => {
				if (this._dbClosed) return;
				const [store] = idb.transact(db, [STORES.states], "readwrite");
				return idb.del(store, guid);
			})
			.catch((err) => {
				if (this._shouldIgnoreClosingError(err)) return;
				throw err;
			});
		this._trackWrite(p);
		await p;
	}

	// ===========================================================================
	// Lifecycle
	// ===========================================================================

	/** Wait for all in-flight writes to complete. */
	async flush(): Promise<void> {
		if (this._pendingWrites.size > 0) {
			await Promise.allSettled([...this._pendingWrites]);
		}
	}

	/** Flush pending writes and close the database connection. */
	async destroy(): Promise<void> {
		if (this._destroyPromise) return this._destroyPromise;
		this._destroyPromise = (async () => {
			this._destroyed = true;
			this._rejectDbForDestroy?.(
				new DestroyedError(
					"FolderHSMStore",
					"destroyed before IndexedDB settled",
				),
			);
			this._rejectDbForDestroy = undefined;

			const db = this._dbInstance;
			if (!db) {
				this._pendingWrites.clear();
				return;
			}

			try {
				await this._drainPendingWritesForDestroy();
			} finally {
				this._dbClosed = true;
				this._closeDb(db);
				this._dbInstance = null;
				this._pendingWrites.clear();
			}
		})();
		return this._destroyPromise;
	}

	// ===========================================================================
	// Internals
	// ===========================================================================

	private async _read<T>(
		fallback: T,
		fn: (db: IDBDatabase) => Promise<T>,
	): Promise<T> {
		try {
			const db = await this._db;
			return await fn(db);
		} catch (err) {
			if (this._shouldIgnoreClosingError(err)) return fallback;
			throw err;
		}
	}

	private _trackWrite(p: Promise<unknown>): void {
		this._pendingWrites.add(p);
		void p.then(
			() => this._pendingWrites.delete(p),
			() => this._pendingWrites.delete(p),
		);
	}

	private async _drainPendingWritesForDestroy(): Promise<void> {
		while (this._pendingWrites.size > 0) {
			const pendingWrites = Promise.allSettled([
				...this._pendingWrites,
			]).then(() => undefined);
			const drained = await this._settleOrTimeout(pendingWrites);
			if (!drained) return;
		}
	}

	private _settleOrTimeout(promise: Promise<void>): Promise<boolean> {
		return new Promise((resolve) => {
			let finished = false;
			const finish = (settled: boolean) => {
				if (finished) return;
				finished = true;
				globalThis.clearTimeout(timer);
				resolve(settled);
			};
			const timer = globalThis.setTimeout(
				() => finish(false),
				DESTROY_DRAIN_TIMEOUT_MS,
			);
			promise.then(
				() => finish(true),
				() => finish(true),
			);
		});
	}

	private _closeDb(db: IDBDatabase): void {
		// lib0/indexeddb.openDB installs `db.onversionchange = () =>
		// db.close()`; leaving the handler attached after close() pins the
		// module's lexical scope until the browser fully releases the
		// connection, which races plugin reload. Clear the IDL handlers so
		// the wrapper can be collected.
		(db as IDBDatabase & { onversionchange: unknown }).onversionchange =
			null;
		(db as IDBDatabase & { onerror: unknown }).onerror = null;
		(db as IDBDatabase & { onabort: unknown }).onabort = null;
		(db as IDBDatabase & { onclose: unknown }).onclose = null;
		db.close();
	}

	private _shouldIgnoreClosingError(err: unknown): boolean {
		if (isDestroyedError(err)) return true;
		if (!this._destroyed) return false;
		if (!(err instanceof DOMException)) return false;
		return err.name === "InvalidStateError";
	}
}

/**
 * Delete the entire database (vault-level cleanup).
 */
export async function deleteFolderHSMDatabase(appId: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(getDbName(appId));
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
}
