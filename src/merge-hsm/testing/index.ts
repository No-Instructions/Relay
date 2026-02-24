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
  sendAcquireLock,
  sendAcquireLockToTracking,
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
  resolve,
  dismissConflict,
  openDiffView,
  cancel,
  // Internal events
  persistenceLoaded,
  persistenceSynced,
  mergeSuccess,
  mergeConflict,
  remoteDocUpdated,
  error,
  // Helpers
  createLCA,
  sha256,
  createYjsUpdate,
  // State transition helpers (drive through real transitions)
  loadAndActivate,
  loadToIdle,
  loadToLoading,
  loadToConflict,
  loadToResolving,
} from './events';
export type {
  HSMHandle,
  LoadAndActivateOptions,
  LoadToIdleOptions,
  LoadToLoadingOptions,
  LoadToConflictOptions,
} from './events';

// Random timing (seeded via TEST_SEED env var)
export { nextInt, nextDelay, resetFountain } from './random';

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
