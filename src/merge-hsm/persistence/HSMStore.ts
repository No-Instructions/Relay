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
import { stateVectorFromSnapshot } from '../state-vectors';
import { DestroyedError, isDestroyedError } from '../../DestroyedError';

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

function stateVectorFromPersistedSnapshot(snapshot: Uint8Array | null | undefined): Uint8Array | null {
  if (!snapshot) return null;
  try {
    return stateVectorFromSnapshot({ snapshot });
  } catch {
    return null;
  }
}

function stateVectorFromSnapshotOrLegacy(
  snapshot: Uint8Array | null | undefined,
  legacyStateVector: Uint8Array | null | undefined,
): Uint8Array | null {
  return stateVectorFromPersistedSnapshot(snapshot) ?? legacyStateVector ?? null;
}

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
  const lcaSnapshot = state.lca?.snapshot;
  const localSnapshot = state.localSnapshot ?? null;
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
          ...(lcaSnapshot
            ? { snapshot: lcaSnapshot }
            : state.lca.stateVector
              ? { stateVector: state.lca.stateVector }
              : {}),
        }
      : null,
    disk: state.disk
      ? { hash: state.disk.hash, mtime: state.disk.mtime }
      : null,
    localSnapshot,
    ...(!localSnapshot && state.localStateVector
      ? { localStateVector: state.localStateVector }
      : {}),
    lastStatePath: state.lastStatePath,
    deferredConflict: state.deferredConflict
      ? { diskHash: state.deferredConflict.diskHash, localHash: state.deferredConflict.localHash }
      : undefined,
    fork: state.fork
      ? {
          base: state.fork.base,
          ...(forkLocalSnapshot
            ? { localSnapshot: forkLocalSnapshot }
            : state.fork.localStateVector
              ? { localStateVector: state.fork.localStateVector }
              : {}),
          ...(forkRemoteSnapshot
            ? { remoteSnapshot: forkRemoteSnapshot }
            : state.fork.remoteStateVector
              ? { remoteStateVector: state.fork.remoteStateVector }
              : {}),
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
 * plugin and shared across SharedFolders.
 */
export class HSMStore {
  private _openDb: Promise<IDBDatabase>;
  private _db: Promise<IDBDatabase>;
  private _dbInstance: IDBDatabase | null = null;
  private _pendingWrites = new Set<Promise<unknown>>();
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
        const [store] = idb.transact(db, [STORES.states], 'readwrite');
        return idb.put(store, sanitized as unknown as string);
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
        const [store] = idb.transact(db, [STORES.states], 'readwrite');
        return idb.del(store, guid);
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
      const states = await idb.getAll(store);
      return (states as unknown as PersistedHSMRecord[]) ?? [];
    });
  }

  async getAllStateMeta(): Promise<PersistedStateMeta[]> {
    return this._read<PersistedStateMeta[]>([], db => this._collectStateMeta(db));
  }

  private _collectStateMeta(db: IDBDatabase): Promise<PersistedStateMeta[]> {
    const [store] = idb.transact(db, [STORES.states], 'readonly');
    const results: PersistedStateMeta[] = [];
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(results); return; }
        const record = cursor.value as PersistedHSMRecord;
        if (record.kind === 'canvas') {
          // Canvas records project their own lightweight meta: no
          // snapshots, no fork, lastStatePath opaque (a canvas state
          // path, cast for the shared projection shape). Consumers must
          // discriminate on `kind` before interpreting document fields.
          results.push({
            kind: 'canvas',
            guid: record.guid,
            path: record.path,
            folder: record.folder,
            lcaMeta: record.lca
              ? { meta: { hash: record.lca.hash, mtime: record.lca.mtime } }
              : null,
            disk: record.disk,
            localSnapshot: null,
            lastStatePath: record.lastStatePath as PersistedStateMeta['lastStatePath'],
            hasFork: false,
            persistedAt: record.persistedAt,
          });
          cursor.continue();
          return;
        }
        const s = record;
        const lcaLegacyStateVector = s.lca && !s.lca.snapshot
          ? stateVectorFromSnapshotOrLegacy(s.lca.snapshot, s.lca.stateVector)
          : null;
        results.push({
          guid: s.guid,
          path: s.path,
          folder: s.folder,
          lcaMeta: s.lca && (s.lca.snapshot || lcaLegacyStateVector)
            ? {
                meta: { hash: s.lca.hash, mtime: s.lca.mtime },
                ...(s.lca.snapshot ? { snapshot: s.lca.snapshot } : {}),
                ...(lcaLegacyStateVector ? { stateVector: lcaLegacyStateVector } : {}),
              }
            : null,
          disk: s.disk,
          localSnapshot: s.localSnapshot ?? null,
          ...(!s.localSnapshot
            ? {
                localStateVector: stateVectorFromSnapshotOrLegacy(
                  s.localSnapshot,
                  s.localStateVector,
                ),
              }
            : {}),
          lastStatePath: s.lastStatePath,
          deferredConflict: s.deferredConflict,
          hasFork: !!s.fork,
          persistedAt: s.persistedAt,
        });
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
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
        const [statesStore] = idb.transact(db, [STORES.states], 'readwrite');
        return idb.del(statesStore, IDBKeyRange.lowerBound(''));
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
        globalThis.clearTimeout(timer);
        resolve(settled);
      };
      const timer = globalThis.setTimeout(() => finish(false), DESTROY_DRAIN_TIMEOUT_MS);
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
    request.onerror = () => reject(request.error);
  });
}
