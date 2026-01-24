/**
 * MergeHSM Persistence Module
 *
 * Provides IndexedDB storage for MergeHSM state, updates, and sync status.
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

  // Updates store
  saveUpdates,
  loadUpdates,
  deleteUpdates,

  // Index store
  saveIndex,
  loadIndex,
  deleteIndex,
} from './MergeHSMDatabase';
