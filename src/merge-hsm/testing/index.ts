/**
 * Test Utilities for MergeHSM
 *
 * Usage:
 *   import { createTestHSM, cm6Change, expectEffect, expectState } from './testing';
 *
 *   test('user edit syncs to remote', () => {
 *     const t = createTestHSM({ initialState: 'active.tracking', localDoc: 'hello' });
 *
 *     t.send(cm6Change([{ from: 5, to: 5, insert: ' world' }], 'hello world'));
 *
 *     expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
 *     expectState(t, 'active.tracking');
 *   });
 */

// Factory
export { createTestHSM } from './createTestHSM';
export type { TestHSM, TestHSMOptions, TestableHSM } from './createTestHSM';

// Event factories
export {
  // External events
  load,
  unload,
  acquireLock,
  releaseLock,
  diskChanged,
  remoteUpdate,
  saveComplete,
  cm6Change,
  cm6Insert,
  cm6Delete,
  cm6Replace,
  providerSynced,
  connected,
  disconnected,
  // User events
  resolveAcceptDisk,
  resolveAcceptLocal,
  resolveAcceptMerged,
  dismissConflict,
  openDiffView,
  cancel,
  // Internal events
  persistenceLoaded,
  yDocsReady,
  mergeSuccess,
  mergeConflict,
  remoteDocUpdated,
  error,
  // Helpers
  createLCA,
  sha256,
} from './events';

// Assertions
export {
  // Effect assertions
  expectEffect,
  expectNoEffect,
  expectEffectCount,
  getEffects,
  getLastEffect,
  // State assertions
  expectState,
  expectNotState,
  expectStateHistory,
  // Content assertions
  expectLocalDocText,
  expectRemoteDocText,
  // Change assertions
  expectDispatchChanges,
} from './assertions';
