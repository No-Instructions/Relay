/**
 * MergeHSM Tests
 *
 * These tests drive the HSM through various scenarios using the test harness.
 * The harness provides:
 * - Event factories for creating serializable events
 * - Assertion helpers for checking effects and state
 * - Time control via MockTimeProvider
 * - Snapshot support for future recording
 */

import {
  createTestHSM,
  // Event factories
  load,
  acquireLock,
  releaseLock,
  cm6Change,
  cm6Insert,
  remoteUpdate,
  remoteDocUpdated,
  diskChanged,
  saveComplete,
  persistenceLoaded,
  yDocsReady,
  mergeConflict,
  openDiffView,
  resolveAcceptDisk,
  resolveAcceptLocal,
  resolveAcceptMerged,
  dismissConflict,
  cancel,
  providerSynced,
  connected,
  disconnected,
  error,
  createLCA,
  // Assertions
  expectEffect,
  expectNoEffect,
  expectState,
  expectLocalDocText,
} from '../testing';

import * as Y from 'yjs';

// =============================================================================
// Helper to create Yjs updates for testing
// =============================================================================

function createYjsUpdate(_fromText: string, toText: string): Uint8Array {
  // Create a doc with the target content and return full state.
  // This simulates receiving a state update from the server.
  // In real usage, server sends updates that can be applied to any doc.
  const doc = new Y.Doc();
  doc.getText('content').insert(0, toText);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

// =============================================================================
// Loading and State Transitions
// =============================================================================

describe('MergeHSM', () => {
  describe('loading', () => {
    test('starts in unloaded state', () => {
      const t = createTestHSM();
      expectState(t, 'unloaded');
    });

    test('LOAD transitions to loading.loadingPersistence', () => {
      const t = createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));

      expectState(t, 'loading.loadingPersistence');
    });

    test('PERSISTENCE_LOADED transitions through loadingLCA to idle', () => {
      const t = createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));

      // Should auto-transition to idle.clean (no LCA, no local changes)
      expectState(t, 'idle.clean');
    });

    test('PERSISTENCE_LOADED with LCA and matching disk goes to idle.clean', () => {
      const t = createTestHSM({
        disk: { contents: 'hello', mtime: 1000 },
      });

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), createLCA('hello', 1000)));

      expectState(t, 'idle.clean');
    });

    test('PERSISTENCE_LOADED with disk changes goes to idle.diskAhead', () => {
      const t = createTestHSM({
        disk: { contents: 'hello modified', mtime: 2000 },
      });

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), createLCA('hello', 1000)));

      expectState(t, 'idle.diskAhead');
    });
  });

  // ===========================================================================
  // Active Mode: Tracking
  // ===========================================================================

  describe('active.tracking', () => {
    test('user edit updates localDoc', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      t.send(cm6Insert(5, ' world', 'hello world'));

      expectLocalDocText(t, 'hello world');
      expectState(t, 'active.tracking');
    });

    test('user edit emits SYNC_TO_REMOTE effect', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      t.send(cm6Insert(5, ' world', 'hello world'));

      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
    });

    test('user edit with isFromYjs=true does not emit SYNC_TO_REMOTE', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      t.send(cm6Change(
        [{ from: 5, to: 5, insert: ' world' }],
        'hello world',
        true // isFromYjs
      ));

      expectNoEffect(t.effects, 'SYNC_TO_REMOTE');
    });

    test('multiple edits each emit SYNC_TO_REMOTE', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: '',
      });

      t.send(cm6Insert(0, 'a', 'a'));
      t.send(cm6Insert(1, 'b', 'ab'));
      t.send(cm6Insert(2, 'c', 'abc'));

      expectLocalDocText(t, 'abc');
      expect(t.effects.filter(e => e.type === 'SYNC_TO_REMOTE').length).toBe(3);
    });

    test('remote update dispatches to editor', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      // Simulate a remote change by directly modifying remoteDoc
      // (this is what would happen when WebSocket receives an update)
      const remoteDoc = t.hsm.getRemoteDoc()!;
      remoteDoc.getText('content').insert(5, ' world');

      // Send REMOTE_DOC_UPDATED to trigger the HSM to sync and emit effects
      t.send(remoteDocUpdated());

      expectEffect(t.effects, { type: 'DISPATCH_CM6' });
      expectLocalDocText(t, 'hello world');
    });

    test('SAVE_COMPLETE updates LCA mtime', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
        lca: createLCA('hello', 1000),
      });

      t.send(saveComplete(2000));

      expect(t.state.lca?.meta.mtime).toBe(2000);
    });
  });

  // ===========================================================================
  // Active Mode: Lock Management
  // ===========================================================================

  describe('lock management', () => {
    test('ACQUIRE_LOCK from idle transitions to active.entering', () => {
      const t = createTestHSM();

      // Simulate going through loading to idle
      t.send(load('doc-123', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send(acquireLock());

      expectState(t, 'active.entering');
    });

    test('YDOCS_READY transitions to active.tracking', () => {
      const t = createTestHSM();

      t.send(load('doc-123', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send(acquireLock());
      t.send(yDocsReady());

      expectState(t, 'active.tracking');
    });

    test('RELEASE_LOCK transitions back to idle', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      t.send(releaseLock());

      expectState(t, 'idle.clean');
      expect(t.getLocalDocText()).toBeNull(); // YDocs should be cleaned up
    });
  });

  // ===========================================================================
  // Active Mode: Disk Changes
  // ===========================================================================

  describe('disk changes in active mode', () => {
    test('DISK_CHANGED with identical content stays in tracking', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
        lca: createLCA('hello', Date.now() - 1000),
      });

      t.send(diskChanged('hello', Date.now()));

      // Same content - no merge needed, stay in tracking
      expectState(t, 'active.tracking');
    });

    test('DISK_CHANGED with disk-only changes auto-merges', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
        lca: createLCA('hello', Date.now() - 1000),
      });

      t.send(diskChanged('hello world', Date.now()));

      // Local matches LCA, disk has changes - auto-merge succeeds
      expectState(t, 'active.tracking');
      expectLocalDocText(t, 'hello world');
    });

    test('DISK_CHANGED with conflicting changes shows conflict', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello local',
        lca: createLCA('hello', Date.now() - 1000),
      });

      t.send(diskChanged('hello disk', Date.now()));

      // Both local and disk changed from LCA - conflict
      expectState(t, 'active.conflict.bannerShown');
    });
  });

  // ===========================================================================
  // Active Mode: Conflict Resolution
  // ===========================================================================

  describe('conflict resolution', () => {
    test('MERGE_CONFLICT transitions to active.conflict.bannerShown', () => {
      const t = createTestHSM({
        initialState: 'active.merging',
        localDoc: 'hello local',
      });

      t.send(mergeConflict('hello', 'hello local', 'hello remote'));

      expectState(t, 'active.conflict.bannerShown');
    });

    test('OPEN_DIFF_VIEW transitions to active.conflict.resolving', () => {
      const t = createTestHSM({
        initialState: 'active.conflict.bannerShown',
        localDoc: 'hello local',
      });

      t.send(openDiffView());

      expectState(t, 'active.conflict.resolving');
    });

    test('RESOLVE_ACCEPT_DISK returns to tracking', () => {
      const t = createTestHSM({
        initialState: 'active.conflict.resolving',
        localDoc: 'hello local',
      });

      t.send(resolveAcceptDisk());

      expectState(t, 'active.tracking');
    });

    test('RESOLVE_ACCEPT_LOCAL returns to tracking', () => {
      const t = createTestHSM({
        initialState: 'active.conflict.resolving',
        localDoc: 'hello local',
      });

      t.send(resolveAcceptLocal());

      expectState(t, 'active.tracking');
    });

    test('DISMISS_CONFLICT defers and returns to tracking', () => {
      const t = createTestHSM({
        initialState: 'active.conflict.bannerShown',
        localDoc: 'hello local',
        disk: { contents: 'hello disk', mtime: 1000 },
      });

      t.send(dismissConflict());

      expectState(t, 'active.tracking');
      expect(t.state.deferredConflict).toBeDefined();
    });

    test('RESOLVE_ACCEPT_DISK applies disk content to localDoc', () => {
      const t = createTestHSM({
        initialState: 'active.merging',
        localDoc: 'hello local',
        lca: createLCA('hello', Date.now() - 1000),
      });

      // First trigger a conflict
      t.send(mergeConflict('hello', 'hello local', 'hello disk'));
      expectState(t, 'active.conflict.bannerShown');

      t.send(openDiffView());
      t.clearEffects();

      t.send(resolveAcceptDisk());

      expectState(t, 'active.tracking');
      expectLocalDocText(t, 'hello disk');
      expectEffect(t.effects, { type: 'DISPATCH_CM6' });
    });

    test('RESOLVE_ACCEPT_LOCAL keeps localDoc unchanged', () => {
      const t = createTestHSM({
        initialState: 'active.merging',
        localDoc: 'hello local',
        lca: createLCA('hello', Date.now() - 1000),
      });

      // First trigger a conflict
      t.send(mergeConflict('hello', 'hello local', 'hello disk'));
      t.send(openDiffView());
      t.clearEffects();

      t.send(resolveAcceptLocal());

      expectState(t, 'active.tracking');
      expectLocalDocText(t, 'hello local');
      // No DISPATCH_CM6 because content didn't change
      expectNoEffect(t.effects, 'DISPATCH_CM6');
    });

    test('RESOLVE_ACCEPT_MERGED applies merged content', () => {
      const t = createTestHSM({
        initialState: 'active.merging',
        localDoc: 'hello local',
        lca: createLCA('hello', Date.now() - 1000),
      });

      // First trigger a conflict
      t.send(mergeConflict('hello', 'hello local', 'hello disk'));
      t.send(openDiffView());
      t.clearEffects();

      t.send(resolveAcceptMerged('hello merged'));

      expectState(t, 'active.tracking');
      expectLocalDocText(t, 'hello merged');
      expectEffect(t.effects, { type: 'DISPATCH_CM6' });
    });

    test('CANCEL from resolving returns to bannerShown', () => {
      const t = createTestHSM({
        initialState: 'active.conflict.resolving',
        localDoc: 'hello local',
      });

      t.send(cancel());

      expectState(t, 'active.conflict.bannerShown');
    });

    test('ACQUIRE_LOCK from idle.diverged goes to conflict.bannerShown', () => {
      const t = createTestHSM({
        initialState: 'idle.diverged',
        lca: createLCA('original', 1000),
        disk: { contents: 'disk changed', mtime: 2000 },
      });

      t.send(acquireLock());

      // Should go through blocked and immediately to bannerShown
      expectState(t, 'active.conflict.bannerShown');
      // YDocs should be created
      expect(t.hsm.getLocalDoc()).not.toBeNull();
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('error handling', () => {
    test('ERROR in idle mode transitions to idle.error', () => {
      const t = createTestHSM({
        initialState: 'idle.clean',
      });

      const testError = new Error('Test error');
      t.send(error(testError));

      expectState(t, 'idle.error');
      expect(t.state.error).toBe(testError);
    });

    test('ERROR in active mode stores error but stays in state', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      const testError = new Error('Test error');
      t.send(error(testError));

      // Active mode doesn't transition to error state (spec doesn't define this)
      expectState(t, 'active.tracking');
      expect(t.state.error).toBe(testError);
    });

    test('getSyncStatus returns error status when in error state', () => {
      const t = createTestHSM({
        initialState: 'idle.clean',
      });

      t.send(error(new Error('Test error')));

      const status = t.hsm.getSyncStatus();
      expect(status.status).toBe('error');
    });
  });

  // ===========================================================================
  // Network Events
  // ===========================================================================

  describe('network events', () => {
    test('CONNECTED event is handled in active.tracking', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      t.send(connected());

      // Should stay in tracking (network events don't cause state transitions)
      expectState(t, 'active.tracking');
    });

    test('DISCONNECTED event is handled in active.tracking', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      t.send(disconnected());

      // Should stay in tracking
      expectState(t, 'active.tracking');
    });

    test('PROVIDER_SYNCED event is handled in active.tracking', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      t.send(providerSynced());

      // Should stay in tracking
      expectState(t, 'active.tracking');
    });

    test('network events work in idle mode too', () => {
      const t = createTestHSM({
        initialState: 'idle.clean',
      });

      t.send(connected());
      expectState(t, 'idle.clean');

      t.send(disconnected());
      expectState(t, 'idle.clean');
    });
  });

  // ===========================================================================
  // Drift Detection
  // ===========================================================================

  describe('drift detection', () => {
    test('checkAndCorrectDrift returns false when no drift', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      // Simulate an editor change that matches localDoc
      t.send(cm6Insert(5, ' world', 'hello world'));
      t.clearEffects();

      // Check for drift - should be none
      const driftDetected = t.hsm.checkAndCorrectDrift();

      expect(driftDetected).toBe(false);
      expectNoEffect(t.effects, 'DISPATCH_CM6');
    });

    test('checkAndCorrectDrift detects and corrects drift', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
      });

      // Simulate editor reporting one thing
      t.send(cm6Insert(5, ' world', 'hello world'));
      t.clearEffects();

      // But localDoc has different content (simulating drift/bug)
      // Manually modify localDoc without going through CM6
      const localDoc = t.hsm.getLocalDoc()!;
      localDoc.getText('content').delete(5, 6); // Remove " world"
      localDoc.getText('content').insert(5, ' universe');

      // Now check drift - should detect and correct
      const driftDetected = t.hsm.checkAndCorrectDrift();

      expect(driftDetected).toBe(true);
      expectEffect(t.effects, { type: 'DISPATCH_CM6' });
    });

    test('checkAndCorrectDrift only works in active.tracking', () => {
      const t = createTestHSM({
        initialState: 'idle.clean',
      });

      const driftDetected = t.hsm.checkAndCorrectDrift();

      expect(driftDetected).toBe(false);
    });
  });

  // ===========================================================================
  // Idle Mode: Remote Updates
  // ===========================================================================

  describe('idle mode', () => {
    test('REMOTE_UPDATE in idle transitions to idle.remoteAhead', () => {
      const t = createTestHSM();

      // Go to idle.clean first
      t.send(load('doc-123', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      // Stub goes to loading.loadingLCA, manually transition to idle for this test
      // In real impl, this would happen automatically

      // Create a fresh test starting in idle
      const t2 = createTestHSM({ initialState: 'idle.clean' });

      const update = createYjsUpdate('', 'hello');
      t2.send(remoteUpdate(update));

      expectState(t2, 'idle.remoteAhead');
    });

    test('DISK_CHANGED in idle transitions to idle.diskAhead', () => {
      const t = createTestHSM({ initialState: 'idle.clean' });

      t.send(diskChanged('modified content', Date.now()));

      expectState(t, 'idle.diskAhead');
    });

    test('idle mode does not create YDocs (lightweight)', () => {
      const t = createTestHSM({ initialState: 'idle.clean' });

      // Verify no YDocs exist in idle mode
      expect(t.getLocalDocText()).toBeNull();
      expect(t.getRemoteDocText()).toBeNull();

      // Receive remote update - should still not create YDocs
      const update = createYjsUpdate('', 'hello');
      t.send(remoteUpdate(update));

      expect(t.getLocalDocText()).toBeNull();
      expect(t.getRemoteDocText()).toBeNull();
    });

    test('ACQUIRE_LOCK creates YDocs for active mode', () => {
      const t = createTestHSM({ initialState: 'idle.clean' });

      // No YDocs before
      expect(t.getLocalDocText()).toBeNull();

      t.send(acquireLock());

      // YDocs created after ACQUIRE_LOCK
      expect(t.hsm.getLocalDoc()).not.toBeNull();
      expect(t.hsm.getRemoteDoc()).not.toBeNull();
    });

    test('idle.remoteAhead auto-merges when disk==lca', () => {
      const t = createTestHSM({
        initialState: 'idle.clean',
        lca: createLCA('hello', 1000),
        disk: { contents: 'hello', mtime: 1000 }, // disk matches LCA
      });
      t.clearEffects();

      // Remote update arrives
      const update = createYjsUpdate('hello', 'hello world');
      t.send(remoteUpdate(update));

      // Should auto-merge and emit WRITE_DISK
      expectEffect(t.effects, { type: 'WRITE_DISK' });
      expectState(t, 'idle.clean');
    });

    test('idle.diskAhead auto-merges when remote==lca', () => {
      const t = createTestHSM({
        initialState: 'idle.clean',
        lca: createLCA('hello', 1000),
      });
      t.clearEffects();

      // Disk changes externally
      t.send(diskChanged('hello world', 2000));

      // Should auto-merge and emit SYNC_TO_REMOTE
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
      expectState(t, 'idle.clean');
    });

    test('idle.diverged auto-merges when no conflicts', () => {
      const t = createTestHSM({
        initialState: 'idle.clean',
        lca: createLCA('line1\nline2\nline3', 1000),
      });

      // First, remote update changes line1
      const update = createYjsUpdate('line1\nline2\nline3', 'REMOTE\nline2\nline3');
      t.send(remoteUpdate(update));

      // Then disk changes line3 - diverged but mergeable
      t.send(diskChanged('line1\nline2\nDISK', 2000));

      // 3-way merge should succeed - back to clean
      expectState(t, 'idle.clean');
      expectEffect(t.effects, { type: 'WRITE_DISK' });
    });

    test('idle.diverged stays diverged when merge has conflicts', () => {
      // Start with disk already changed from LCA, so when remote arrives,
      // auto-merge won't succeed (disk != lca)
      const t = createTestHSM({
        initialState: 'idle.diskAhead',
        lca: createLCA('original line', 1000),
        disk: { contents: 'disk changed this', mtime: 2000 },
      });

      // Remote update changes the same line - creates a conflict
      const update = createYjsUpdate('original line', 'remote changed this');
      t.send(remoteUpdate(update));

      // Should be in diverged state (3-way merge has conflict on same line)
      // The merge will fail because both sides changed the same line
      expectState(t, 'idle.diverged');
    });
  });

  // ===========================================================================
  // Sync Status
  // ===========================================================================

  describe('getSyncStatus', () => {
    test('returns synced status in idle.clean', () => {
      const t = createTestHSM({ initialState: 'idle.clean', guid: 'doc-123', path: 'test.md' });

      const status = t.hsm.getSyncStatus();

      expect(status.guid).toBe('doc-123');
      expect(status.path).toBe('test.md');
      expect(status.status).toBe('synced');
    });

    test('returns synced status in active.tracking', () => {
      const t = createTestHSM({ initialState: 'active.tracking', localDoc: 'hello' });

      const status = t.hsm.getSyncStatus();

      expect(status.status).toBe('synced');
    });

    test('returns pending status in idle.remoteAhead', () => {
      const t = createTestHSM({ initialState: 'idle.remoteAhead' });

      const status = t.hsm.getSyncStatus();

      expect(status.status).toBe('pending');
    });

    test('returns conflict status in active.conflict.bannerShown', () => {
      const t = createTestHSM({ initialState: 'active.conflict.bannerShown', localDoc: 'hello' });

      const status = t.hsm.getSyncStatus();

      expect(status.status).toBe('conflict');
    });
  });

  // ===========================================================================
  // Persistence Effects
  // ===========================================================================

  describe('persistence effects', () => {
    test('SAVE_COMPLETE emits PERSIST_STATE', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
        lca: createLCA('hello', 1000),
      });
      t.clearEffects();

      t.send(saveComplete(2000));

      expectEffect(t.effects, { type: 'PERSIST_STATE' });
    });

    test('DISMISS_CONFLICT emits PERSIST_STATE', () => {
      const t = createTestHSM({
        initialState: 'active.conflict.bannerShown',
        localDoc: 'hello',
        disk: { contents: 'hello disk', mtime: 1000 },
      });
      t.clearEffects();

      t.send(dismissConflict());

      expectEffect(t.effects, { type: 'PERSIST_STATE' });
    });

    test('successful merge emits PERSIST_STATE', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
        lca: createLCA('hello', 1000),
      });
      t.clearEffects();

      // Disk change that can auto-merge (local matches LCA)
      t.send(diskChanged('hello world', Date.now()));

      expectEffect(t.effects, { type: 'PERSIST_STATE' });
    });

    test('STATUS_CHANGED emitted on sync status change', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello local',
        lca: createLCA('hello', 1000),
      });
      t.clearEffects();

      // Trigger conflict which changes status from synced to conflict
      t.send(diskChanged('hello disk', Date.now()));

      expectEffect(t.effects, { type: 'STATUS_CHANGED' });
    });
  });

  // ===========================================================================
  // Snapshot (for future recording)
  // ===========================================================================

  describe('snapshot', () => {
    test('creates serializable snapshot', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
        lca: createLCA('hello', 1000),
      });

      const snapshot = t.snapshot();

      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.state.guid).toBe('test-guid');
      expect(snapshot.state.statePath).toBe('active.tracking');
      expect(snapshot.localDocText).toBe('hello');
      expect(snapshot.state.lca?.contents).toBe('hello');
    });

    test('snapshot is JSON serializable', () => {
      const t = createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'test content',
      });

      const snapshot = t.snapshot();
      const json = JSON.stringify(snapshot);
      const parsed = JSON.parse(json);

      expect(parsed.state.statePath).toBe('active.tracking');
      expect(parsed.localDocText).toBe('test content');
    });
  });

  // ===========================================================================
  // State History Tracking
  // ===========================================================================

  describe('state history', () => {
    test('tracks state transitions (one per event)', () => {
      const t = createTestHSM();

      t.send(load('doc-123', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));

      // State history tracks one transition per event (final state per event)
      // LOAD: unloaded → loading.loadingPersistence
      // PERSISTENCE_LOADED: loading.loadingPersistence → idle.clean (via loadingLCA internally)
      expect(t.stateHistory.length).toBe(2);
      expect(t.stateHistory[0].to).toBe('loading.loadingPersistence');
      expect(t.stateHistory[1].to).toBe('idle.clean');
    });
  });
});
