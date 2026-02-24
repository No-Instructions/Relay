/**
 * MergeHSM Module
 *
 * Exports the hierarchical state machine for document synchronization.
 */

// Main HSM class
export { MergeHSM } from './MergeHSM';
export type { IObservable } from './MergeHSM';

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
  ResolveEvent,
  DismissConflictEvent,
  OpenDiffViewEvent,
  CancelEvent,
  PersistenceLoadedEvent,
  PersistenceSyncedEvent,
  MergeSuccessEvent,
  MergeConflictEvent,
  RemoteDocUpdatedEvent,
  ErrorEvent,
  // Diagnostic events (from Obsidian monkeypatches)
  ObsidianLoadFileInternalEvent,
  ObsidianThreeWayMergeEvent,

  // Effect types
  MergeEffect,
  DispatchCM6Effect,
  WriteDiskEffect,
  PersistStateEffect,
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
  SerializableSnapshot,
  SerializableEvent,

  // Idle mode and index types
  MergeIndex,
  IdleModeState,
  // NOTE: StoredUpdates removed - Yjs updates are stored in y-indexeddb
} from './types';

// Persistence (IndexedDB)
// NOTE: Yjs updates are stored in y-indexeddb, not here.
// Persistence writes to IDB automatically via localDoc's _storeUpdate handler.
export {
  openDatabase,
  closeDatabase,
  deleteDatabase,
  clearAllData,
  saveState,
  loadState,
  deleteState,
  getAllStateGuids,
  getAllStates,
  // REMOVED: saveUpdates, loadUpdates, deleteUpdates - use y-indexeddb instead
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

// Recording infrastructure
export {
  replayLogEntries,
  filterLogEntries,
  sliceLogEntries,
  findLogTransition,
  loadLogFixture,
  loadLogFixtures,
  serializeEvent,
  deserializeEvent,
  serializeEffect,
  deserializeEffect,
  serializeLCA,
  deserializeLCA,
  generateRecordingId,
  uint8ArrayToBase64,
  base64ToUint8Array,
  // E2E test integration
  E2ERecordingBridge,
} from './recording';
export type {
  HSMLogEntry,
  RecordingSummary,
  ReplayResult,
  ReplayDivergence,
  LogReplayOptions,
  // E2E test integration types
  E2ERecordingBridgeConfig,
  E2ERecordingState,
} from './recording';

// Invariant checking
export {
  InvariantChecker,
  createLoggingChecker,
  createStrictChecker,
  createTestChecker,
  STANDARD_INVARIANTS,
  getInvariantsForState,
  getInvariantsByTrigger,
} from './invariants';
export type {
  InvariantDefinition,
  InvariantViolation,
  InvariantConfig,
  InvariantCheckContext,
  InvariantSeverity,
  CheckableHSM,
} from './invariants';

// Visual debugger
export {
  HSMDebuggerView,
  HSM_DEBUGGER_VIEW_TYPE,
  openHSMDebugger,
} from './debugger';

// Machine visualization
export { toMermaid, toDOT } from './machine-visualization';
