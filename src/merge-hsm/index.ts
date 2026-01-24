/**
 * MergeHSM Module
 *
 * Exports the hierarchical state machine for document synchronization.
 */

// Main HSM class
export { MergeHSM } from './MergeHSM';
export type { TestMergeHSMConfig, IObservable } from './MergeHSM';

// Manager for multiple HSMs
export { MergeManager } from './MergeManager';
export type { MergeManagerConfig, PollOptions, RegisteredDocument } from './MergeManager';

// Types
export type {
  // State types
  MergeState,
  StatePath,
  MergeMetadata,
  LCAState,
  SyncStatus,
  SyncStatusType,

  // Event types
  MergeEvent,
  LoadEvent,
  UnloadEvent,
  AcquireLockEvent,
  ReleaseLockEvent,
  DiskChangedEvent,
  RemoteUpdateEvent,
  SaveCompleteEvent,
  CM6ChangeEvent,
  ProviderSyncedEvent,
  ConnectedEvent,
  DisconnectedEvent,
  ResolveAcceptDiskEvent,
  ResolveAcceptLocalEvent,
  ResolveAcceptMergedEvent,
  DismissConflictEvent,
  OpenDiffViewEvent,
  CancelEvent,
  PersistenceLoadedEvent,
  YDocsReadyEvent,
  MergeSuccessEvent,
  MergeConflictEvent,
  RemoteDocUpdatedEvent,
  ErrorEvent,

  // Effect types
  MergeEffect,
  DispatchCM6Effect,
  WriteDiskEffect,
  PersistStateEffect,
  PersistUpdatesEffect,
  SyncToRemoteEffect,
  StatusChangedEffect,

  // Other types
  PositionedChange,
  MergeHSMConfig,
  MergeResult,
  MergeSuccess,
  MergeFailure,
  ConflictRegion,
  PersistedMergeState,
  StoredUpdates,
  SerializableSnapshot,
  SerializableEvent,

  // Idle mode and index types
  MergeIndex,
  IdleModeState,
} from './types';

// Persistence (IndexedDB)
export {
  openDatabase,
  closeDatabase,
  deleteDatabase,
  clearAllData,
  saveState,
  loadState,
  deleteState,
  getAllStateGuids,
  saveUpdates,
  loadUpdates,
  deleteUpdates,
  saveIndex,
  loadIndex,
  deleteIndex,
} from './persistence';

// Integration classes
export { CM6Integration } from './integration/CM6Integration';
export { ProviderIntegration } from './integration/ProviderIntegration';
export type { YjsProvider } from './integration/ProviderIntegration';
export { DiskIntegration } from './integration/DiskIntegration';
export type { Vault, HashFn } from './integration/DiskIntegration';
