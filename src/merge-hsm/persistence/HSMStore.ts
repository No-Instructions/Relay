/**
 * MergeHSM IndexedDB Persistence
 *
 * Database: {appId}-relay-hsm
 * Stores:
 *   - states: HSM state per document (PersistedMergeState) and per canvas
 *     (PersistedCanvasState, discriminated by kind: "canvas")
 *
 * NOTE: Yjs updates are stored in y-indexeddb (per-document databases),
 * NOT in this database. Persistence writes to IDB automatically
 * via the _storeUpdate handler on localDoc.
 */

import * as idb from 'lib0/indexeddb';
import type {
  PersistedCanvasState,
  PersistedHSMRecord,
  PersistedMergeState,
  PersistedStateMeta,
} from '../types';
import { DestroyedError, isDestroyedError } from '../../DestroyedError';
import { StateMetaIndex, stateMeta } from './StateMetaIndex';

// =============================================================================
// Database Configuration
// =============================================================================

const getDbName = (appId: string) => `${appId}-relay-hsm`;

const STORES = {
  states: 'states',
} as const;

const DESTROY_DRAIN_TIMEOUT_MS = 2000;

// =============================================================================
// Serialization Helpers
// =============================================================================

/**
 * Allow-list a canvas record's fields. Canvas records carry no fork,
 * snapshots, or deferred conflict — only the LCA contents and disk
 * metadata the CanvasHSM decides with.
 */
function sanitizeCanvasState(state: PersistedCanvasState): PersistedCanvasState {
  return {
    kind: 'canvas',
    guid: state.guid,
    path: state.path,
    folder: state.folder,
    lca: state.lca
      ? {
          contents: state.lca.contents,
          hash: state.lca.hash,
          mtime: state.lca.mtime,
        }
      : null,
    disk: state.disk
      ? { hash: state.disk.hash, mtime: state.disk.mtime }
      : null,
    localSnapshot: state.localSnapshot ?? null,
    lastStatePath: state.lastStatePath,
    persistedAt: state.persistedAt,
  };
}

/**
 * Allow-list all fields to prevent non-serializable values (closures, DOM refs)
 * from reaching IDB's structured clone algorithm.
 */
export function sanitizeState(state: PersistedHSMRecord): PersistedHSMRecord {
  if (state.kind === 'canvas') return sanitizeCanvasState(state);
  return sanitizeMergeState(state);
}

function sanitizeMergeState(state: PersistedMergeState): PersistedMergeState {
  const forkLocalSnapshot = state.fork?.localSnapshot ?? null;
  const forkRemoteSnapshot = state.fork?.remoteSnapshot ?? null;

  return {
    guid: state.guid,
    path: state.path,
    ...(state.folder ? { folder: state.folder } : {}),
    lca: state.lca
      ? {
          contents: state.lca.contents,
          hash: state.lca.hash,
          mtime: state.lca.mtime,
          ...(state.lca.snapshot ? { snapshot: state.lca.snapshot } : {}),
        }
      : null,
    disk: state.disk
      ? { hash: state.disk.hash, mtime: state.disk.mtime }
      : null,
    localSnapshot: state.localSnapshot ?? null,
    lastStatePath: state.lastStatePath,
    deferredConflict: state.deferredConflict
      ? { diskHash: state.deferredConflict.diskHash, localHash: state.deferredConflict.localHash }
      : undefined,
    fork: state.fork
      ? {
          base: state.fork.base,
          ...(forkLocalSnapshot ? { localSnapshot: forkLocalSnapshot } : {}),
          ...(forkRemoteSnapshot ? { remoteSnapshot: forkRemoteSnapshot } : {}),
          origin: state.fork.origin,
          created: state.fork.created,
          captureMark: state.fork.captureMark,
        }
      : null,
    persistedAt: state.persistedAt,
  };
}

// =============================================================================
// HSMStore
// =============================================================================

/**
 * Long-lived persistence layer for HSM state.
 *
 * Holds a single IDB connection for the vault and tracks pending writes
 * so callers can flush before teardown. Created once per vault in the
 * plugin and shared across SharedFolders. Metadata is indexed once per store
 * lifetime and kept current by committed writes, without retaining note bodies.
 */
export class HSMStore {
  private _openDb: Promise<IDBDatabase>;
  private _db: Promise<IDBDatabase>;
  private _dbInstance: IDBDatabase | null = null;
  private _pendingWrites = new Set<Promise<unknown>>();
  private _stateMeta: StateMetaIndex | null = null;
  private _stateMetaLoad: Promise<StateMetaIndex> | null = null;
  private _cancelStateMetaLoad: (() => void) | null = null;
  private _destroyed = false;
  private _dbClosed = false;
  private _destroyPromise: Promise<void> | null = null;
  private _destroyError: Error | null = null;
  private _rejectDbForDestroy?: (reason?: unknown) => void;

