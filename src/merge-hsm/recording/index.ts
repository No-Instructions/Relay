/**
 * HSM Recording Module
 *
 * Provides infrastructure for recording and replaying MergeHSM event/effect traces.
 *
 * Usage:
 *   import {
 *     RecordingMergeHSM,
 *     replayRecording,
 *     serializeRecording,
 *   } from './recording';
 *
 *   // Recording
 *   const recorder = new RecordingMergeHSM(hsm, { metadata: { source: 'e2e-test' } });
 *   recorder.startRecording('my-test');
 *   // ... send events ...
 *   const recording = recorder.stopRecording();
 *   fs.writeFileSync('fixture.json', serializeRecording(recording));
 *
 *   // Replay
 *   const recording = await loadRecordingFixture('fixture.json');
 *   const result = replayRecording(freshHsm, recording);
 *   expect(result.success).toBe(true);
 */

// Types
export type {
  HSMRecording,
  HSMTimelineEntry,
  RecordingOptions,
  RecordingMetadata,
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
  serializePersistedState,
  deserializePersistedState,
  serializeSyncStatus,
  deserializeSyncStatus,
  createSerializableSnapshot,
  serializeRecording,
  deserializeRecording,
  generateRecordingId,
} from './serialization';

// Recording
export {
  RecordingMergeHSM,
  createE2ERecorder,
  createIntegrationRecorder,
  createShadowRecorder,
} from './RecordingMergeHSM';
export type { RecordableHSM } from './RecordingMergeHSM';

// Replay
export {
  replayRecording,
  assertReplaySucceeds,
  assertReplayDiverges,
  loadRecordingFixture,
  loadRecordingFixtures,
  filterRecording,
  sliceRecording,
  findStateTransition,
} from './replay';
export type { ReplayOptions } from './replay';

// Test generation
export { generateTestFromRecording } from './generateTest';
export type { GenerateTestOptions } from './generateTest';

// E2E test integration
export {
  E2ERecordingBridge,
  installE2ERecordingBridge,
} from './E2ERecordingBridge';
export type {
  E2ERecordingBridgeConfig,
  E2ERecordingState,
  HSMRecordingGlobal,
  StreamingEntry,
} from './E2ERecordingBridge';
