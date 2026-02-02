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
  initializeWithContent,
  initializeLCA,
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
  sha256,
  // State transition helpers
  loadAndActivate,
  loadToIdle,
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
  doc.getText('contents').insert(0, toText);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

// =============================================================================
// Loading and State Transitions
// =============================================================================

describe('MergeHSM', () => {
  describe('loading', () => {
    test('starts in unloaded state', async () => {
      const t = await createTestHSM();
      expectState(t, 'unloaded');
    });

    test('LOAD transitions to loading.loadingPersistence', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));

      expectState(t, 'loading.loadingPersistence');
    });

    test('PERSISTENCE_LOADED without LCA stays in loading.awaitingLCA', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));

      expectState(t, 'loading.awaitingLCA');
    });

    test('PERSISTENCE_LOADED with LCA and matching disk goes to idle.clean', async () => {
      const t = await createTestHSM({
        disk: { contents: 'hello', mtime: 1000 },
      });

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), await createLCA('hello', 1000)));

      expectState(t, 'idle.clean');
    });

    test('PERSISTENCE_LOADED with disk changes goes to idle.diskAhead', async () => {
      const t = await createTestHSM({
        disk: { contents: 'hello modified', mtime: 2000 },
      });

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), await createLCA('hello', 1000)));

      expectState(t, 'idle.diskAhead');
    });

    test('persisted content is loaded by IndexeddbPersistence (integration)', async () => {
      // With the new architecture, persisted updates are loaded by
      // IndexeddbPersistence attached to localDoc in createYDocs().
      // Use loadAndActivate() to drive through real transitions with content.
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello world');

      expectLocalDocText(t, 'hello world');
    });

    test('pending idle updates are applied to localDoc when entering active mode', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), await createLCA('', 1000)));

      // Receive remote update while in idle mode
      const update = createYjsUpdate('', 'remote content');
      t.send(remoteUpdate(update));

      // Acquire lock - idle updates are applied after persistence 'synced'
      t.send(acquireLock());
      expectState(t, 'active.tracking');

      // localDoc should have the idle update content
      const text = t.getLocalDocText();
      expect(text).not.toBeNull();
      expect(text!.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // loading.awaitingLCA State
  // ===========================================================================

  describe('loading.awaitingLCA', () => {
    test('blocks in awaitingLCA when PERSISTENCE_LOADED has no LCA', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));

      expectState(t, 'loading.awaitingLCA');
      expect(t.hsm.isAwaitingLCA()).toBe(true);
    });

    test('INITIALIZE_WITH_CONTENT transitions to idle.clean', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      expectState(t, 'loading.awaitingLCA');

      const hash = await sha256('hello world');
      t.send(initializeWithContent('hello world', hash, 1000));

      expectState(t, 'idle.clean');
      expect(t.state.lca).not.toBeNull();
      expect(t.state.lca?.contents).toBe('hello world');
    });

    test('INITIALIZE_LCA transitions to idle.clean', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      expectState(t, 'loading.awaitingLCA');

      const hash = await sha256('existing content');
      t.send(initializeLCA('existing content', hash, 2000));

      expectState(t, 'idle.clean');
      expect(t.state.lca).not.toBeNull();
      expect(t.state.lca?.contents).toBe('existing content');
      expect(t.state.lca?.meta.hash).toBe(hash);
      expect(t.state.lca?.meta.mtime).toBe(2000);
    });

    test('ACQUIRE_LOCK during awaitingLCA is deferred until initialized', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      expectState(t, 'loading.awaitingLCA');

      // Try to acquire lock while awaiting LCA
      t.send(acquireLock(''));
      // Still in awaitingLCA - lock acquisition is pending
      expectState(t, 'loading.awaitingLCA');

      // Now initialize
      const hash = await sha256('hello');
      t.send(initializeWithContent('hello', hash, 1000));

      // Wait for persistence.whenSynced promise to resolve
      await Promise.resolve();

      // Should proceed to active mode (lock was pending)
      expectState(t, 'active.tracking');
    });

    test('INITIALIZE_WITH_CONTENT emits SYNC_TO_REMOTE', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.clearEffects();

      const hash = await sha256('hello world');
      t.send(initializeWithContent('hello world', hash, 1000));

      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
    });

    test('auto-transitions to idle.clean when PERSISTENCE_LOADED has LCA', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), await createLCA('content', 1000)));

      expectState(t, 'idle.clean');
    });

    test('isAwaitingLCA returns false when not in awaitingLCA state', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      expect(t.hsm.isAwaitingLCA()).toBe(false);
    });

    // Recovery path tests: ACQUIRE_LOCK when no LCA but local CRDT content exists
    describe('recovery path', () => {
      test('ACQUIRE_LOCK with matching content derives LCA and proceeds to tracking', async () => {
        const content = 'existing content';
        const updates = createYjsUpdate('', content);

        // Mock IndexedDB with the updates
        const t = await createTestHSM({ indexedDBUpdates: updates });

        t.send(load('doc-123', 'notes/test.md'));
        t.send(persistenceLoaded(updates, null));
        expectState(t, 'loading.awaitingLCA');

        // ACQUIRE_LOCK with matching editorContent triggers recovery
        t.send(acquireLock(content));

        // Wait for YDOCS_READY and async LCA creation
        await Promise.resolve();
        await Promise.resolve();

        // Content matches - should derive LCA and proceed to tracking
        expectState(t, 'active.tracking');

        // LCA should be established
        expect(t.state.lca).not.toBeNull();
        expect(t.state.lca?.contents).toBe(content);
      });

      test('ACQUIRE_LOCK with differing content enters conflict.blocked', async () => {
        const localContent = 'local CRDT content';
        const diskContent = 'different disk content';
        const updates = createYjsUpdate('', localContent);

        const t = await createTestHSM({ indexedDBUpdates: updates });

        t.send(load('doc-123', 'notes/test.md'));
        t.send(persistenceLoaded(updates, null));
        expectState(t, 'loading.awaitingLCA');

        // ACQUIRE_LOCK with different editorContent
        t.send(acquireLock(diskContent));

        // Wait for YDOCS_READY
        await Promise.resolve();

        // Content differs with no baseline - should enter conflict
        expectState(t, 'active.conflict.bannerShown');

        // conflictData should have empty base (no LCA for recovery)
        expect(t.hsm.getConflictData()?.base).toBe('');
        expect(t.hsm.getConflictData()?.local).toBe(localContent);
        expect(t.hsm.getConflictData()?.remote).toBe(diskContent);
      });

      test('ACQUIRE_LOCK without local CRDT content stays in awaitingLCA', async () => {
        const t = await createTestHSM();

        t.send(load('doc-123', 'notes/test.md'));
        t.send(persistenceLoaded(new Uint8Array(), null));
        expectState(t, 'loading.awaitingLCA');

        // ACQUIRE_LOCK without local CRDT content - cannot recover
        t.send(acquireLock('some editor content'));

        // Should stay in awaitingLCA - waiting for INITIALIZE_*
        expectState(t, 'loading.awaitingLCA');
      });
    });
  });

  // ===========================================================================
  // Active Mode: Tracking
  // ===========================================================================

  describe('active.tracking', () => {
    test('user edit updates localDoc', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      t.send(cm6Insert(5, ' world', 'hello world'));

      expectLocalDocText(t, 'hello world');
      expectState(t, 'active.tracking');
    });

    test('user edit emits SYNC_TO_REMOTE effect', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      t.send(cm6Insert(5, ' world', 'hello world'));

      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
    });

    test('user edit with isFromYjs=true does not emit SYNC_TO_REMOTE', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');
      t.clearEffects();

      t.send(cm6Change(
        [{ from: 5, to: 5, insert: ' world' }],
        'hello world',
        true // isFromYjs
      ));

      expectNoEffect(t.effects, 'SYNC_TO_REMOTE');
    });

    test('multiple edits each emit SYNC_TO_REMOTE', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, '');
      t.clearEffects();

      t.send(cm6Insert(0, 'a', 'a'));
      t.send(cm6Insert(1, 'b', 'ab'));
      t.send(cm6Insert(2, 'c', 'abc'));

      expectLocalDocText(t, 'abc');
      expect(t.effects.filter(e => e.type === 'SYNC_TO_REMOTE').length).toBe(3);
    });

    test('remote update dispatches to editor', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      // Simulate a remote change by directly modifying remoteDoc
      // (this is what would happen when WebSocket receives an update)
      const remoteDoc = t.hsm.getRemoteDoc()!;
      remoteDoc.getText('contents').insert(5, ' world');

      // Send REMOTE_DOC_UPDATED to trigger the HSM to sync and emit effects
      t.send(remoteDocUpdated());

      expectEffect(t.effects, { type: 'DISPATCH_CM6' });
      expectLocalDocText(t, 'hello world');
    });

    test('remote update DISPATCH_CM6 contains correctly positioned insert changes', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      // Simulate a remote insert at position 5
      const remoteDoc = t.hsm.getRemoteDoc()!;
      remoteDoc.getText('contents').insert(5, ' world');

      t.send(remoteDocUpdated());

      // The delta-based observer should produce an insert at position 5
      const dispatchEffect = t.effects.find(e => e.type === 'DISPATCH_CM6');
      expect(dispatchEffect).toBeDefined();
      expect((dispatchEffect as { type: 'DISPATCH_CM6'; changes: Array<{ from: number; to: number; insert: string }> }).changes).toEqual([
        { from: 5, to: 5, insert: ' world' },
      ]);
    });

    test('remote update DISPATCH_CM6 contains correctly positioned delete changes', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello world');

      // Simulate a remote delete of ' world' (positions 5-11)
      const remoteDoc = t.hsm.getRemoteDoc()!;
      remoteDoc.getText('contents').delete(5, 6);

      t.send(remoteDocUpdated());

      // The delta-based observer should produce a delete from 5 to 11
      const dispatchEffect = t.effects.find(e => e.type === 'DISPATCH_CM6');
      expect(dispatchEffect).toBeDefined();
      expect((dispatchEffect as { type: 'DISPATCH_CM6'; changes: Array<{ from: number; to: number; insert: string }> }).changes).toEqual([
        { from: 5, to: 11, insert: '' },
      ]);
      expectLocalDocText(t, 'hello');
    });

    test('CM6_CHANGE updates lastKnownEditorText in tracking state', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      // Send CM6_CHANGE to update lastKnownEditorText
      t.send(cm6Insert(5, ' world', 'hello world'));

      // Drift detection should find no drift since editor matches localDoc
      expect(t.hsm.checkAndCorrectDrift()).toBe(false);
    });

    test('SAVE_COMPLETE updates LCA mtime', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: 1000 });

      t.send(saveComplete(2000));

      expect(t.state.lca?.meta.mtime).toBe(2000);
    });

    test('SAVE_COMPLETE updates LCA hash and disk state (BUG-006)', async () => {
      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello',
        lca: await createLCA('hello', 1000),
        disk: { contents: 'hello', mtime: 1000 },
      });

      // Send SAVE_COMPLETE with new mtime and hash
      t.send(saveComplete(2000, 'new-hash-after-save'));

      // LCA should have updated mtime and hash
      expect(t.state.lca?.meta.mtime).toBe(2000);
      expect(t.state.lca?.meta.hash).toBe('new-hash-after-save');

      // Disk state should also be updated to match
      expect(t.state.disk?.mtime).toBe(2000);
      expect(t.state.disk?.hash).toBe('new-hash-after-save');
    });

    test('SAVE_COMPLETE prevents subsequent pollAll from triggering merge (BUG-006 + BUG-007)', async () => {
      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello world',
        lca: await createLCA('hello world', 1000),
        disk: { contents: 'hello world', mtime: 1000 },
      });

      // Simulate save completing with new mtime/hash
      t.send(saveComplete(2000, 'saved-content-hash'));

      // Both LCA and disk should now have the same mtime/hash
      expect(t.state.lca?.meta.mtime).toBe(2000);
      expect(t.state.lca?.meta.hash).toBe('saved-content-hash');
      expect(t.state.disk?.mtime).toBe(2000);
      expect(t.state.disk?.hash).toBe('saved-content-hash');

      // Should still be in tracking state (no unnecessary merge triggered)
      expect(t.state.statePath).toBe('active.tracking');
    });
  });

  // ===========================================================================
  // Active Mode: Lock Management
  // ===========================================================================

  describe('lock management', () => {
    test('ACQUIRE_LOCK from idle auto-transitions to active.tracking (offline-first)', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), await createLCA('', 1000)));
      t.send(acquireLock());

      // Per spec: "This transition is based entirely on LOCAL state.
      // Provider sync happens asynchronously and does not block.
      // The editor must be usable immediately, even when offline."
      expectState(t, 'active.tracking');
    });

    test('YDOCS_READY is a no-op since auto-transition already happened', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), await createLCA('', 1000)));
      t.send(acquireLock());
      expectState(t, 'active.tracking');

      // Sending YDOCS_READY should be a no-op (backward compatibility)
      t.send(yDocsReady());
      expectState(t, 'active.tracking');
    });

    test('RELEASE_LOCK transitions back to idle', async () => {
      // Go through proper loading flow to get consistent state
      const t = await createTestHSM();
      t.send(load('doc-1', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), await createLCA('hello', 1000)));
      t.send(acquireLock('hello'));
      expectState(t, 'active.tracking');

      t.send(releaseLock());
      await t.hsm.awaitCleanup();

      expectState(t, 'idle.clean');
      expect(t.getLocalDocText()).toBeNull();
    });

    test('HSM continues to process events after RELEASE_LOCK', async () => {
      // Go through proper loading flow
      const t = await createTestHSM();
      t.send(load('doc-1', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), await createLCA('hello', 1000)));
      t.send(acquireLock('hello'));
      expectState(t, 'active.tracking');

      t.send(releaseLock());
      await t.hsm.awaitCleanup();
      expectState(t, 'idle.clean');
      t.clearEffects();

      // Should still process events in idle mode
      // Disk change with no remote changes will auto-merge back to clean
      t.send(await diskChanged('hello world', 2000));

      // Auto-merge happened - verify SYNC_TO_REMOTE was emitted
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
      expectState(t, 'idle.clean');

      // Can acquire lock again - auto-transitions to tracking (offline-first)
      t.send(acquireLock());
      expectState(t, 'active.tracking');
    });

    // Note: This test uses forTesting because real state transitions create
    // different internal state vectors that cause idle.localAhead after release.
    test('multiple ACQUIRE_LOCK/RELEASE_LOCK cycles work correctly', async () => {
      const t = await createTestHSM({
        initialState: 'idle.clean',
        lca: await createLCA('hello', 1000),
      });

      // First cycle - auto-transitions to tracking (offline-first)
      t.send(acquireLock('hello'));
      expectState(t, 'active.tracking');
      t.send(releaseLock());
      await t.hsm.awaitCleanup();
      expectState(t, 'idle.clean');

      // Second cycle
      t.send(acquireLock('hello'));
      expectState(t, 'active.tracking');
      t.send(releaseLock());
      await t.hsm.awaitCleanup();
      expectState(t, 'idle.clean');

      // Third cycle - should still work
      t.send(acquireLock('hello'));
      expectState(t, 'active.tracking');
    });

    test('isActive and isIdle helper methods work correctly', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      expect(t.hsm.isIdle()).toBe(true);
      expect(t.hsm.isActive()).toBe(false);

      t.send(acquireLock());

      expect(t.hsm.isIdle()).toBe(false);
      expect(t.hsm.isActive()).toBe(true);

      t.send(releaseLock());
      await t.hsm.awaitCleanup();

      expect(t.hsm.isIdle()).toBe(true);
      expect(t.hsm.isActive()).toBe(false);
    });

    test('transitions to active.tracking even when offline (offline-first)', async () => {
      // Spec: "Provider sync happens asynchronously and does not block.
      //  The editor must be usable immediately, even when offline."
      const t = await createTestHSM();

      t.send(load('doc-123', 'notes/test.md'));
      t.send(persistenceLoaded(new Uint8Array(), await createLCA('', 1000)));

      // Simulate going offline BEFORE acquiring lock
      t.send(disconnected());

      // Acquire lock while offline
      t.send(acquireLock());

      // Should still reach tracking state - network doesn't block
      expectState(t, 'active.tracking');

      // User can edit while offline
      t.send(cm6Insert(0, 'hello', 'hello'));
      expectLocalDocText(t, 'hello');

      // SYNC_TO_REMOTE should still be emitted (queued for when online)
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
    });
  });

  // ===========================================================================
  // Active Mode: Disk Changes
  // ===========================================================================

  describe('disk changes in active mode', () => {
    test('active mode NEVER emits WRITE_DISK (Obsidian handles disk writes)', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: 1000 });

      // Trigger various active mode operations
      t.send(cm6Insert(5, ' world', 'hello world'));
      t.send(await diskChanged('hello external', 2000)); // This triggers merge
      t.send(saveComplete(3000));

      // Verify NO WRITE_DISK effects were emitted in active mode
      const writeDiskEffects = t.effects.filter(e => e.type === 'WRITE_DISK');
      expect(writeDiskEffects.length).toBe(0);
    });

    test('DISK_CHANGED with identical content stays in tracking', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: Date.now() - 1000 });

      t.send(await diskChanged('hello', Date.now()));

      // Same content - no merge needed, stay in tracking
      expectState(t, 'active.tracking');
    });

    test('DISK_CHANGED with disk-only changes stays in tracking (Obsidian handles sync)', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: Date.now() - 1000 });

      t.send(await diskChanged('hello world', Date.now()));

      // In active.tracking, Obsidian handles disk->editor sync via diff-match-patch.
      // HSM stays in tracking and doesn't modify localDoc.
      expectState(t, 'active.tracking');
      expectLocalDocText(t, 'hello'); // localDoc unchanged - Obsidian handles sync
    });

    test('DISK_CHANGED with conflicting changes stays in tracking (Obsidian handles sync)', async () => {
      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello local',
        lca: await createLCA('hello', Date.now() - 1000),
      });

      t.send(await diskChanged('hello disk', Date.now()));

      // In active.tracking, Obsidian handles disk->editor sync.
      // HSM does NOT trigger conflict - stays in tracking.
      expectState(t, 'active.tracking');
    });
  });

  // ===========================================================================
  // Active Mode: Conflict Resolution
  // ===========================================================================

  describe('conflict resolution', () => {
    test('MERGE_CONFLICT transitions to active.conflict.bannerShown', async () => {
      const t = await createTestHSM({
        initialState: 'active.merging',
        localDoc: 'hello local',
      });

      t.send(mergeConflict('hello', 'hello local', 'hello remote'));

      expectState(t, 'active.conflict.bannerShown');
    });

    test('OPEN_DIFF_VIEW transitions to active.conflict.resolving', async () => {
      const t = await createTestHSM({
        initialState: 'active.conflict.bannerShown',
        localDoc: 'hello local',
      });

      t.send(openDiffView());

      expectState(t, 'active.conflict.resolving');
    });

    test('RESOLVE_ACCEPT_DISK returns to tracking', async () => {
      const t = await createTestHSM({
        initialState: 'active.conflict.resolving',
        localDoc: 'hello local',
      });

      t.send(resolveAcceptDisk());

      expectState(t, 'active.tracking');
    });

    test('RESOLVE_ACCEPT_LOCAL returns to tracking', async () => {
      const t = await createTestHSM({
        initialState: 'active.conflict.resolving',
        localDoc: 'hello local',
      });

      t.send(resolveAcceptLocal());

      expectState(t, 'active.tracking');
    });

    test('DISMISS_CONFLICT defers and returns to tracking', async () => {
      const t = await createTestHSM({
        initialState: 'active.conflict.bannerShown',
        localDoc: 'hello local',
        disk: { contents: 'hello disk', mtime: 1000 },
      });

      t.send(dismissConflict());

      expectState(t, 'active.tracking');
      expect(t.state.deferredConflict).toBeDefined();
    });

    test('RESOLVE_ACCEPT_DISK applies disk content to localDoc', async () => {
      const t = await createTestHSM({
        initialState: 'active.merging',
        localDoc: 'hello local',
        lca: await createLCA('hello', Date.now() - 1000),
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

    test('RESOLVE_ACCEPT_LOCAL keeps localDoc unchanged', async () => {
      const t = await createTestHSM({
        initialState: 'active.merging',
        localDoc: 'hello local',
        lca: await createLCA('hello', Date.now() - 1000),
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

    test('RESOLVE_ACCEPT_MERGED applies merged content', async () => {
      const t = await createTestHSM({
        initialState: 'active.merging',
        localDoc: 'hello local',
        lca: await createLCA('hello', Date.now() - 1000),
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

    test('CANCEL from resolving returns to bannerShown', async () => {
      const t = await createTestHSM({
        initialState: 'active.conflict.resolving',
        localDoc: 'hello local',
      });

      t.send(cancel());

      expectState(t, 'active.conflict.bannerShown');
    });

    test('ACQUIRE_LOCK from idle.diverged goes to conflict.bannerShown', async () => {
      const t = await createTestHSM({
        initialState: 'idle.diverged',
        lca: await createLCA('original', 1000),
        disk: { contents: 'disk changed', mtime: 2000 },
      });

      // v6: Pass editorContent (disk content) with ACQUIRE_LOCK to fix BUG-022
      t.send(acquireLock('disk changed'));

      // Should go through blocked and immediately to bannerShown
      expectState(t, 'active.conflict.bannerShown');
      // YDocs should be created
      expect(t.hsm.getLocalDoc()).not.toBeNull();

      // v6: Verify conflictData.remote is populated (fixes BUG-022)
      const conflictData = t.hsm.getConflictData();
      expect(conflictData).not.toBeNull();
      expect(conflictData!.remote).toBe('disk changed');
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('error handling', () => {
    test('ERROR in idle mode transitions to idle.error', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      const testError = new Error('Test error');
      t.send(error(testError));

      expectState(t, 'idle.error');
      expect(t.state.error).toBe(testError);
    });

    test('ERROR in active mode stores error but stays in state', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      const testError = new Error('Test error');
      t.send(error(testError));

      // Active mode doesn't transition to error state (spec doesn't define this)
      expectState(t, 'active.tracking');
      expect(t.state.error).toBe(testError);
    });

    test('getSyncStatus returns error status when in error state', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      t.send(error(new Error('Test error')));

      const status = t.hsm.getSyncStatus();
      expect(status.status).toBe('error');
    });
  });

  // ===========================================================================
  // Network Events
  // ===========================================================================

  describe('network events', () => {
    test('CONNECTED event is handled in active.tracking', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      t.send(connected());

      // Should stay in tracking (network events don't cause state transitions)
      expectState(t, 'active.tracking');
    });

    test('DISCONNECTED event is handled in active.tracking', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      t.send(disconnected());

      // Should stay in tracking
      expectState(t, 'active.tracking');
    });

    test('PROVIDER_SYNCED event is handled in active.tracking', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      t.send(providerSynced());

      // Should stay in tracking
      expectState(t, 'active.tracking');
    });

    test('network events work in idle mode too', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

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
    test('checkAndCorrectDrift returns false when no drift', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      // Simulate an editor change that matches localDoc
      t.send(cm6Insert(5, ' world', 'hello world'));
      t.clearEffects();

      // Check for drift - should be none
      const driftDetected = t.hsm.checkAndCorrectDrift();

      expect(driftDetected).toBe(false);
      expectNoEffect(t.effects, 'DISPATCH_CM6');
    });

    test('checkAndCorrectDrift detects and corrects drift', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      // Simulate editor reporting one thing
      t.send(cm6Insert(5, ' world', 'hello world'));
      t.clearEffects();

      // But localDoc has different content (simulating drift/bug)
      // Manually modify localDoc without going through CM6
      const localDoc = t.hsm.getLocalDoc()!;
      localDoc.getText('contents').delete(5, 6); // Remove " world"
      localDoc.getText('contents').insert(5, ' universe');

      // Now check drift - should detect and correct
      const driftDetected = t.hsm.checkAndCorrectDrift();

      expect(driftDetected).toBe(true);
      expectEffect(t.effects, { type: 'DISPATCH_CM6' });
    });

    test('checkAndCorrectDrift only works in active.tracking', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      const driftDetected = t.hsm.checkAndCorrectDrift();

      expect(driftDetected).toBe(false);
    });
  });

  // ===========================================================================
  // Idle Mode: Remote Updates
  // ===========================================================================

  describe('idle mode', () => {
    test('REMOTE_UPDATE in idle transitions to idle.remoteAhead', async () => {
      // Create a test starting in idle.clean
      const t = await createTestHSM();
      await loadToIdle(t);

      const update = createYjsUpdate('', 'hello');
      t.send(remoteUpdate(update));

      expectState(t, 'idle.remoteAhead');
    });

    test('DISK_CHANGED in idle transitions to idle.diskAhead', async () => {
      // Note: This test uses forTesting to skip auto-merge behavior.
      // With real transitions, disk changes auto-merge when remote==LCA.
      const t = await createTestHSM({ initialState: 'idle.clean' });

      t.send(await diskChanged('modified content', Date.now()));

      expectState(t, 'idle.diskAhead');
    });

    test('idle mode does not create YDocs (lightweight)', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      // Verify no YDocs exist in idle mode
      expect(t.getLocalDocText()).toBeNull();
      expect(t.getRemoteDocText()).toBeNull();

      // Receive remote update - should still not create YDocs
      const update = createYjsUpdate('', 'hello');
      t.send(remoteUpdate(update));

      expect(t.getLocalDocText()).toBeNull();
      expect(t.getRemoteDocText()).toBeNull();
    });

    test('ACQUIRE_LOCK creates YDocs for active mode', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      // No YDocs before
      expect(t.getLocalDocText()).toBeNull();

      t.send(acquireLock());

      // YDocs created after ACQUIRE_LOCK
      expect(t.hsm.getLocalDoc()).not.toBeNull();
      expect(t.hsm.getRemoteDoc()).not.toBeNull();
    });

    test('idle.remoteAhead auto-merges when disk==lca', async () => {
      const t = await createTestHSM({
        initialState: 'idle.clean',
        lca: await createLCA('hello', 1000),
        disk: { contents: 'hello', mtime: 1000 }, // disk matches LCA
      });
      t.clearEffects();

      // Remote update arrives
      const update = createYjsUpdate('hello', 'hello world');
      t.send(remoteUpdate(update));

      // Wait for async idle auto-merge to complete (BUG-021 fix made this async)
      await t.hsm.awaitIdleAutoMerge();

      // Should auto-merge and emit WRITE_DISK
      expectEffect(t.effects, { type: 'WRITE_DISK' });
      expectState(t, 'idle.clean');
    });

    test('idle.diskAhead auto-merges when remote==lca', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'hello', mtime: 1000 });
      t.clearEffects();

      // Disk changes externally
      t.send(await diskChanged('hello world', 2000));

      // Should auto-merge and emit SYNC_TO_REMOTE
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
      expectState(t, 'idle.clean');
    });

    test('idle.diverged auto-merges when no conflicts', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'line1\nline2\nline3', mtime: 1000 });

      // First, remote update changes line1
      const update = createYjsUpdate('line1\nline2\nline3', 'REMOTE\nline2\nline3');
      t.send(remoteUpdate(update));

      // Then disk changes line3 - diverged but mergeable
      t.send(await diskChanged('line1\nline2\nDISK', 2000));

      // Wait for async 3-way merge to complete
      await t.awaitIdleAutoMerge();

      // 3-way merge should succeed - back to clean
      expectState(t, 'idle.clean');
      expectEffect(t.effects, { type: 'WRITE_DISK' });
    });

    test('idle.diverged stays diverged when merge has conflicts', async () => {
      // Start with disk already changed from LCA, so when remote arrives,
      // auto-merge won't succeed (disk != lca)
      const t = await createTestHSM({
        initialState: 'idle.diskAhead',
        lca: await createLCA('original line', 1000),
        disk: { contents: 'disk changed this', mtime: 2000 },
      });

      // Remote update changes the same line - creates a conflict
      const update = createYjsUpdate('original line', 'remote changed this');
      t.send(remoteUpdate(update));

      // Should be in diverged state (3-way merge has conflict on same line)
      // The merge will fail because both sides changed the same line
      expectState(t, 'idle.diverged');
    });

    // BUG-021: Empty/uninitialized remote CRDT should not cause data loss
    test('empty remote update does not overwrite local content (BUG-021)', async () => {
      // Simulate the scenario from BUG-021:
      // - Local has content stored in IndexedDB
      // - Remote sends empty updates (remoteLen=0)
      // - The merge should preserve local content, not overwrite with empty

      const t = await createTestHSM({
        initialState: 'idle.clean',
        lca: await createLCA('local content', 1000),
        disk: { contents: 'local content', mtime: 1000 },
      });

      // Note: In this test, the default loadUpdatesRaw returns empty array.
      // This simulates when there's no IndexedDB (test environment).
      // In production, loadUpdatesRaw would return the actual local updates.

      // Create an empty update (represents uninitialized remote CRDT)
      const emptyDoc = new Y.Doc();
      const emptyUpdate = Y.encodeStateAsUpdate(emptyDoc);
      emptyDoc.destroy();

      t.clearEffects();
      t.send(remoteUpdate(emptyUpdate));

      await t.hsm.awaitIdleAutoMerge();

      // The HSM should recognize that the remote had nothing new
      // and should NOT emit WRITE_DISK with empty content
      const writeDiskEffects = t.effects.filter(e => e.type === 'WRITE_DISK');

      // Either no WRITE_DISK (remote had nothing new) or WRITE_DISK with original content
      if (writeDiskEffects.length > 0) {
        const writeEffect = writeDiskEffects[0] as { type: 'WRITE_DISK'; contents: string };
        // If we do write, it should NOT be empty - it should preserve local content
        expect(writeEffect.contents).not.toBe('');
      }

      // Should transition back to clean (not stuck in error state)
      expectState(t, 'idle.clean');
    });

    // BUG-021: When local has content in IndexedDB, empty remote should preserve it
    test('empty remote update preserves local IndexedDB content (BUG-021 full scenario)', async () => {
      // Create a Yjs update representing "local content exists in IndexedDB"
      const localDoc = new Y.Doc();
      localDoc.getText('contents').insert(0, 'Line 1\nLine 2\nLine 3');
      const localUpdate = Y.encodeStateAsUpdate(localDoc);
      localDoc.destroy();

      // Mock loadUpdatesRaw to return the local update (simulates IndexedDB content)
      const mockLoadUpdatesRaw = async (_vaultId: string) => [localUpdate];

      const t = await createTestHSM({
        initialState: 'idle.clean',
        lca: await createLCA('Line 1\nLine 2\nLine 3', 1000),
        disk: { contents: 'Line 1\nLine 2\nLine 3', mtime: 1000 },
        loadUpdatesRaw: mockLoadUpdatesRaw,
      });

      // Create an empty update (represents uninitialized remote CRDT)
      const emptyDoc = new Y.Doc();
      const emptyUpdate = Y.encodeStateAsUpdate(emptyDoc);
      emptyDoc.destroy();

      t.clearEffects();
      t.send(remoteUpdate(emptyUpdate));

      await t.hsm.awaitIdleAutoMerge();

      // When local has content and remote is empty, the merge should:
      // 1. Merge local + remote updates
      // 2. See that the merged content equals local content
      // 3. Either skip writing (no change) or write the preserved content

      const writeDiskEffects = t.effects.filter(e => e.type === 'WRITE_DISK');
      if (writeDiskEffects.length > 0) {
        const writeEffect = writeDiskEffects[0] as { type: 'WRITE_DISK'; contents: string };
        // The written content should be the LOCAL content, not empty
        expect(writeEffect.contents).toBe('Line 1\nLine 2\nLine 3');
      }

      expectState(t, 'idle.clean');
    });

    // BUG-021: Remote with new content should merge with local IndexedDB content
    test('remote update merges correctly with local IndexedDB content (BUG-021)', async () => {
      // Create a Yjs update representing local content in IndexedDB
      const localDoc = new Y.Doc();
      localDoc.getText('contents').insert(0, 'Line 1\nLine 2\nLine 3');
      const localUpdate = Y.encodeStateAsUpdate(localDoc);
      localDoc.destroy();

      // Mock loadUpdatesRaw to return the local update
      const mockLoadUpdatesRaw = async (_vaultId: string) => [localUpdate];

      const t = await createTestHSM({
        initialState: 'idle.clean',
        lca: await createLCA('original', 1000),
        disk: { contents: 'original', mtime: 1000 },
        loadUpdatesRaw: mockLoadUpdatesRaw,
      });

      // Create a remote update with different content
      const remoteDoc = new Y.Doc();
      remoteDoc.getText('contents').insert(0, 'Remote Content');
      const remoteUpdateData = Y.encodeStateAsUpdate(remoteDoc);
      remoteDoc.destroy();

      t.clearEffects();
      t.send(remoteUpdate(remoteUpdateData));

      await t.hsm.awaitIdleAutoMerge();

      // The merge should combine local and remote updates
      const writeDiskEffects = t.effects.filter(e => e.type === 'WRITE_DISK');
      expect(writeDiskEffects.length).toBe(1);

      const writeEffect = writeDiskEffects[0] as { type: 'WRITE_DISK'; contents: string };
      // The merged content should include both local and remote
      // Since both are full state updates to 'contents', the merge behavior depends on
      // Yjs conflict resolution (last-writer-wins by client ID)
      expect(writeEffect.contents.length).toBeGreaterThan(0);

      expectState(t, 'idle.clean');
    });
  });

  // ===========================================================================
  // Sync Status
  // ===========================================================================

  describe('getSyncStatus', () => {
    test('returns synced status in idle.clean', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { guid: 'doc-123', path: 'test.md' });

      const status = t.hsm.getSyncStatus();

      expect(status.guid).toBe('doc-123');
      expect(status.path).toBe('test.md');
      expect(status.status).toBe('synced');
    });

    test('returns synced status in active.tracking', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      const status = t.hsm.getSyncStatus();

      expect(status.status).toBe('synced');
    });

    test('returns pending status in idle.remoteAhead', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);
      // Send a remote update to transition to idle.remoteAhead
      const update = createYjsUpdate('', 'remote content');
      t.send(remoteUpdate(update));
      expectState(t, 'idle.remoteAhead');

      const status = t.hsm.getSyncStatus();

      expect(status.status).toBe('pending');
    });

    test('returns conflict status in active.conflict.bannerShown', async () => {
      const t = await createTestHSM({ initialState: 'active.conflict.bannerShown', localDoc: 'hello' });

      const status = t.hsm.getSyncStatus();

      expect(status.status).toBe('conflict');
    });
  });

  // ===========================================================================
  // Persistence Effects
  // ===========================================================================

  describe('persistence effects', () => {
    test('SAVE_COMPLETE emits PERSIST_STATE', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: 1000 });
      t.clearEffects();

      t.send(saveComplete(2000));

      expectEffect(t.effects, { type: 'PERSIST_STATE' });
    });

    test('DISMISS_CONFLICT emits PERSIST_STATE', async () => {
      const t = await createTestHSM({
        initialState: 'active.conflict.bannerShown',
        localDoc: 'hello',
        disk: { contents: 'hello disk', mtime: 1000 },
      });
      t.clearEffects();

      t.send(dismissConflict());

      expectEffect(t.effects, { type: 'PERSIST_STATE' });
    });

    test('DISK_CHANGED matching editor emits PERSIST_STATE (LCA update)', async () => {
      const t = await createTestHSM({
        initialState: 'active.tracking',
        localDoc: 'hello world',
        lca: await createLCA('hello', 1000),
      });
      t.clearEffects();

      // Disk now matches editor content - opportunistic LCA update
      t.send(await diskChanged('hello world', Date.now()));

      // Wait for async LCA creation
      await new Promise(resolve => setTimeout(resolve, 10));

      expectEffect(t.effects, { type: 'PERSIST_STATE' });
    });

    test('STATUS_CHANGED emitted on state transition that changes sync status', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'hello', mtime: 1000 });
      t.clearEffects();

      // Receiving remote update changes status from synced to pending
      const update = createYjsUpdate('', 'hello world');
      t.send(remoteUpdate(update));

      expectEffect(t.effects, { type: 'STATUS_CHANGED' });
    });
  });

  // ===========================================================================
  // Snapshot (for future recording)
  // ===========================================================================

  describe('snapshot', () => {
    test('creates serializable snapshot', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: 1000 });

      const snapshot = t.snapshot();

      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.state.guid).toBe('test-guid');
      expect(snapshot.state.statePath).toBe('active.tracking');
      expect(snapshot.localDocText).toBe('hello');
      expect(snapshot.state.lca?.contents).toBe('hello');
    });

    test('snapshot is JSON serializable', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'test content');

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
    test('tracks state transitions (one per event)', async () => {
      const t = await createTestHSM();

      t.send(load('doc-123', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), await createLCA('', 1000)));

      // State history tracks one transition per event (final state per event)
      // LOAD: unloaded → loading.loadingPersistence
      // PERSISTENCE_LOADED: loading.loadingPersistence → idle.clean (via awaitingLCA → ready internally)
      expect(t.stateHistory.length).toBe(2);
      expect(t.stateHistory[0].to).toBe('loading.loadingPersistence');
      expect(t.stateHistory[1].to).toBe('idle.clean');
    });
  });
});
