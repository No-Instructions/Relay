/**
 * MergeHSM IndexedDB Persistence
 *
 * Database: {appId}-relay-hsm
 * Stores:
 *   - states: HSM state per document (PersistedMergeState)
 *   - index: Folder-level sync status (MergeIndex)
 *
 * NOTE: Yjs updates are stored in y-indexeddb (per-document databases),
 * NOT in this database. Persistence writes to IDB automatically
 * via the _storeUpdate handler on localDoc.
 */

import * as idb from 'lib0/indexeddb';
import type {
  PersistedMergeState,
  PersistedStateMeta,
  MergeIndex,
  SyncStatus,
} from '../types';

// =============================================================================
// Database Configuration
// =============================================================================

const getDbName = (appId: string) => `${appId}-relay-hsm`;

const STORES = {
  states: 'states',
  index: 'index',
} as const;

// =============================================================================
// Serialization Helpers
// =============================================================================

/**
 * Serialized MergeIndex for storage (Map converted to object).
 */
interface StoredMergeIndex {
  folderGuid: string;
  documents: Record<string, SyncStatus>;
  updatedAt: number;
}

/**
 * Allow-list all fields to prevent non-serializable values (closures, DOM refs)
 * from reaching IDB's structured clone algorithm.
 */
function sanitizeState(state: PersistedMergeState): PersistedMergeState {
  return {
    guid: state.guid,
    path: state.path,
    lca: state.lca
      ? {
          contents: state.lca.contents,
          hash: state.lca.hash,
          mtime: state.lca.mtime,
          stateVector: state.lca.stateVector,
        }
      : null,
    disk: state.disk
      ? { hash: state.disk.hash, mtime: state.disk.mtime }
      : null,
    localStateVector: state.localStateVector,
    lastStatePath: state.lastStatePath,
    deferredConflict: state.deferredConflict
      ? { diskHash: state.deferredConflict.diskHash, localHash: state.deferredConflict.localHash }
      : undefined,
    fork: state.fork
      ? {
          base: state.fork.base,
          localStateVector: state.fork.localStateVector,
          remoteStateVector: state.fork.remoteStateVector,
          origin: state.fork.origin,
          created: state.fork.created,
          captureMark: state.fork.captureMark,
        }
      : null,
    persistedAt: state.persistedAt,
  };
}

function serializeIndex(index: MergeIndex): StoredMergeIndex {
  return {
    folderGuid: index.folderGuid,
    documents: Object.fromEntries(index.documents),
    updatedAt: index.updatedAt,
  };
}

function deserializeIndex(stored: StoredMergeIndex): MergeIndex {
  return {
    folderGuid: stored.folderGuid,
    documents: new Map(Object.entries(stored.documents)),
    updatedAt: stored.updatedAt,
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
  private _pendingWrites = new Set<Promise<void>>();
  private _destroyed = false;

  constructor(appId: string) {
    this._db = idb.openDB(getDbName(appId), (db) => {
      idb.createStores(db, [
        [STORES.states, { keyPath: 'guid' }],
        [STORES.index, { keyPath: 'folderGuid' }],
      ]);
    });
  }

  // ===========================================================================
  // Document-scoped operations (states store)
  // ===========================================================================

  async saveState(guid: string, state: PersistedMergeState): Promise<void> {
    if (this._destroyed) return;
    const sanitized = sanitizeState({ ...state, guid });
    const p = this._db.then(db => {
      const [store] = idb.transact(db, [STORES.states], 'readwrite');
      return idb.put(store, sanitized as unknown as string);
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
    const p = this._db.then(db => {
      const [store] = idb.transact(db, [STORES.states], 'readwrite');
      return idb.del(store, guid);
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
        results.push({
          guid: s.guid,
          path: s.path,
          lcaMeta: s.lca
            ? { meta: { hash: s.lca.hash, mtime: s.lca.mtime }, stateVector: s.lca.stateVector }
            : null,
          disk: s.disk,
          localStateVector: s.localStateVector,
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
  // Folder-scoped operations (index store)
  // ===========================================================================

  async saveIndex(folderGuid: string, index: MergeIndex): Promise<void> {
    if (this._destroyed) return;
    const storable = serializeIndex({ ...index, folderGuid });
    const p = this._db.then(db => {
      const [store] = idb.transact(db, [STORES.index], 'readwrite');
      return idb.put(store, storable as unknown as string);
    });
    this._trackWrite(p);
    await p;
  }

  async loadIndex(folderGuid: string): Promise<MergeIndex | null> {
    const db = await this._db;
    const [store] = idb.transact(db, [STORES.index], 'readonly');
    const result = await idb.get(store, folderGuid) as unknown as StoredMergeIndex | undefined;
    if (!result) return null;
    return deserializeIndex(result);
  }

  async deleteIndex(folderGuid: string): Promise<void> {
    if (this._destroyed) return;
    const p = this._db.then(db => {
      const [store] = idb.transact(db, [STORES.index], 'readwrite');
      return idb.del(store, folderGuid);
    });
    this._trackWrite(p);
    await p;
  }

  // ===========================================================================
  // Unscoped operations
  // ===========================================================================

  async clearAllData(): Promise<void> {
    if (this._destroyed) return;
    const p = this._db.then(db => {
      const [statesStore, indexStore] = idb.transact(
        db,
        [STORES.states, STORES.index],
        'readwrite'
      );
      return Promise.all([
        idb.del(statesStore, IDBKeyRange.lowerBound('')),
        idb.del(indexStore, IDBKeyRange.lowerBound('')),
      ]).then(() => {});
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
      await Promise.all(this._pendingWrites);
    }
  }

  /** Flush pending writes and close the database connection. */
  async destroy(): Promise<void> {
    this._destroyed = true;
    await this.flush();
    const db = await this._db;
    db.close();
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private _trackWrite(p: Promise<void>): void {
    this._pendingWrites.add(p);
    p.finally(() => this._pendingWrites.delete(p));
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
