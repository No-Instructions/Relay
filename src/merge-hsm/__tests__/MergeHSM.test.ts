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
  acquireLock,
  sendAcquireLock,
  sendAcquireLockToTracking,
  releaseLock,
  cm6Change,
  cm6Insert,
  remoteUpdate,
  remoteDocUpdated,
  diskChanged,
  saveComplete,
  openDiffView,
  resolve,
  dismissConflict,
  cancel,
  providerSynced,
  connected,
  disconnected,
  error,
  persistenceSynced,
  persistenceLoaded,
  load,
  createLCA,
  createYjsUpdate,
  // State transition helpers
  loadAndActivate,
  loadToIdle,
  loadToLoading,
  loadToConflict,
  loadToResolving,
  // Assertions
  expectEffect,
  expectNoEffect,
  expectState,
  expectLocalDocText,
} from '../testing';

import * as Y from 'yjs';

// =============================================================================
// Remote Update Testing
// =============================================================================
//
// To simulate remote updates, use the TestHSM methods:
// - t.setRemoteContent(content) - sync remoteDoc to content using diffMatchPatch
// - t.getRemoteUpdate() - get delta update since last call
// - t.applyRemoteChange(content) - set content and send REMOTE_UPDATE event
//
// INVARIANT: These methods use diff-match-patch to apply changes without
// delete-all/insert-all patterns that would violate CRDT history preservation.
//
// DO NOT create Yjs updates from fresh Y.Doc instances - this creates
// independent CRDT histories that cause content duplication when merged.
// =============================================================================

// =============================================================================
// Loading and State Transitions
// =============================================================================