  constructor(appId: string) {
    this._openDb = idb
      .openDB(getDbName(appId), (db) => {
        idb.createStores(db, [
          [STORES.states, { keyPath: 'guid' }],
        ]);
      })
      .then(db => {
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

  // ===========================================================================
  // Document-scoped operations (states store)
  // ===========================================================================

  async saveState(guid: string, state: PersistedHSMRecord): Promise<void> {
    if (this._destroyed) return;
    const sanitized = sanitizeState({ ...state, guid });
    const p = this._db
      .then(db => {
        if (this._dbClosed) return;
        const meta = this._stateMeta || this._stateMetaLoad
          ? structuredClone(stateMeta(sanitized))
          : null;
        return this._write(db, store => { store.put(sanitized); }, index => {
          if (meta) index.set(meta);
        });
      })
      .catch(err => {
        if (this._shouldIgnoreClosingError(err)) return;
        throw err;
      });
    this._trackWrite(p);
    await p;
  }

  async loadState(guid: string): Promise<PersistedHSMRecord | null> {
    return this._read<PersistedHSMRecord | null>(null, async db => {
      const [store] = idb.transact(db, [STORES.states], 'readonly');
      const result = await idb.get(store, guid);
      return (result as unknown as PersistedHSMRecord) ?? null;
    });
  }

  async deleteState(guid: string): Promise<void> {
    if (this._destroyed) return;
    const p = this._db
      .then(db => {
        if (this._dbClosed) return;
        return this._write(db, store => { store.delete(guid); }, index => index.delete(guid));
      })
      .catch(err => {
        if (this._shouldIgnoreClosingError(err)) return;
        throw err;
      });
    this._trackWrite(p);
    await p;
  }

  async getAllStateGuids(): Promise<string[]> {
    return this._read<string[]>([], async db => {
      const [store] = idb.transact(db, [STORES.states], 'readonly');
      const keys = await idb.getAllKeys(store);
      return keys as string[];
    });
  }

  async getAllStates(): Promise<PersistedHSMRecord[]> {
    return this._read<PersistedHSMRecord[]>([], async db => {
      const [store] = idb.transact(db, [STORES.states], 'readonly');
      const states = (await idb.getAll(store)) as PersistedHSMRecord[] | undefined;
      return states ?? [];
    });
  }

  async getAllStateMeta(): Promise<PersistedStateMeta[]> {
    return (await this._getStateMeta()).all();
  }

  /**
   * Read only this folder's metadata. Unstamped records are included when their
   * guid belongs to the folder's committed membership, sampled after loading.
   */
  async getFolderStateMeta(
    folder: string,
    getMemberGuids: () => Iterable<string> = () => [],
  ): Promise<PersistedStateMeta[]> {
    const index = await this._getStateMeta();
    if (this._destroyed) return [];
    return index.forFolder(folder, getMemberGuids());
  }

  private async _getStateMeta(): Promise<StateMetaIndex> {
    // Match an IndexedDB read's ordering with writes already requested by the
    // caller, including writes whose transaction has not opened yet.
    if (this._pendingWrites.size > 0) {
      await Promise.allSettled([...this._pendingWrites]);
    }
    if (this._destroyed) return new StateMetaIndex();
    if (this._stateMeta) return this._stateMeta;
    if (!this._stateMetaLoad) {
      this._stateMetaLoad = this._read(new StateMetaIndex(), db => this._collectStateMeta(db))
        .then(index => {
          if (this._destroyed) return new StateMetaIndex();
          this._stateMeta = index;
          return index;
        })
        .finally(() => {
          this._stateMetaLoad = null;
        });
    }
    return this._stateMetaLoad;
  }

  private _collectStateMeta(db: IDBDatabase): Promise<StateMetaIndex> {
    if (this._destroyed) return Promise.resolve(new StateMetaIndex());
    const [store] = idb.transact(db, [STORES.states], 'readonly');
    const transaction = store.transaction;
    const index = new StateMetaIndex();
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      let settled = false;
      const detach = () => {
        req.onsuccess = null;
        req.onerror = null;
        transaction.oncomplete = null;
        transaction.onabort = null;
        if (this._cancelStateMetaLoad === cancel) this._cancelStateMetaLoad = null;
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        detach();
        index.clear();
        reject(error);
      };
      const cancel = () => {
        if (settled) return;
        fail(this._destroyError ?? new DestroyedError('HSMStore', 'metadata scan cancelled'));
        try {
          transaction.abort();
        } catch {
          // A finished transaction cannot be aborted; its handlers are already detached.
        }
      };
      this._cancelStateMetaLoad = cancel;
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        detach();
        resolve(index);
      };
      transaction.onabort = () => fail(transaction.error ?? new Error('Metadata read aborted'));
      req.onsuccess = () => {
        if (this._destroyed) { cancel(); return; }
        const cursor = req.result;
        if (!cursor) return;
        index.set(stateMeta(cursor.value as PersistedHSMRecord));
        cursor.continue();
      };
      req.onerror = () => fail(req.error ?? new Error('Metadata cursor failed'));
    });
  }

