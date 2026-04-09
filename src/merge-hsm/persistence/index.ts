/**
 * MergeHSM Persistence Module
 *
 * Provides IndexedDB storage for MergeHSM state and sync status.
 *
 * NOTE: Yjs updates are stored in y-indexeddb (per-document databases),
 * NOT in HSMStore. Persistence writes to IDB automatically
 * via the _storeUpdate handler on localDoc.
 */

export {
  HSMStore,
  deleteDatabase,
} from './HSMStore';
