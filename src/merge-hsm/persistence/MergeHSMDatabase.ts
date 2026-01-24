/**
 * MergeHSM IndexedDB Persistence
 *
 * Database: RelayMergeHSM
 * Stores:
 *   - states: HSM state per document (PersistedMergeState)
 *   - index: Folder-level sync status (MergeIndex)
 *
 * NOTE: Yjs updates are stored in y-indexeddb (per-document databases),
 * NOT in this database. This ensures compatibility with existing documents.
 * Use loadUpdatesRaw/appendUpdateRaw from y-indexeddb for update storage.
 */

import * as idb from 'lib0/indexeddb';
import type {
  PersistedMergeState,
  MergeIndex,
  SyncStatus,
} from '../types';

// =============================================================================
// Database Configuration
// =============================================================================

const DB_NAME = 'RelayMergeHSM';
const DB_VERSION = 1;

const STORES = {
  states: 'states',
  index: 'index',
  // NOTE: No 'updates' store - Yjs updates are stored in y-indexeddb
  // per-document databases for compatibility with existing documents.
} as const;

// =============================================================================
// Database Helper Functions
// =============================================================================

/**
 * Open or create the RelayMergeHSM database.
 */
export async function openDatabase(): Promise<IDBDatabase> {
  return idb.openDB(DB_NAME, (db) => {
    // Create stores if they don't exist
    // NOTE: No 'updates' store - use y-indexeddb for Yjs update storage
    idb.createStores(db, [
      [STORES.states, { keyPath: 'guid' }],
      [STORES.index, { keyPath: 'folderGuid' }],
    ]);
  });
}

/**
 * Close the database connection.
 */
export function closeDatabase(db: IDBDatabase): void {
  db.close();
}

// =============================================================================
// States Store Operations
// =============================================================================

/**
 * Save HSM state for a document.
 */
export async function saveState(
  db: IDBDatabase,
  state: PersistedMergeState
): Promise<void> {
  const [store] = idb.transact(db, [STORES.states], 'readwrite');
  await idb.put(store, state as unknown as string);
}

/**
 * Load HSM state for a document.
 */
export async function loadState(
  db: IDBDatabase,
  guid: string
): Promise<PersistedMergeState | null> {
  const [store] = idb.transact(db, [STORES.states], 'readonly');
  const result = await idb.get(store, guid);
  return (result as unknown as PersistedMergeState) ?? null;
}

/**
 * Delete HSM state for a document.
 */
export async function deleteState(
  db: IDBDatabase,
  guid: string
): Promise<void> {
  const [store] = idb.transact(db, [STORES.states], 'readwrite');
  await idb.del(store, guid);
}

/**
 * Get all stored state GUIDs.
 */
export async function getAllStateGuids(db: IDBDatabase): Promise<string[]> {
  const [store] = idb.transact(db, [STORES.states], 'readonly');
  const keys = await idb.getAllKeys(store);
  return keys as string[];
}

// =============================================================================
// Yjs Updates Storage (via y-indexeddb)
// =============================================================================
//
// IMPORTANT: Yjs updates are NOT stored in this database.
// They are stored in y-indexeddb per-document databases for compatibility
// with existing documents.
//
// To work with Yjs updates in idle mode (without loading a YDoc), use:
//   - loadUpdatesRaw(dbName)         - load raw updates
//   - appendUpdateRaw(dbName, update) - append an update
//   - getMergedStateWithoutDoc(dbName) - get merged update + state vector
//
// These functions are exported from src/storage/y-indexeddb.js
//
// The database name convention is: `${appId}-relay-doc-${guid}`

// =============================================================================
// Index Store Operations
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
 * Save folder-level sync status index.
 */
export async function saveIndex(
  db: IDBDatabase,
  index: MergeIndex
): Promise<void> {
  // Convert Map to object for storage
  const storable: StoredMergeIndex = {
    folderGuid: index.folderGuid,
    documents: Object.fromEntries(index.documents),
    updatedAt: index.updatedAt,
  };
  const [store] = idb.transact(db, [STORES.index], 'readwrite');
  await idb.put(store, storable as unknown as string);
}

/**
 * Load folder-level sync status index.
 */
export async function loadIndex(
  db: IDBDatabase,
  folderGuid: string
): Promise<MergeIndex | null> {
  const [store] = idb.transact(db, [STORES.index], 'readonly');
  const result = await idb.get(store, folderGuid) as unknown as StoredMergeIndex | undefined;
  if (!result) return null;

  // Convert object back to Map
  return {
    folderGuid: result.folderGuid,
    documents: new Map(Object.entries(result.documents)),
    updatedAt: result.updatedAt,
  };
}

/**
 * Delete folder-level sync status index.
 */
export async function deleteIndex(
  db: IDBDatabase,
  folderGuid: string
): Promise<void> {
  const [store] = idb.transact(db, [STORES.index], 'readwrite');
  await idb.del(store, folderGuid);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Clear all data from the database.
 * Use with caution - for testing or reset scenarios.
 * NOTE: This does NOT clear Yjs updates - those are in y-indexeddb.
 */
export async function clearAllData(db: IDBDatabase): Promise<void> {
  const [statesStore, indexStore] = idb.transact(
    db,
    [STORES.states, STORES.index],
    'readwrite'
  );
  await Promise.all([
    idb.del(statesStore, IDBKeyRange.lowerBound('')),
    idb.del(indexStore, IDBKeyRange.lowerBound('')),
  ]);
}

/**
 * Delete the entire database.
 */
export async function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
