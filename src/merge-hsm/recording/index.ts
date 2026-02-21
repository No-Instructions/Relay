/**
 * HSM Recording Module
 *
 * Provides infrastructure for recording and replaying MergeHSM event/effect traces.
 *
 * Usage:
 *   import { replayLogEntries, HSMLogEntry } from './recording';
 *
 *   // Replay from log entries
 *   const entries: HSMLogEntry[] = [...];
 *   const result = replayLogEntries(freshHsm, entries);
 *   expect(result.success).toBe(true);
 */

// Types
export type {
  RecordableHSM,
  HSMLogEntry,
  RecordingSummary,
  SerializableEvent,
  SerializableEffect,
  SerializableLCA,
  SerializablePersistedState,
  SerializableSyncStatus,
  ReplayResult,
  ReplayDivergence,
} from './types';

// Serialization
export {
  uint8ArrayToBase64,
  base64ToUint8Array,
  serializeEvent,
  deserializeEvent,
  serializeEffect,
  deserializeEffect,
  serializeLCA,
  deserializeLCA,
  generateRecordingId,
} from './serialization';

// Replay (log-based)
export {
  replayLogEntries,
  filterLogEntries,
  sliceLogEntries,
  findLogTransition,
  loadLogFixture,
  loadLogFixtures,
} from './replay';
export type { LogReplayOptions } from './replay';

// E2E test integration
export {
  E2ERecordingBridge,
} from './E2ERecordingBridge';
export type {
  E2ERecordingBridgeConfig,
  E2ERecordingState,
} from './E2ERecordingBridge';