  // ===========================================================================
  // Unscoped operations
  // ===========================================================================

  async clearAllData(): Promise<void> {
    if (this._destroyed) return;
    const p = this._db
      .then(db => {
        if (this._dbClosed) return;
        return this._write(db, store => { store.clear(); }, index => index.clear());
      })
      .catch(err => {
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
      this._destroyError = new DestroyedError('HSMStore', 'destroyed before IndexedDB settled');
      this._destroyed = true;
      this._cancelStateMetaLoad?.();
      this._stateMeta?.clear();
      this._stateMeta = null;
      this._rejectDbForDestroy?.(this._destroyError);
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

  /**
   * Run a read against the open connection. A read racing teardown resolves to
   * `fallback` rather than surfacing the destroy sentinel (or an
   * already-closing connection's error) to the caller.
   */
  private async _read<T>(fallback: T, fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    try {
      const db = await this._db;
      return await fn(db);
    } catch (err) {
      if (this._shouldIgnoreClosingError(err)) return fallback;
      throw err;
    }
  }

  /** Update the in-memory projection only after the transaction commits. */
  private _write(
    db: IDBDatabase,
    write: (store: IDBObjectStore) => void,
    update: (index: StateMetaIndex) => void,
  ): Promise<void> {
    const [store] = idb.transact(db, [STORES.states], 'readwrite');
    return new Promise((resolve, reject) => {
      write(store);
      store.transaction.oncomplete = () => {
        // Transactions on this store are ordered: writes preceding the first
        // read are included in its cursor; later commits update its index.
        if (!this._destroyed && this._stateMeta) update(this._stateMeta);
        resolve();
      };
      store.transaction.onabort = () => reject(store.transaction.error ?? new Error('State write aborted'));
    });
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
      const pendingWrites = Promise
        .allSettled([...this._pendingWrites])
        .then(() => undefined);
      const drained = await this._settleOrTimeout(pendingWrites);
      if (!drained) return;
    }
  }

  private _settleOrTimeout(promise: Promise<void>): Promise<boolean> {
    return new Promise(resolve => {
      let finished = false;
      const finish = (settled: boolean) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        resolve(settled);
      };
      const timer = window.setTimeout(() => finish(false), DESTROY_DRAIN_TIMEOUT_MS);
      promise.then(
        () => finish(true),
        () => finish(true),
      );
    });
  }

  private _closeDb(db: IDBDatabase): void {
    // lib0/indexeddb.openDB installs `db.onversionchange = () => db.close()`.
    // The arrow captures the surrounding module's lexical scope, so leaving
    // the handler attached after close() pins the V8 context (and every
    // class defined in the plugin module with it) until Chrome's "Pending
    // activities" tracker fully releases the connection, which races plugin
    // reload. Clearing all IDL handlers explicitly lets the wrapper and its
    // captured closure go away on the next GC cycle.
    (db as IDBDatabase & { onversionchange: unknown }).onversionchange = null;
    (db as IDBDatabase & { onerror: unknown }).onerror = null;
    (db as IDBDatabase & { onabort: unknown }).onabort = null;
    (db as IDBDatabase & { onclose: unknown }).onclose = null;
    db.close();
  }

  private _shouldIgnoreClosingError(err: unknown): boolean {
    if (isDestroyedError(err)) return true;
    if (!this._destroyed) return false;
    if (!(err instanceof DOMException)) return false;
    return err.name === 'InvalidStateError';
  }
}

/**
 * Delete the entire database.
 */
export async function deleteDatabase(appId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(getDbName(appId));
    request.onsuccess = () => resolve();
    request.onerror = () =>
				reject(request.error ?? new Error("IndexedDB request failed"));
  });
}
