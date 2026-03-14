/**
 * MergeHSM Persistence Module
 *
 * Provides IndexedDB storage for MergeHSM state and sync status.
 *
 * NOTE: Yjs updates are stored in y-indexeddb (per-document databases),
 * NOT in MergeHSMDatabase. Persistence writes to IDB automatically
 * via the _storeUpdate handler on localDoc.
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
  getAllStates,

  // Index store
  saveIndex,
  loadIndex,
  deleteIndex,
} from './MergeHSMDatabase';
