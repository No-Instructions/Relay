/**
 * MergeHSM IndexedDB Persistence
 *
 * Database: {appId}-relay-hsm
 * Stores:
 *   - states: HSM state per document (PersistedMergeState)
 *
 * NOTE: Yjs updates are stored in y-indexeddb (per-document databases),
 * NOT in this database. Persistence writes to IDB automatically
 * via the _storeUpdate handler on localDoc.
 */

import * as idb from 'lib0/indexeddb';
import type {
  PersistedMergeState,
  PersistedStateMeta,
} from '../types';
import { stateVectorFromSnapshot } from '../state-vectors';

// =============================================================================
// Database Configuration
// =============================================================================

const getDbName = (appId: string) => `${appId}-relay-hsm`;

const STORES = {
  states: 'states',
} as const;

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
 * Allow-list all fields to prevent non-serializable values (closures, DOM refs)
 * from reaching IDB's structured clone algorithm.
 */
function sanitizeState(state: PersistedMergeState): PersistedMergeState {
  const lcaSnapshot = state.lca?.snapshot;
  const localSnapshot = state.localSnapshot ?? null;
  const forkLocalSnapshot = state.fork?.localSnapshot ?? null;
  const forkRemoteSnapshot = state.fork?.remoteSnapshot ?? null;

  return {
    guid: state.guid,
    path: state.path,
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
  private _db: Promise<IDBDatabase>;
  private _pendingWrites = new Set<Promise<unknown>>();
  private _destroyed = false;
  private _destroyPromise: Promise<void> | null = null;

  constructor(appId: string) {
    this._db = idb.openDB(getDbName(appId), (db) => {
      idb.createStores(db, [
        [STORES.states, { keyPath: 'guid' }],
      ]);
    });
  }

  // ===========================================================================
  // Document-scoped operations (states store)
  // ===========================================================================

  async saveState(guid: string, state: PersistedMergeState): Promise<void> {
    if (this._destroyed) return;
    const sanitized = sanitizeState({ ...state, guid });
    const p = this._db
      .then(db => {
        if (this._destroyed) return;
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

  async loadState(guid: string): Promise<PersistedMergeState | null> {
    const db = await this._db;
    const [store] = idb.transact(db, [STORES.states], 'readonly');
    const result = await idb.get(store, guid);
    return (result as unknown as PersistedMergeState) ?? null;
  }

  async deleteState(guid: string): Promise<void> {
    if (this._destroyed) return;
    const p = this._db
      .then(db => {
        if (this._destroyed) return;
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
    const db = await this._db;
    const [store] = idb.transact(db, [STORES.states], 'readonly');
    const keys = await idb.getAllKeys(store);
    return keys as string[];
  }

  async getAllStates(): Promise<PersistedMergeState[]> {
    const db = await this._db;
    const [store] = idb.transact(db, [STORES.states], 'readonly');
    const states = await idb.getAll(store);
    return (states as unknown as PersistedMergeState[]) ?? [];
  }

  async getAllStateMeta(): Promise<PersistedStateMeta[]> {
    const db = await this._db;
    const [store] = idb.transact(db, [STORES.states], 'readonly');
    const results: PersistedStateMeta[] = [];
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(results); return; }
        const s = cursor.value as PersistedMergeState;
        const lcaLegacyStateVector = s.lca && !s.lca.snapshot
          ? stateVectorFromSnapshotOrLegacy(s.lca.snapshot, s.lca.stateVector)
          : null;
        results.push({
          guid: s.guid,
          path: s.path,
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
        if (this._destroyed) return;
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
      // Drain writes that were already queued when teardown started.
      await this.flush();
      // Block new writes from this point onward and drain once more to catch
      // operations that queued while the first drain was in progress.
      this._destroyed = true;
      await this.flush();
      const db = await this._db;
      // lib0/indexeddb.openDB installs `db.onversionchange = () => db.close()`.
      // The arrow captures the surrounding module's lexical scope, so leaving
      // the handler attached after close() pins the V8 context (and every
      // class defined in the plugin module with it) until Chrome's "Pending
      // activities" tracker fully releases the connection — which races
      // plugin reload. Clearing all IDL handlers explicitly lets the wrapper
      // and its captured closure go away on the next GC cycle.
      (db as IDBDatabase & { onversionchange: unknown }).onversionchange = null;
      (db as IDBDatabase & { onerror: unknown }).onerror = null;
      (db as IDBDatabase & { onabort: unknown }).onabort = null;
      (db as IDBDatabase & { onclose: unknown }).onclose = null;
      db.close();
    })();
    return this._destroyPromise;
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private _trackWrite(p: Promise<unknown>): void {
    this._pendingWrites.add(p);
    p.finally(() => this._pendingWrites.delete(p));
  }

  private _shouldIgnoreClosingError(err: unknown): boolean {
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