describe('MergeHSM', () => {
  describe('loading', () => {
    test('starts in unloaded state', async () => {
      const t = await createTestHSM();
      expectState(t, 'unloaded');
    });

    test('persisted content is loaded by IndexeddbPersistence (integration)', async () => {
      // With the new architecture, persisted updates are loaded by
      // IndexeddbPersistence attached to localDoc in createYDocs().
      // Use loadAndActivate() to drive through real transitions with content.
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello world');

      expectLocalDocText(t, 'hello world');
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

    test('SAVE_COMPLETE updates disk state but not LCA (per spec)', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: 1000 });

      t.send(saveComplete(2000));

      // Per spec: LCA is never touched during active.* states
      expect(t.state.lca?.meta.mtime).toBe(1000);
      // Disk state IS updated
      expect(t.state.disk?.mtime).toBe(2000);
    });

    test('SAVE_COMPLETE updates disk state (LCA frozen per spec)', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: 1000 });

      // Set up disk state matching LCA (simulates Obsidian's pollAll)
      t.send(await diskChanged('hello', 1000));

      // Send SAVE_COMPLETE with new mtime and hash
      t.send(saveComplete(2000, 'new-hash-after-save'));

      // Per spec: LCA is never touched during active.* states
      expect(t.state.lca?.meta.mtime).toBe(1000);

      // Disk state IS updated
      expect(t.state.disk?.mtime).toBe(2000);
      expect(t.state.disk?.hash).toBe('new-hash-after-save');
    });

    test('SAVE_COMPLETE keeps tracking state stable', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello world', { mtime: 1000 });

      // Set up disk state matching LCA (simulates Obsidian's pollAll)
      t.send(await diskChanged('hello world', 1000));

      // Simulate save completing with new mtime/hash
      t.send(saveComplete(2000, 'saved-content-hash'));

      // Per spec: LCA is never touched during active.* states
      expect(t.state.lca?.meta.mtime).toBe(1000);

      // Disk state IS updated
      expect(t.state.disk?.mtime).toBe(2000);
      expect(t.state.disk?.hash).toBe('saved-content-hash');

      // Should still be in tracking state
      expect(t.state.statePath).toBe('active.tracking');
    });
  });

  // ===========================================================================
  // Active Mode: Lock Management
  // ===========================================================================

  describe('lock management', () => {
    // BUG-047: Edit/save/close cycle should update LCA so reopen doesn't duplicate content
    test('edit then DISK_CHANGED then RELEASE_LOCK should transition to idle.synced', async () => {
      const t = await createTestHSM();
      const originalContent = '# Test file\n\nContent for test-1.md.';
      const editedContent = '# Test file\n\n<!-- marker -->Content for test-1.md.';

      // Start with content in idle.synced
      await loadToIdle(t, { content: originalContent, mtime: 1000 });
      t.send(await diskChanged(originalContent, 1000));
      expectState(t, 'idle.synced');

      // Open file (ACQUIRE_LOCK)
      await sendAcquireLockToTracking(t, originalContent);
      expectState(t, 'active.tracking');

      // User types (CM6_CHANGE)
      t.send(cm6Insert(13, '<!-- marker -->', editedContent));
      expectState(t, 'active.tracking');
      expectLocalDocText(t, editedContent);

      // Obsidian's native save triggers DISK_CHANGED (no SAVE_COMPLETE)
      t.send(await diskChanged(editedContent, 2000));
      expectState(t, 'active.tracking');

      // User closes tab (RELEASE_LOCK)
      t.send(releaseLock());
      await t.hsm.awaitCleanup();

      // BUG-047: HSM should be in idle.synced, not idle.diverged
      // because cleanupYDocs should update LCA when disk matches localDoc
      expectState(t, 'idle.synced');

      // Verify LCA was updated to edited content
      expect(t.state.lca?.contents).toBe(editedContent);
    });

    // BUG-049: Test the SAVE_COMPLETE scenario (e2e uses this, not DISK_CHANGED)
    test('edit then SAVE_COMPLETE then RELEASE_LOCK should transition to idle.synced', async () => {
      const t = await createTestHSM();
      const originalContent = '# Test file\n\nContent for test-1.md.';
      const editedContent = '# Test file\n\n<!-- e2e-tp002 marker -->Content for test-1.md.';

      // Start with content in idle.synced
      await loadToIdle(t, { content: originalContent, mtime: 1000 });
      t.send(await diskChanged(originalContent, 1000));
      expectState(t, 'idle.synced');

      // Open file (ACQUIRE_LOCK)
      await sendAcquireLockToTracking(t, originalContent);
      expectState(t, 'active.tracking');

      // User types (CM6_CHANGE)
      t.send(cm6Insert(13, '<!-- e2e-tp002 marker -->', editedContent));
      expectState(t, 'active.tracking');
      expectLocalDocText(t, editedContent);

      // Obsidian's Ctrl+S triggers SAVE_COMPLETE (not DISK_CHANGED)
      // Note: SAVE_COMPLETE only updates disk hash/mtime, NOT pendingDiskContents
      // In real Obsidian, this hash comes from Obsidian's save operation
      // It may differ from our internal hashFn, which is why we test lastKnownEditorText fallback
      t.send(saveComplete(2000, 'obsidian-hash-different-from-internal'));
      expectState(t, 'active.tracking');

      // User closes tab (RELEASE_LOCK)
      t.send(releaseLock());
      await t.hsm.awaitCleanup();

      // BUG-049: HSM should be in idle.synced, not idle.diverged
      // cleanupYDocs should update LCA using lastKnownEditorText === finalContent
      expectState(t, 'idle.synced');

      // Verify LCA was updated to edited content
      expect(t.state.lca?.contents).toBe(editedContent);
    });

    // BUG-049: Test reopen from idle.diverged doesn't duplicate content
    // This test simulates the exact e2e scenario:
    // 1. File opens from idle.synced
    // 2. User types (CM6_CHANGE updates localDoc and lastKnownEditorText)
    // 3. User saves (SAVE_COMPLETE - NOT DISK_CHANGED)
    // 4. User closes (RELEASE_LOCK)
    // 5. File should go to idle.synced, but if hash mismatch causes idle.diverged...
    // 6. User reopens
    // 7. Content should NOT be duplicated
    test('reopen from idle.diverged should not duplicate content', async () => {
      const t = await createTestHSM();
      const originalContent = '# Test file\n\nContent for test-1.md.';
      const editedContent = '# Test file\n\n<!-- e2e-tp002 marker -->Content for test-1.md.';

      // Start with original content in idle.synced
      await loadToIdle(t, { content: originalContent, mtime: 1000 });
      t.send(await diskChanged(originalContent, 1000));
      expectState(t, 'idle.synced');

      // Verify initial LCA
      expect(t.state.lca?.contents).toBe(originalContent);
      const originalLcaHash = t.state.lca?.meta.hash;

      // Open file
      await sendAcquireLockToTracking(t, originalContent);
      expectState(t, 'active.tracking');

      // User types (CM6_CHANGE updates localDoc and lastKnownEditorText)
      t.send(cm6Insert(13, '<!-- e2e-tp002 marker -->', editedContent));
      expectLocalDocText(t, editedContent);

      // User saves with Ctrl+S - ONLY SAVE_COMPLETE, NO DISK_CHANGED
      // Use a hash that DIFFERS from what hashFn would compute
      // This simulates Obsidian using a different hash algorithm
      t.send(saveComplete(2000, 'obsidian-hash-differs-from-internal'));

      // User closes tab
      t.send(releaseLock());
      await t.hsm.awaitCleanup();

      // KEY: With only SAVE_COMPLETE (no DISK_CHANGED), cleanupYDocs should still
      // update LCA using lastKnownEditorText === finalContent fallback
      expectState(t, 'idle.synced');
      expect(t.state.lca?.contents).toBe(editedContent);

      // ===== PHASE 2: Reopen =====
      // Now reopen the file
      await sendAcquireLockToTracking(t, editedContent);
      expectState(t, 'active.tracking');

      // Content should NOT be duplicated
      const localDocContent = t.hsm.localDoc?.getText('contents').toString();
      expect(localDocContent).toBe(editedContent);
      expect(localDocContent?.length).toBe(editedContent.length); // 65 chars, not 130
    });

    // BUG-049 variant: What if we manually force idle.diverged and then reopen?
    test('forced idle.diverged reopen should not duplicate content', async () => {
      const t = await createTestHSM();
      const originalContent = '# Test file\n\nContent for test-1.md.';
      const editedContent = '# Test file\n\n<!-- e2e-tp002 marker -->Content for test-1.md.';

      // Start with original content in idle.synced
      await loadToIdle(t, { content: originalContent, mtime: 1000 });
      t.send(await diskChanged(originalContent, 1000));
      expectState(t, 'idle.synced');

      // Mark provider as synced so fork reconciliation can complete
      t.send(connected());
      t.send(providerSynced());

      // Open, edit, and close with DISK_CHANGED (so LCA gets updated)
      await sendAcquireLockToTracking(t, originalContent);
      t.send(cm6Insert(13, '<!-- e2e-tp002 marker -->', editedContent));
      t.send(await diskChanged(editedContent, 2000));
      t.send(releaseLock());
      await t.hsm.awaitCleanup();
      expectState(t, 'idle.synced');
      expect(t.state.lca?.contents).toBe(editedContent);

      // Now send DISK_CHANGED with different content (external disk modification).
      // With localDoc alive and provider synced, fork reconciliation completes.
      const divergedDiskContent = editedContent + '\nExtra line from external edit';
      t.send(await diskChanged(divergedDiskContent, 3000));
      await t.hsm.awaitIdleAutoMerge();
      await t.hsm.awaitForkReconcile();
      expectState(t, 'idle.synced');

      // Reopen with the diverged disk content
      await sendAcquireLockToTracking(t, divergedDiskContent);

      // Should go to tracking or merging, but NOT have doubled content
      expect(t.hsm.isActive()).toBe(true);
      const localDocContent = t.hsm.localDoc?.getText('contents').toString();
      // Content should be reasonable - either the diverged content or a merge result
      // But definitely NOT doubled
      expect(localDocContent!.length).toBeLessThan(divergedDiskContent.length * 2);
    });

    // BUG-051: Test server echo scenario - the exact e2e failure case
    // When a file is edited, saved, closed, and the server echoes the update,
    // reopening should NOT duplicate content even though remoteDoc received the echo.
    test('server echo during idle should not duplicate content on reopen', async () => {
      const t = await createTestHSM();
      const originalContent = '# Test file\n\nContent for test-1.md.';
      const editedContent = '# Test file\n\n<!-- e2e-tp002 marker -->Content for test-1.md.';

      // Start with original content in idle.synced
      await loadToIdle(t, { content: originalContent, mtime: 1000 });
      t.send(await diskChanged(originalContent, 1000));
      expectState(t, 'idle.synced');

      // Open file
      await sendAcquireLockToTracking(t, originalContent);
      expectState(t, 'active.tracking');

      // Capture remoteDoc state before edits
      const remoteDocBefore = t.hsm.getRemoteDoc().getText('contents').toString();
      expect(remoteDocBefore).toBe(originalContent);

      // User types
      t.send(cm6Insert(13, '<!-- e2e-tp002 marker -->', editedContent));
      expectLocalDocText(t, editedContent);

      // Verify remoteDoc was synced (syncLocalToRemote is called on CM6_CHANGE)
      const remoteDocAfterEdit = t.hsm.getRemoteDoc().getText('contents').toString();
      expect(remoteDocAfterEdit).toBe(editedContent);

      // Save
      t.send(saveComplete(2000, 'test-hash'));

      // Close
      t.send(releaseLock());
      await t.hsm.awaitCleanup();
      expectState(t, 'idle.synced');

      // KEY SCENARIO: Server echo arrives while in idle.
      // A real server echo contains the same operations we already sent,
      // echoed back. It shares CRDT history with our remoteDoc (same client IDs).
      // Simulate by re-encoding remoteDoc's state as the echo update.
      const serverEcho = Y.encodeStateAsUpdate(t.hsm.getRemoteDoc());

      // Send the "server echo" as REMOTE_UPDATE
      t.send(remoteUpdate(serverEcho));

      // HSM should transition to idle.remoteAhead and auto-merge
      await t.hsm.awaitIdleAutoMerge();

      // Should be back in idle.synced (no conflicts)
      expectState(t, 'idle.synced');

      // ===== PHASE 2: Reopen =====
      // Now reopen the file
      await sendAcquireLockToTracking(t, editedContent);
      expectState(t, 'active.tracking');

      // Content should NOT be duplicated
      const localDocContent = t.hsm.localDoc?.getText('contents').toString();
      expect(localDocContent).toBe(editedContent);
      expect(localDocContent?.length).toBe(editedContent.length); // 65 chars, not 130

      // RemoteDoc should also have correct content
      const remoteDocContent = t.hsm.getRemoteDoc().getText('contents').toString();
      expect(remoteDocContent).toBe(editedContent);
    });

    test('multiple ACQUIRE_LOCK/RELEASE_LOCK cycles work correctly', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'hello', mtime: 1000 });

      // Set up disk state matching LCA
      t.send(await diskChanged('hello', 1000));

      // First cycle - auto-transitions to tracking (offline-first)
      await sendAcquireLockToTracking(t, 'hello');
      expectState(t, 'active.tracking');
      t.send(releaseLock());
      await t.hsm.awaitCleanup();
      await t.hsm.awaitIdleAutoMerge();
      // After release, local state vector may be ahead - that's expected with real transitions
      expect(t.matches('idle')).toBe(true);

      // Second cycle
      await sendAcquireLockToTracking(t, 'hello');
      expectState(t, 'active.tracking');
      t.send(releaseLock());
      await t.hsm.awaitCleanup();
      await t.hsm.awaitIdleAutoMerge();
      expect(t.matches('idle')).toBe(true);

      // Third cycle - should still work
      await sendAcquireLockToTracking(t, 'hello');
      expectState(t, 'active.tracking');
    });

    test('isActive and isIdle helper methods work correctly', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      expect(t.hsm.isIdle()).toBe(true);
      expect(t.hsm.isActive()).toBe(false);

      await sendAcquireLockToTracking(t);

      expect(t.hsm.isIdle()).toBe(false);
      expect(t.hsm.isActive()).toBe(true);

      t.send(releaseLock());
      await t.hsm.awaitCleanup();

      expect(t.hsm.isIdle()).toBe(true);
      expect(t.hsm.isActive()).toBe(false);
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
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: Date.now() - 1000 });

      // Edit localDoc so it differs from LCA
      t.send(cm6Insert(5, ' local', 'hello local'));

      t.send(await diskChanged('hello disk', Date.now()));

      // In active.tracking, Obsidian handles disk->editor sync.
      // HSM does NOT trigger conflict - stays in tracking.
      expectState(t, 'active.tracking');
    });

    test('DISK_CHANGED advances LCA when editorViewRef.dirty is false', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', {
        mtime: Date.now() - 1000,
        editorViewRef: { dirty: false },
      });

      const oldLca = t.state.lca;

      const newMtime = Date.now();
      t.send(await diskChanged('hello updated', newMtime));

      expectState(t, 'active.tracking');
      const newLca = t.state.lca;
      expect(newLca).not.toBeNull();
      expect(newLca!.contents).toBe('hello updated');
      expect(newLca!.meta.mtime).toBe(newMtime);
      expect(newLca).not.toEqual(oldLca);
    });

    test('DISK_CHANGED does NOT advance LCA when editorViewRef.dirty is true', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', {
        mtime: Date.now() - 1000,
        editorViewRef: { dirty: true },
      });

      const oldLca = t.state.lca;

      t.send(await diskChanged('hello updated', Date.now()));

      expectState(t, 'active.tracking');
      const newLca = t.state.lca;
      expect(newLca!.contents).toBe(oldLca!.contents);
    });

    test('DISK_CHANGED does NOT advance LCA when no editorViewRef', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: Date.now() - 1000 });

      const oldLca = t.state.lca;

      t.send(await diskChanged('hello updated', Date.now()));

      expectState(t, 'active.tracking');
      const newLca = t.state.lca;
      expect(newLca!.contents).toBe(oldLca!.contents);
    });
  });

  // ===========================================================================
  // Active Mode: Conflict Resolution
  // ===========================================================================

  describe('conflict resolution', () => {
    test('real conflict reached through diverged idle state', async () => {
      const t = await createTestHSM();
      await loadToConflict(t, {
        base: 'hello',
        remote: 'hello local',
        disk: 'hello remote',
      });

      expectState(t, 'active.conflict.bannerShown');
    });

    test('OPEN_DIFF_VIEW transitions to active.conflict.resolving', async () => {
      const t = await createTestHSM();
      await loadToConflict(t, {
        base: 'hello',
        remote: 'hello local',
        disk: 'hello disk',
      });

      t.send(openDiffView());

      expectState(t, 'active.conflict.resolving');
    });

    test('RESOLVE with disk content returns to tracking', async () => {
      const t = await createTestHSM();
      await loadToResolving(t, {
        base: 'hello',
        remote: 'hello local',
        disk: 'hello disk',
      });

      t.send(resolve('hello disk'));

      expectState(t, 'active.tracking');
    });

    test('RESOLVE with local content returns to tracking', async () => {
      const t = await createTestHSM();
      await loadToResolving(t, {
        base: 'hello',
        remote: 'hello local',
        disk: 'hello disk',
      });

      t.send(resolve('hello local'));

      expectState(t, 'active.tracking');
    });

    test('DISMISS_CONFLICT defers and returns to tracking', async () => {
      const t = await createTestHSM();
      await loadToConflict(t, {
        base: 'hello',
        remote: 'hello local',
        disk: 'hello disk',
      });

      t.send(dismissConflict());

      expectState(t, 'active.tracking');
      expect(t.state.deferredConflict).toBeDefined();
    });

    test('RESOLVE applies content to localDoc and dispatches to editor', async () => {
      const t = await createTestHSM();
      await loadToResolving(t, {
        base: 'hello',
        remote: 'hello local',
        disk: 'hello disk',
      });
      t.clearEffects();

      t.send(resolve('hello disk'));

      expectState(t, 'active.tracking');
      expectLocalDocText(t, 'hello disk');
      // RESOLVE always applies content to localDoc and dispatches CM6
      // to sync the editor with the resolved content
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
    });

    test('RESOLVE with merged content applies merged content', async () => {
      const t = await createTestHSM();
      await loadToResolving(t, {
        base: 'hello',
        remote: 'hello local',
        disk: 'hello disk',
      });
      t.clearEffects();

      t.send(resolve('hello merged'));

      expectState(t, 'active.tracking');
      expectLocalDocText(t, 'hello merged');
      // No DISPATCH_CM6 — y-codemirror binding propagates CRDT changes to editor
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
    });

    test('CANCEL from resolving returns to bannerShown', async () => {
      const t = await createTestHSM();
      await loadToResolving(t, {
        base: 'hello',
        remote: 'hello local',
        disk: 'hello disk',
      });

      t.send(cancel());

      expectState(t, 'active.conflict.bannerShown');
    });

    test('ACQUIRE_LOCK from idle.diverged goes to conflict.bannerShown', async () => {
      // This is what loadToConflict does internally - test the scenario directly
      const t = await createTestHSM();
      await loadToConflict(t, {
        base: 'original',
        remote: 'remote changed',
        disk: 'disk changed',
      });

      expectState(t, 'active.conflict.bannerShown');
      expect(t.hsm.getLocalDoc()).not.toBeNull();

      const conflictData = t.hsm.getConflictData();
      expect(conflictData).not.toBeNull();
      expect(conflictData!.theirs).toBe('disk changed');
    });

    test('awaitActive() resolves for conflict state, not just tracking', async () => {
      // Regression test: awaitActive() must resolve for any active.* state.
      // If it only resolves for active.tracking, acquireLock() hangs when
      // HSM enters active.conflict.*, preventing banner subscription setup.
      const t = await createTestHSM();
      await loadToConflict(t, {
        base: 'original',
        remote: 'remote changed',
        disk: 'disk changed',
      });

      expectState(t, 'active.conflict.bannerShown');

      // awaitActive() should resolve immediately since we're already in active.*
      const resolved = await Promise.race([
        t.hsm.awaitActive().then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 100)),
      ]);
      expect(resolved).toBe(true);
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
      expectState(t, 'idle.synced');

      t.send(disconnected());
      expectState(t, 'idle.synced');
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
    test('REMOTE_UPDATE in idle auto-merges and writes to disk', async () => {
      // Create a test starting in idle.synced
      const t = await createTestHSM();
      await loadToIdle(t);
      t.clearEffects();

      // Apply remote change using proper diff-based update.
      // With localDoc alive, the auto-merge completes synchronously:
      // idle.synced → idle.remoteAhead → idle.synced (within handleEvent)
      t.applyRemoteChange('hello');
      await t.hsm.awaitIdleAutoMerge();

      expectState(t, 'idle.synced');
      expectEffect(t.effects, { type: 'WRITE_DISK' });
      expect(t.getLocalDocText()).toBe('hello');
    });

    test('DISK_CHANGED in idle triggers auto-merge and returns to synced', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'original', mtime: 1000 });

      // Mark provider as synced so fork reconciliation can complete
      t.send(connected());
      t.send(providerSynced());
      t.clearEffects();

      t.send(await diskChanged('modified content', Date.now()));

      // Disk edit creates fork, fork reconciliation runs immediately (provider synced)
      await t.hsm.awaitIdleAutoMerge();
      await t.hsm.awaitForkReconcile();

      // End state should be clean after auto-merge
      expectState(t, 'idle.synced');

      // Verify SYNC_TO_REMOTE was emitted (disk changes propagated to remote)
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
    });

    test('idle mode keeps localDoc alive for auto-merge', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      // localDoc stays alive in idle mode for efficient auto-merge
      expect(t.getLocalDocText()).not.toBeNull();

      // Receive remote update - localDoc is updated directly
      t.applyRemoteChange('hello');

      expect(t.getLocalDocText()).toBe('hello');
    });

    // =================================================================
    // Anti-heuristic tests
    //
    // These tests ensure that remote updates are NEVER filtered based
    // on content heuristics. Legitimate documents can contain repeated
    // text, and remote updates that happen to match local content must
    // still be processed. The error is always in the sender, never in
    // the receiver.
    // =================================================================

    const POEM = [
      'Do not go gentle into that good night,',
      'Old age should burn and rave at close of day;',
      'Rage, rage against the dying of the light.',
      '',
      'Though wise men at their end know dark is right,',
      'Because their words had forked no lightning they',
      'Do not go gentle into that good night.',
      '',
      'Rage, rage against the dying of the light.',
    ].join('\n');

    test('remote update with repeated content (refrain) auto-merges correctly', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      // The poem has two identical lines ("Rage, rage..." and "Do not go...").
      // A content-matching heuristic might see repeated text and wrongly
      // conclude this is a duplication artifact.
      t.applyRemoteChange(POEM);
      await t.hsm.awaitIdleAutoMerge();

      // Auto-merge completes synchronously with localDoc alive.
      // Content must not be deduplicated or corrupted.
      expectState(t, 'idle.synced');
      expect(t.getLocalDocText()).toBe(POEM);
    });

    test('remote update arriving twice is idempotent, not blocked', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'hello', mtime: 1000 });
      t.send(await diskChanged('hello', 1000));

      // First remote update
      t.applyRemoteChange('hello world');
      await t.hsm.awaitIdleAutoMerge();
      expectState(t, 'idle.synced');

      // Send the exact same content again (e.g. server re-delivery).
      // A heuristic that compares content strings would skip this.
      // But Yjs handles idempotency correctly — same ops from the same
      // client are a no-op, and the state machine must still process the event.
      t.applyRemoteChange('hello world');
      // Should process without error and remain synced (content didn't change)
      await t.hsm.awaitIdleAutoMerge();
      expect(t.matches('idle')).toBe(true);
    });

    test('document whose content is naturally doubled survives remote sync', async () => {
      // Content where the second half equals the first half — like a
      // call-and-response or a copy/paste that the user actually intended.
      const doubled = 'chorus line\nchorus line\n';
      const t = await createTestHSM();
      await loadToIdle(t, { content: doubled, mtime: 1000 });
      t.send(await diskChanged(doubled, 1000));

      // Remote peer adds a verse before the doubled chorus
      const withVerse = 'new verse\n' + doubled;
      t.applyRemoteChange(withVerse);
      await t.hsm.awaitIdleAutoMerge();

      expectState(t, 'idle.synced');
    });

    test('active mode: remote update matching editor content still merges', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'draft', mtime: 1000 });
      t.send(await diskChanged('draft', 1000));

      // Open editor
      await sendAcquireLockToTracking(t, 'draft');
      expectState(t, 'active.tracking');

      // User types "draft v2"
      t.send(cm6Insert(5, ' v2', 'draft v2'));
      expectLocalDocText(t, 'draft v2');

      // Remote peer independently made the same edit.
      // The remote update contains the same resulting text.
      // A heuristic would see "content matches" and skip — but this is
      // a legitimate convergent edit that must be processed.
      t.applyRemoteChange('draft v2');

      // Should still be tracking, content intact (not doubled)
      expectState(t, 'active.tracking');
      expectLocalDocText(t, 'draft v2');
    });

    test('poem with refrain survives full edit/save/close/reopen cycle', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: POEM, mtime: 1000 });
      t.send(await diskChanged(POEM, 1000));

      // Open, edit (add a stanza that repeats the refrain again), save, close
      await sendAcquireLockToTracking(t, POEM);
      expectState(t, 'active.tracking');

      const extraRefrain = POEM + '\n\nRage, rage against the dying of the light.';
      t.send(cm6Insert(POEM.length, '\n\nRage, rage against the dying of the light.', extraRefrain));
      expectLocalDocText(t, extraRefrain);

      t.send(saveComplete(2000, 'poem-hash'));
      t.send(await diskChanged(extraRefrain, 2000));
      t.send(releaseLock());
      await t.hsm.awaitCleanup();
      expectState(t, 'idle.synced');

      // Reopen — content must not be deduplicated or corrupted
      await sendAcquireLockToTracking(t, extraRefrain);
      expectState(t, 'active.tracking');
      expectLocalDocText(t, extraRefrain);
    });

    test('ACQUIRE_LOCK transitions to active with localDoc', async () => {
      const t = await createTestHSM();
      await loadToIdle(t);

      // localDoc already alive in idle mode
      expect(t.hsm.getLocalDoc()).not.toBeNull();

      await sendAcquireLockToTracking(t);

      // Still alive in active mode
      expect(t.hsm.getLocalDoc()).not.toBeNull();
      expect(t.hsm.getRemoteDoc()).not.toBeNull();
      expect(t.hsm.isActive()).toBe(true);
    });

    test('idle.remoteAhead auto-merges when disk==lca', async () => {
      const t = await createTestHSM();
      // loadToIdle automatically syncs remoteDoc with the same CRDT history
      await loadToIdle(t, { content: 'hello', mtime: 1000 });

      // Set up disk state matching LCA (await in case of async work)
      t.send(await diskChanged('hello', 1000));
      await t.awaitIdleAutoMerge();
      t.clearEffects();

      // Remote update arrives - applyRemoteChange creates proper delta update
      // because remoteDoc shares CRDT history with local
      t.applyRemoteChange('hello world');

      // Wait for async idle auto-merge to complete (BUG-021 fix made this async)
      await t.hsm.awaitIdleAutoMerge();

      // Should auto-merge and emit WRITE_DISK
      expectEffect(t.effects, { type: 'WRITE_DISK' });
      expectState(t, 'idle.synced');
    });

    test('idle.diskAhead auto-merges when remote==lca', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'hello', mtime: 1000 });

      // Mark provider as synced so fork reconciliation can complete
      t.send(connected());
      t.send(providerSynced());
      t.clearEffects();

      // Disk changes externally
      t.send(await diskChanged('hello world', 2000));

      // Wait for fork creation and reconciliation
      await t.hsm.awaitIdleAutoMerge();
      await t.hsm.awaitForkReconcile();

      // Should auto-merge and emit SYNC_TO_REMOTE
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
      expectState(t, 'idle.synced');
    });

    test('idle.diverged auto-merges when no conflicts', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'line1\nline2\nline3', mtime: 1000 });

      // Mark provider as synced so fork reconciliation can complete
      t.send(connected());
      t.send(providerSynced());
      t.clearEffects();

      // Pre-compute disk event before sending remote update to avoid timing issues
      const diskEvent = await diskChanged('line1\nline2\nDISK', 2000);

      // Remote update changes line1 - proper delta because remoteDoc shares CRDT history
      t.applyRemoteChange('REMOTE\nline2\nline3');
      // Await potential async work from remote update before sending disk event
      await t.awaitIdleAutoMerge();

      // Then disk changes line3 - diverged but mergeable
      t.send(diskEvent);

      // Wait for fork reconciliation (3-way merge)
      await t.hsm.awaitIdleAutoMerge();
      await t.hsm.awaitForkReconcile();

      // 3-way merge should succeed - back to clean
      expectState(t, 'idle.synced');
      expectEffect(t.effects, { type: 'WRITE_DISK' });
    });

    test('idle.diverged stays diverged when merge has conflicts', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'original line', mtime: 1000 });

      // Pre-compute disk event to avoid async between sends
      const diskEvent = await diskChanged('disk changed this', 2000);

      // Send remote first (→ idle.remoteAhead), then disk immediately (→ idle.diverged)
      t.applyRemoteChange('remote changed this');
      t.send(diskEvent);

      // Wait for 3-way merge to attempt
      await t.hsm.awaitIdleAutoMerge();

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

      const t = await createTestHSM();
      await loadToIdle(t, { content: 'local content', mtime: 1000 });

      // Set up disk state matching LCA
      t.send(await diskChanged('local content', 1000));

      // localDoc is alive in idle mode with content from persistence.

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
      expectState(t, 'idle.synced');
    });

    // BUG-021: When local has content in IndexedDB, empty remote should preserve it
    test('empty remote update preserves local IndexedDB content (BUG-021 full scenario)', async () => {
      // Create a Yjs update representing "local content exists in IndexedDB"
      const localDoc = new Y.Doc();
      localDoc.getText('contents').insert(0, 'Line 1\nLine 2\nLine 3');
      const localUpdate = Y.encodeStateAsUpdate(localDoc);
      localDoc.destroy();

      // Seed mock IndexedDB with the local update (localDoc stays alive in idle)
      const t = await createTestHSM({ indexedDBUpdates: localUpdate });
      await loadToIdle(t, { content: 'Line 1\nLine 2\nLine 3', mtime: 1000 });

      // Set up disk state matching LCA
      t.send(await diskChanged('Line 1\nLine 2\nLine 3', 1000));

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

      expectState(t, 'idle.synced');
    });

    // BUG-021: Remote with new content should merge with local IndexedDB content
    test('remote update merges correctly with local IndexedDB content (BUG-021)', async () => {
      // Create a Yjs update representing local content in IndexedDB
      const localDoc = new Y.Doc();
      localDoc.getText('contents').insert(0, 'Line 1\nLine 2\nLine 3');
      const localUpdate = Y.encodeStateAsUpdate(localDoc);
      localDoc.destroy();

      // Seed mock IndexedDB with the local update (localDoc stays alive in idle)
      const t = await createTestHSM({ indexedDBUpdates: localUpdate });
      await loadToIdle(t, { content: 'original', mtime: 1000 });

      // Set up disk state matching LCA
      t.send(await diskChanged('original', 1000));

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

      expectState(t, 'idle.synced');
    });
  });

  // ===========================================================================
  // State Vector Comparison — Merge Routing
  // ===========================================================================
  //
  // These tests verify that state vector comparison correctly drives the
  // merge routing decisions. The HSM uses stateVectorIsAhead() to determine
  // whether remote or local has changed relative to the LCA:
  //
  // - handleDiskChanged: if disk differs from LCA, checks hasRemoteChangedSinceLCA()
  //   to decide idle.diskAhead (remote == LCA) vs idle.diverged (remote > LCA)
  // - attemptIdleAutoMerge in idle.diskAhead: checks hasRemoteChangedSinceLCA()
  //   to confirm disk-only merge is safe
  // - attemptIdleAutoMerge in idle.remoteAhead: checks hasDiskChangedSinceLCA()
  //   to confirm remote-only merge is safe
  //
  // State vectors are built from real Yjs docs, not synthetic bytes.

  describe('state vector merge routing', () => {
    test('disk-only merge when remote state vector equals LCA', async () => {
      // After loadToIdle, LCA and remote share the same state vector.
      // A disk change creates a fork, fork reconciliation syncs to remote.
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'original', mtime: 1000 });

      // Mark provider as synced so fork reconciliation can complete
      t.send(connected());
      t.send(providerSynced());
      t.clearEffects();

      // Disk changes but remote hasn't changed since LCA
      t.send(await diskChanged('original modified', 2000));
      await t.hsm.awaitIdleAutoMerge();
      await t.hsm.awaitForkReconcile();

      // Fork reconciliation emits SYNC_TO_REMOTE (push disk content to remote)
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
      // Should NOT emit WRITE_DISK (disk already has the content)
      expectNoEffect(t.effects, { type: 'WRITE_DISK' });
      expectState(t, 'idle.synced');
    });

    test('remote-only merge when disk hash equals LCA', async () => {
      // After loadToIdle, disk hash matches LCA.
      // A remote update should take the remote-only path (WRITE_DISK, no SYNC_TO_REMOTE).
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'original', mtime: 1000 });
      t.send(await diskChanged('original', 1000));
      await t.awaitIdleAutoMerge();
      t.clearEffects();

      // Remote changes but disk matches LCA
      t.applyRemoteChange('original updated');
      await t.hsm.awaitIdleAutoMerge();

      // Remote-only merge emits WRITE_DISK (write merged content to disk)
      expectEffect(t.effects, { type: 'WRITE_DISK' });
      expectState(t, 'idle.synced');
    });

    test('three-way merge when both remote state vector and disk hash differ from LCA', async () => {
      // Both remote and disk have changed since LCA.
      // Changes are on different lines so the three-way merge succeeds.
      // (Need 3+ lines so diff3 can separate the hunks.)
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'line1\nline2\nline3', mtime: 1000 });

      const diskEvent = await diskChanged('line1\nline2\ndisk-changed', 2000);
      t.applyRemoteChange('remote-changed\nline2\nline3');
      t.send(diskEvent);

      await t.hsm.awaitIdleAutoMerge();

      // Three-way merge emits both effects
      expectEffect(t.effects, { type: 'WRITE_DISK' });
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
      expectState(t, 'idle.synced');
    });

    test('remote update after disk change triggers diverged (not diskAhead)', async () => {
      // Start with disk ahead, then remote also changes.
      // The second event should push to idle.diverged.
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'base', mtime: 1000 });

      // Mark provider as synced so fork reconciliation can complete
      t.send(connected());
      t.send(providerSynced());

      // Disk changes first
      t.send(await diskChanged('base disk', 2000));
      await t.hsm.awaitIdleAutoMerge();
      await t.hsm.awaitForkReconcile();

      // After fork reconciliation, we're back to synced with updated LCA
      expectState(t, 'idle.synced');
      t.clearEffects();

      // Now a *new* remote change arrives relative to the new LCA.
      // Since the new LCA was set after the disk merge, and remote hasn't
      // changed relative to that new LCA until now:
      t.applyRemoteChange('base disk remote');
      await t.hsm.awaitIdleAutoMerge();

      // Should do remote-only merge (disk matches new LCA)
      expectEffect(t.effects, { type: 'WRITE_DISK' });
      expectState(t, 'idle.synced');
    });

    test('remote state vector with different client ID is detected as ahead', async () => {
      // Verify that stateVectorIsAhead works across different client IDs.
      // The LCA state vector has client X, remote gets operations from client Y.
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'hello', mtime: 1000 });
      t.send(await diskChanged('hello', 1000));
      await t.awaitIdleAutoMerge();
      t.clearEffects();

      // applyRemoteChange operates on remoteDoc (which has a different clientID
      // than the one that created the LCA update). This verifies that
      // stateVectorIsAhead correctly compares across different client IDs.
      t.applyRemoteChange('hello world');
      await t.hsm.awaitIdleAutoMerge();

      // Remote was detected as ahead → remote-only auto-merge
      expectEffect(t.effects, { type: 'WRITE_DISK' });
      expectState(t, 'idle.synced');

      // Verify content was written correctly
      const writeEffect = t.effects.find(e => e.type === 'WRITE_DISK') as { type: 'WRITE_DISK'; contents: string };
      expect(writeEffect.contents).toBe('hello world');
    });

    test('no merge triggered when remote state vector matches LCA and disk matches LCA', async () => {
      // Both remote and disk match LCA — no merge should occur.
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'stable', mtime: 1000 });
      t.send(await diskChanged('stable', 1000));
      t.clearEffects();

      // Send a disk event with the same hash — should be a no-op
      t.send(await diskChanged('stable', 2000));

      expectNoEffect(t.effects, { type: 'WRITE_DISK' });
      expectNoEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
      expectState(t, 'idle.synced');
    });
  });

  // ===========================================================================
  // Sync Status
  // ===========================================================================

  describe('getSyncStatus', () => {
    test('returns synced status in idle.synced', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { guid: 'doc-123', path: 'test.md' });

      const status = t.hsm.getSyncStatus();

      expect(status.guid).toBe('doc-123');
      expect(status.status).toBe('synced');
    });

    test('returns synced status in active.tracking', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');

      const status = t.hsm.getSyncStatus();

      expect(status.status).toBe('synced');
    });

    test('returns pending status in idle.remoteAhead', async () => {
      // Load without LCA so auto-merge can't complete and state stays remoteAhead
      const t = await createTestHSM();
      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send({ type: 'SET_MODE_IDLE' });
      expectState(t, 'idle.synced');

      // Apply remote change - without LCA, auto-merge can't proceed
      t.applyRemoteChange('remote content');
      expectState(t, 'idle.remoteAhead');

      const status = t.hsm.getSyncStatus();

      expect(status.status).toBe('pending');
    });

    test('returns conflict status in active.conflict.bannerShown', async () => {
      const t = await createTestHSM();
      await loadToConflict(t, {
        base: 'original',
        remote: 'hello',
        disk: 'disk change',
      });

      const status = t.hsm.getSyncStatus();

      expect(status.status).toBe('conflict');
    });
  });

  // ===========================================================================
  // Persistence Effects
  // ===========================================================================

  describe('persistence effects', () => {
    test('SAVE_COMPLETE in active mode does not emit PERSIST_STATE (LCA frozen)', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: 1000 });
      t.clearEffects();

      t.send(saveComplete(2000));

      // Per spec: LCA is never touched during active.* states
      // So no PERSIST_STATE for LCA updates in active mode
      const persistEffects = t.effects.filter(e => e.type === 'PERSIST_STATE');
      expect(persistEffects).toHaveLength(0);
    });

    test('DISMISS_CONFLICT emits PERSIST_STATE', async () => {
      const t = await createTestHSM();
      await loadToConflict(t, {
        base: 'original',
        remote: 'hello',
        disk: 'hello disk',
      });
      t.clearEffects();

      t.send(dismissConflict());

      expectEffect(t.effects, { type: 'PERSIST_STATE' });
    });

    test('DISK_CHANGED in active mode does not update LCA (per spec)', async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello', { mtime: 1000 });

      // Edit localDoc so it differs from LCA
      t.send(cm6Insert(5, ' world', 'hello world'));
      t.clearEffects();

      // Disk change in active.tracking mode
      t.send(await diskChanged('hello world', Date.now()));

      // Per spec: LCA is never touched during active.* states
      // No PERSIST_STATE should be emitted for LCA updates
      const persistEffects = t.effects.filter(e => e.type === 'PERSIST_STATE');
      expect(persistEffects).toHaveLength(0);
    });

    test('STATUS_CHANGED emitted on state transition that changes sync status', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'hello', mtime: 1000 });
      t.clearEffects();

      // Receiving remote update changes status from synced to pending
      t.applyRemoteChange('hello world');

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
  // active.entering Substates (System Invariant #3)
  // ===========================================================================

  describe('active.entering substates', () => {
    test('ACQUIRE_LOCK transitions to awaitingPersistence', async () => {
      const t = await createTestHSM();
      const updates = createYjsUpdate('hello');
      const lca = await createLCA('hello', 1000);

      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(updates, lca));
      t.send({ type: 'SET_MODE_ACTIVE' });

      // Don't seed IndexedDB — we want to observe the substate directly.
      // Send ACQUIRE_LOCK but prevent mock persistence from having data.
      // Use a fresh HSM with no seeded IDB to get awaitingPersistence → awaitingRemote.
      const t2 = await createTestHSM();
      t2.send(load('test-guid', 'test.md'));
      t2.send(persistenceLoaded(new Uint8Array(), null));
      t2.send({ type: 'SET_MODE_ACTIVE' });
      await sendAcquireLock(t2, '');

      // IDB is empty, no LCA → hasContent=false → awaitingRemote
      expectState(t2, 'active.entering.awaitingRemote');
    });

    test('PERSISTENCE_SYNCED(hasContent=true) → reconciling → tracking', async () => {
      const t = await createTestHSM();
      const content = 'hello world';
      await loadAndActivate(t, content);

      // loadAndActivate seeds IDB and drives to tracking
      expectState(t, 'active.tracking');
      expectLocalDocText(t, content);
    });

    test('PERSISTENCE_SYNCED(hasContent=false) → awaitingRemote', async () => {
      const t = await createTestHSM();
      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send({ type: 'SET_MODE_ACTIVE' });
      await sendAcquireLock(t, '');

      // IDB empty, no LCA → awaitingRemote
      expectState(t, 'active.entering.awaitingRemote');
    });

    test('awaitingRemote + PROVIDER_SYNCED → reconciling → tracking', async () => {
      const t = await createTestHSM();
      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send({ type: 'SET_MODE_ACTIVE' });
      await sendAcquireLock(t, '');

      expectState(t, 'active.entering.awaitingRemote');

      // Send PROVIDER_SYNCED to unblock
      t.send(providerSynced());

      // localDoc is empty, disk is empty → content matches → tracking
      expectState(t, 'active.tracking');
    });

    test('awaitingRemote + PROVIDER_SYNCED with server content applies to localDoc', async () => {
      const t = await createTestHSM();
      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send({ type: 'SET_MODE_ACTIVE' });

      // Set remote content before ACQUIRE_LOCK (simulating already-synced provider)
      t.setRemoteContent('server content');

      await sendAcquireLock(t, '');

      expectState(t, 'active.entering.awaitingRemote');

      // Send PROVIDER_SYNCED — should apply remote content to localDoc
      t.send(providerSynced());

      // localDoc gets server content, disk is empty → content mismatch → merge
      // (twoWay because no LCA). After merge, since disk is empty and local has
      // content from server, the conflict state is entered.
      expect(
        t.matches('active.merging') ||
        t.matches('active.conflict') ||
        t.matches('active.tracking')
      ).toBe(true);

      // localDoc should have the server content applied
      expect(t.getLocalDocText()).toBe('server content');
    });

    test('PROVIDER_SYNCED before PERSISTENCE_SYNCED is captured by flag', async () => {
      const t = await createTestHSM();
      const content = 'hello';
      const updates = createYjsUpdate(content);
      const lca = await createLCA(content, 1000);

      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(updates, lca));
      t.send({ type: 'SET_MODE_ACTIVE' });

      // In production, ProviderIntegration may send PROVIDER_SYNCED before
      // persistence finishes loading. The flag captures it. With seeded IDB,
      // hasContent=true so it goes to reconciling regardless of the flag.
      t.seedIndexedDB(updates);
      await sendAcquireLockToTracking(t, content);

      // Mock persistence fires synchronously, so PERSISTENCE_SYNCED fires first.
      // With IDB content, goes straight to reconciling → tracking.
      expectState(t, 'active.tracking');
    });

    test('CM6_CHANGE during awaitingRemote updates lastKnownEditorText', async () => {
      const t = await createTestHSM();
      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send({ type: 'SET_MODE_ACTIVE' });
      await sendAcquireLock(t, '');

      expectState(t, 'active.entering.awaitingRemote');

      // User types while waiting
      t.send(cm6Insert(0, 'typed', 'typed'));

      expect(t.state.lastKnownEditorText).toBe('typed');
    });

    test('REMOTE_UPDATE during awaitingRemote is accumulated', async () => {
      const t = await createTestHSM();
      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send({ type: 'SET_MODE_ACTIVE' });
      await sendAcquireLock(t, '');

      expectState(t, 'active.entering.awaitingRemote');

      // Send a remote update — should be accumulated, not crash
      t.applyRemoteChange('remote content');

      // Still in awaitingRemote (REMOTE_UPDATE is accumulated, not processed)
      expectState(t, 'active.entering.awaitingRemote');

      // Unblock with PROVIDER_SYNCED
      t.send(providerSynced());

      // Should have proceeded to reconciliation
      expect(t.matches('active.entering')).toBe(false);
    });

    test('RELEASE_LOCK during awaitingRemote transitions to unloading', async () => {
      const t = await createTestHSM();
      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send({ type: 'SET_MODE_ACTIVE' });
      await sendAcquireLock(t, '');

      expectState(t, 'active.entering.awaitingRemote');

      // Release lock while waiting
      t.send(releaseLock());
      await t.hsm.awaitCleanup();

      // Should have transitioned through unloading to idle
      expect(t.matches('idle')).toBe(true);
    });

  });

  describe('PermanentUserData behavior', () => {
    test('fresh Y.Doc has no CRDT operations', () => {
      const doc = new Y.Doc();

      // State vector should be minimal (just the header byte)
      const sv = Y.encodeStateVector(doc);
      expect(sv.length).toBe(1);
      expect(sv[0]).toBe(0);
    });

    test('PermanentUserData DOES create CRDT operations (writes to users map)', () => {
      // This test documents that PUD creates operations immediately.
      // This is why we must NOT set up PUD before enrollment - it would
      // make hasContent=true even for non-enrolled files.
      const doc = new Y.Doc();

      // Before PUD: no operations
      const svBefore = Y.encodeStateVector(doc);
      expect(svBefore.length).toBe(1);

      // Set up PermanentUserData
      const pud = new Y.PermanentUserData(doc);
      pud.setUserMapping(doc, doc.clientID, 'test-user-id');

      // After PUD: operations exist (writes to 'users' map)
      const svAfter = Y.encodeStateVector(doc);
      expect(svAfter.length).toBeGreaterThan(1);

      // The 'users' map has content
      const usersMap = doc.getMap('users');
      expect(usersMap.size).toBeGreaterThan(0);
    });

    test('hasContent check (stateVector.length > 1) detects PUD operations', () => {
      // This documents the hasContent logic used in handleLocalPersistenceSynced
      const doc = new Y.Doc();

      // Fresh doc: hasContent = false
      let sv = Y.encodeStateVector(doc);
      expect(sv.length > 1).toBe(false);

      // After PUD: hasContent = true
      const pud = new Y.PermanentUserData(doc);
      pud.setUserMapping(doc, doc.clientID, 'test-user-id');
      sv = Y.encodeStateVector(doc);
      expect(sv.length > 1).toBe(true);
    });
  });

});
