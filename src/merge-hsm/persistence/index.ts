/**
 * MergeHSM Persistence Module
 *
 * Provides IndexedDB storage for MergeHSM state and sync status.
 *
 * NOTE: Yjs updates are stored in y-indexeddb (per-document databases),
 * NOT in MergeHSMDatabase. This ensures compatibility with existing documents.
 * Use loadUpdatesRaw/appendUpdateRaw from src/storage/y-indexeddb.js
 */

export {
  // Database operations
  openDatabase,
  closeDatabase,
  deleteDatabase,
  clearAllData,

  // States store
  saveState,
  loadState,
  deleteState,
  getAllStateGuids,

  // NOTE: Updates are stored in y-indexeddb, not here.
  // Use the doc-less operations from y-indexeddb:
  //   - loadUpdatesRaw(dbName)
  //   - appendUpdateRaw(dbName, update)
  //   - getMergedStateWithoutDoc(dbName)

  // Index store
  saveIndex,
  loadIndex,
  deleteIndex,
} from './MergeHSMDatabase';
