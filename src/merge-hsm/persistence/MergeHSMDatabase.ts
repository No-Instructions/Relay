/**
 * MergeHSM IndexedDB Persistence
 *
 * Database: RelayMergeHSM
 * Stores:
 *   - states: HSM state per document (PersistedMergeState)
 *   - updates: Yjs updates per document (StoredUpdates)
 *   - index: Folder-level sync status (MergeIndex)
 */

import * as idb from 'lib0/indexeddb';
import type {
  PersistedMergeState,
  StoredUpdates,
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
  updates: 'updates',
  index: 'index',
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
    idb.createStores(db, [
      [STORES.states, { keyPath: 'guid' }],
      [STORES.updates, { keyPath: 'guid' }],
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
// Updates Store Operations
// =============================================================================

/**
 * Save Yjs updates for a document.
 */
export async function saveUpdates(
  db: IDBDatabase,
  stored: StoredUpdates
): Promise<void> {
  const [store] = idb.transact(db, [STORES.updates], 'readwrite');
  await idb.put(store, stored as unknown as string);
}

/**
 * Load Yjs updates for a document.
 */
export async function loadUpdates(
  db: IDBDatabase,
  guid: string
): Promise<StoredUpdates | null> {
  const [store] = idb.transact(db, [STORES.updates], 'readonly');
  const result = await idb.get(store, guid);
  return (result as unknown as StoredUpdates) ?? null;
}

/**
 * Delete Yjs updates for a document.
 */
export async function deleteUpdates(
  db: IDBDatabase,
  guid: string
): Promise<void> {
  const [store] = idb.transact(db, [STORES.updates], 'readwrite');
  await idb.del(store, guid);
}

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
 */
export async function clearAllData(db: IDBDatabase): Promise<void> {
  const [statesStore, updatesStore, indexStore] = idb.transact(
    db,
    [STORES.states, STORES.updates, STORES.index],
    'readwrite'
  );
  await Promise.all([
    idb.del(statesStore, IDBKeyRange.lowerBound('')),
    idb.del(updatesStore, IDBKeyRange.lowerBound('')),
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
