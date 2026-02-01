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
  LoadUpdatesRaw,
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
// Use loadUpdatesRaw/appendUpdateRaw from src/storage/y-indexeddb.js
export {
  openDatabase,
  closeDatabase,
  deleteDatabase,
  clearAllData,
  saveState,
  loadState,
  deleteState,
  getAllStateGuids,
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
  RecordingMergeHSM,
  createE2ERecorder,
  createIntegrationRecorder,
  createShadowRecorder,
  replayRecording,
  assertReplaySucceeds,
  assertReplayDiverges,
  loadRecordingFixture,
  loadRecordingFixtures,
  serializeRecording,
  deserializeRecording,
  serializeEvent,
  deserializeEvent,
  serializeEffect,
  deserializeEffect,
  generateTestFromRecording,
  // E2E test integration
  E2ERecordingBridge,
  installE2ERecordingBridge,
} from './recording';
export type {
  HSMRecording,
  HSMTimelineEntry,
  RecordingOptions,
  RecordingMetadata,
  ReplayResult,
  ReplayDivergence,
  ReplayOptions,
  RecordableHSM,
  // E2E test integration types
  E2ERecordingBridgeConfig,
  E2ERecordingState,
  HSMRecordingGlobal,
} from './recording';

// Shadow mode infrastructure
export {
  ShadowMergeHSM,
  ShadowManager,
  createLoggingShadow,
  createCallbackShadow,
  createLoggingShadowManager,
} from './shadow';
export type {
  OldSystemAction,
  ShadowDivergence,
  ShadowModeConfig,
  ShadowDocumentState,
  ShadowSessionStats,
  ShadowManagerConfig,
  ShadowReport,
  DocumentShadowSummary,
  DivergenceType,
  DivergenceSeverity,
  ComparisonResult,
} from './shadow';

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
