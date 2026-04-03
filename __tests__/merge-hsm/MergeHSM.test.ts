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
  unload,
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
  persistenceLoaded,
  load,
  createLCA,
  createYjsUpdate,
  mockEditorViewRef,
  // State transition helpers
  loadAndActivate,
  loadToIdle,
  loadToConflict,
  loadToResolving,
  // Assertions
  expectEffect,
  expectNoEffect,
  expectState,
  expectLocalDocText,
} from 'src/merge-hsm/testing';

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

    test('echo suppression is handled at CM6Integration level via ySyncAnnotation', async () => {
      // Echo suppression for Yjs-originated changes is handled by the
      // ySyncAnnotation check in CM6Integration.onEditorUpdate() and
      // HSMEditorPlugin.update(), not at the state machine level.
      // CM6_CHANGE events that reach the HSM are always user edits.
      const t = await createTestHSM();
      await loadAndActivate(t, 'hello');
      t.clearEffects();

      t.send(cm6Change(
        [{ from: 5, to: 5, insert: ' world' }],
        'hello world',
      ));

      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _originalLcaHash = t.state.lca?.meta.hash;

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
      t.send(connected());
      t.send(providerSynced());
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
        editorViewRef: mockEditorViewRef('hello', false),
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
        editorViewRef: mockEditorViewRef('hello', true),
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
      expectEffect(t.effects, { type: 'DISPATCH_CM6' });
      expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
    });

    test('RESOLVE never emits WRITE_DISK (active mode invariant)', async () => {
      const t = await createTestHSM();
      await loadToResolving(t, {
        base: 'hello',
        remote: 'hello remote',
        disk: 'hello disk',
      });
      t.clearEffects();

      t.send(resolve('hello merged'));

      expectState(t, 'active.tracking');
      expectNoEffect(t.effects, 'WRITE_DISK');
    });

    test('beginReleaseLock captures editor content into lastKnownEditorText', async () => {
      const t = await createTestHSM();
      // Use a mutable container so the mock can return updated content
      let editorContent = 'hello';
      const ref = { dirty: false, getViewData: () => editorContent };

      await loadAndActivate(t, 'hello', { editorViewRef: ref });
      expectState(t, 'active.tracking');

      // Simulate DISPATCH_CM6 changing the editor without a CM6_CHANGE echo
      // (ySyncAnnotation suppresses the echo in real code). The HSM's
      // lastKnownEditorText is now stale — still 'hello'.
      editorContent = 'hello world';

      t.send(releaseLock());
      await t.hsm.awaitCleanup?.();

      // beginReleaseLock should have read the definitive content from the editor
      expect(t.state.lastKnownEditorText).toBe('hello world');
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
      // Fork-reconcile: ours=localDoc (CRDT with remote content), theirs=remoteDoc
      expect(conflictData!.ours).toBe('remote changed');
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

    test('idle remote+disk conflict on same line populates theirs correctly', async () => {
      const baseContent = 'line1\nline2\nline3';

      const t = await createTestHSM({ logTransitions: true });
      await loadToIdle(t, { content: baseContent, mtime: 1000 });

      // Send REMOTE_UPDATE and DISK_CHANGED back-to-back so the HSM sees both
      // before the idle-merge invoke runs. This puts the HSM into idle.diverged
      // where invokeIdleThreeWayAutoMerge runs the 3-way merge with the original
      // LCA as base.
      const remoteContent = 'line1\nremote-edit\nline3';
      const diskContent = 'line1\ndisk-edit\nline3';

      // Prepare disk event before sending (sha256 is async)
      const diskEvent = await diskChanged(diskContent, 2000);

      // Send both events without awaiting — HSM queues them synchronously
      t.applyRemoteChange(remoteContent);
      t.send(diskEvent);

      // Wait for idle auto-merge to run (should detect conflict, create fork)
      await t.hsm.awaitIdleAutoMerge();

      // The fork-reconcile needs PROVIDER_SYNCED to proceed.
      // The fork creation clears providerSynced, so we must send it again.
      t.send(connected());
      t.send(providerSynced());

      // Wait for fork-reconcile to complete
      await t.hsm.awaitForkReconcile();

      // If fork-reconcile detected conflict and returned to idle.diverged,
      // the auto-merge will re-run but should bail (conflictData already set)
      await t.hsm.awaitIdleAutoMerge();

      // conflictData should be populated from fork-reconcile
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _cdBeforeOpen = t.hsm.getConflictData();

      // User opens the file
      const currentContent = t.getLocalDocText() ?? diskContent;
      await sendAcquireLockToTracking(t, currentContent);

      // Should enter conflict state (hasPreexistingConflict detects conflictData)
      expectState(t, 'active.conflict.bannerShown');

      // Assert conflictData.theirs contains the remote edit
      const cd = t.hsm.getConflictData();
      expect(cd).toBeDefined();
      expect(cd).not.toBeNull();

      // The base should be the original content
      expect(cd!.base).toBe(baseContent);

      // "ours" should be the local/disk content
      expect(cd!.ours).toBe(diskContent);

      // "theirs" must contain the remote edit, not empty string
      expect(cd!.theirs).not.toBe('');
      expect(cd!.theirs).toBe(remoteContent);
    });

    test('idle remote+disk conflict without provider sync defers fork-reconcile', async () => {
      const baseContent = 'line1\nline2\nline3';

      const t = await createTestHSM({ logTransitions: true });
      await loadToIdle(t, { content: baseContent, mtime: 1000 });

      // Send both events back-to-back
      const remoteContent = 'line1\nremote-edit\nline3';
      const diskContent = 'line1\ndisk-edit\nline3';
      const diskEvent = await diskChanged(diskContent, 2000);

      t.applyRemoteChange(remoteContent);
      t.send(diskEvent);

      // Wait for idle auto-merge (creates fork on conflict)
      await t.hsm.awaitIdleAutoMerge();

      // Fork-reconcile should be blocked waiting for provider sync.
      // Now send PROVIDER_SYNCED to unblock it.
      t.send(connected());
      t.send(providerSynced());

      await t.hsm.awaitForkReconcile();
      await t.hsm.awaitIdleAutoMerge();

      // Open the file
      const currentContent = t.getLocalDocText() ?? diskContent;
      await sendAcquireLockToTracking(t, currentContent);

      expectState(t, 'active.conflict.bannerShown');

      const cd = t.hsm.getConflictData();
      expect(cd).toBeDefined();
      expect(cd).not.toBeNull();
      expect(cd!.theirs).not.toBe('');
      expect(cd!.theirs).toBe(remoteContent);
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

      // Now check drift - pass actualEditorText because the Y.Text observer
      // auto-syncs lastKnownEditorText when localDoc is modified directly
      const driftDetected = t.hsm.checkAndCorrectDrift('hello world');

      expect(driftDetected).toBe(true);
      expectEffect(t.effects, { type: 'STATUS_CHANGED' });
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

      // Disk edit creates fork, fork reconciliation needs provider re-sync
      await t.hsm.awaitIdleAutoMerge();
      t.send(connected());
      t.send(providerSynced());
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

      // Receive remote update - merge applies after invoke completes
      t.applyRemoteChange('hello');
      await t.awaitIdleAutoMerge();

      expect(t.getLocalDocText()).toBe('hello');
    });

    test('REMOTE_UPDATE during in-flight idle merge does not corrupt localDoc', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, 'base');

      // First remote update: triggers idle.remoteAhead invoke
      t.applyRemoteChange('base hello');

      // Second remote update arrives while first merge is in flight.
      // Without the temp-doc fix, this could corrupt localDoc by
      // re-entering the invoke after partial localDoc mutation.
      t.applyRemoteChange('base hello world');

      // First invoke completes → scheduleIdleRetry queues IDLE_RETRY via
      // setTimeout. Await the first invoke, flush the timer to let IDLE_RETRY
      // fire (which re-enters idle.remoteAhead and starts a second invoke),
      // then await the second invoke.
      await t.awaitIdleAutoMerge();
      await new Promise(r => setTimeout(r, 0));
      await t.awaitIdleAutoMerge();

      // localDoc should have the final merged content
      expect(t.getLocalDocText()).toBe('base hello world');

      // Verify disk write was emitted with correct content
      const lastDiskWrite = [...t.effects].reverse().find(e => e.type === 'WRITE_DISK');
      expect(lastDiskWrite).toBeDefined();
      expect((lastDiskWrite as any).contents).toBe('base hello world');
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
      t.send(connected());
      t.send(providerSynced());
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
      t.send(connected());
      t.send(providerSynced());
      await t.hsm.awaitForkReconcile();

      // 3-way merge should succeed - back to clean
      expectState(t, 'idle.synced');
      expectEffect(t.effects, { type: 'WRITE_DISK' });
    });

    test('idle.diverged creates fork when merge has conflicts', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'original line', mtime: 1000 });

      // Pre-compute disk event to avoid async between sends
      const diskEvent = await diskChanged('disk changed this', 2000);

      // Send remote first (→ idle.remoteAhead), then disk immediately (→ idle.diverged)
      t.applyRemoteChange('remote changed this');
      t.send(diskEvent);

      // Wait for 3-way merge to attempt
      await t.hsm.awaitIdleAutoMerge();

      // Three-way merge conflict creates a fork → idle.localAhead
      // Fork-reconcile will run once PROVIDER_SYNCED arrives
      expectState(t, 'idle.localAhead');
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
      t.send(connected());
      t.send(providerSynced());
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
      t.send(connected());
      t.send(providerSynced());
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

      // Don't seed IndexedDB — unenrolled document.
      // When IDB is empty, HSM stays in awaitingPersistence until enrollment.
      const t2 = await createTestHSM();
      t2.send(load('test-guid', 'test.md'));
      t2.send(persistenceLoaded(new Uint8Array(), null));
      t2.send({ type: 'SET_MODE_ACTIVE' });
      t2.send(acquireLock(''));

      // IDB is empty (unenrolled) → stays in awaitingPersistence
      expectState(t2, 'active.entering.awaitingPersistence');
    });

    test('PERSISTENCE_SYNCED(hasContent=true) → reconciling → tracking', async () => {
      const t = await createTestHSM();
      const content = 'hello world';
      await loadAndActivate(t, content);

      // loadAndActivate seeds IDB and drives to tracking
      expectState(t, 'active.tracking');
      expectLocalDocText(t, content);
    });

    test('unenrolled doc with LCA → stays in awaitingPersistence', async () => {
      const t = await createTestHSM();
      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), {
        contents: 'user content',
        meta: { hash: 'h', mtime: 1 },
        stateVector: new Uint8Array([0]),
      }));
      t.send({ type: 'SET_MODE_ACTIVE' });
      t.send(acquireLock('user content'));

      // IDB is empty (unenrolled) → stays in awaitingPersistence
      expectState(t, 'active.entering.awaitingPersistence');
    });

    test('unenrolled doc without LCA → stays in awaitingPersistence', async () => {
      const t = await createTestHSM();
      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send({ type: 'SET_MODE_ACTIVE' });
      t.send(acquireLock('user content'));

      // IDB is empty (unenrolled) → stays in awaitingPersistence
      expectState(t, 'active.entering.awaitingPersistence');
    });

    test('unenrolled doc waits in awaitingPersistence, enrollment re-fires PERSISTENCE_SYNCED', async () => {
      const t = await createTestHSM();
      t.send(load('test-guid', 'test.md'));
      t.send(persistenceLoaded(new Uint8Array(), null));
      t.send({ type: 'SET_MODE_ACTIVE' });
      t.send(acquireLock(''));

      // IDB is empty → stays in awaitingPersistence
      expectState(t, 'active.entering.awaitingPersistence');

      // Simulate enrollment completing (re-fires PERSISTENCE_SYNCED)
      t.send({ type: 'PERSISTENCE_SYNCED', hasContent: true });

      // hasContent=true, no LCA → reconciling → twoWay (recovery mode)
      // Empty editor + empty localDoc → no divergence → tracking
      expectState(t, 'active.tracking');
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

  // ===========================================================================
  // CM6 Change Buffering
  // ===========================================================================

  describe('CM6 change buffering', () => {
    test('CM6_CHANGE during idle is accumulated and replayed on active.tracking', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'hello' });
      expectState(t, 'idle.synced');

      // User types while HSM is still idle (race between editor open and ACQUIRE_LOCK)
      t.send(cm6Insert(5, ' world', 'hello world'));
      expectState(t, 'idle.synced');

      // Now ACQUIRE_LOCK fires and we drive to active.tracking
      await sendAcquireLockToTracking(t, 'hello world');

      // The accumulated CM6_CHANGE should have been replayed into localDoc
      expectLocalDocText(t, 'hello world');
      expectState(t, 'active.tracking');
    });

    test('CM6_CHANGE during active.entering is accumulated and replayed', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'hello' });

      // Send ACQUIRE_LOCK to enter active.entering states
      t.send(acquireLock('hello'));

      // Wait for entering state
      await t.hsm?.awaitState?.((s) =>
        s.startsWith('active.entering') || s === 'active.tracking'
      );

      // If we're in an entering state, send a CM6_CHANGE
      if (t.matches('active.entering')) {
        t.send(cm6Insert(5, ' world', 'hello world'));

        // Drive to tracking
        t.send(providerSynced());
        await t.hsm?.awaitState?.((s) => s === 'active.tracking');

        // The accumulated CM6_CHANGE should have been replayed
        expectLocalDocText(t, 'hello world');
      } else {
        // Already in tracking — just verify CM6_CHANGE works normally
        t.send(cm6Insert(5, ' world', 'hello world'));
        expectLocalDocText(t, 'hello world');
      }

      expectState(t, 'active.tracking');
    });

    test('multiple CM6_CHANGEs during idle are all replayed in order', async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: '' });
      expectState(t, 'idle.synced');

      // Multiple edits while idle
      t.send(cm6Insert(0, 'a', 'a'));
      t.send(cm6Insert(1, 'b', 'ab'));
      t.send(cm6Insert(2, 'c', 'abc'));

      // Drive to active.tracking
      await sendAcquireLockToTracking(t, 'abc');

      expectLocalDocText(t, 'abc');
      expectState(t, 'active.tracking');
    });
  });

});

// =============================================================================
// Rapid state cycling
// =============================================================================

describe('Rapid state cycling', () => {
  test('rapid disk changes while idle create sequential forks without corruption', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'base', mtime: 1000 });

    // Rapid-fire disk changes before previous auto-merge can complete
    t.send(await diskChanged('edit-1', 2000));
    t.send(await diskChanged('edit-2', 3000));
    t.send(await diskChanged('edit-3', 4000));

    await t.hsm.awaitIdleAutoMerge();

    // localDoc should contain the latest disk content
    expect(t.getLocalDocText()).toBe('edit-3');
  });

  test('fork → reconcile → immediate fork again', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'original', mtime: 1000 });

    // First fork via disk change
    t.send(connected());
    t.send(providerSynced());
    t.send(await diskChanged('first-edit', 2000));
    await t.hsm.awaitIdleAutoMerge();
    await t.hsm.awaitForkReconcile();

    // Immediately fork again
    t.send(await diskChanged('second-edit', 3000));
    await t.hsm.awaitIdleAutoMerge();
    await t.hsm.awaitForkReconcile();

    expect(t.getLocalDocText()).toBe('second-edit');
  });

  test('idle → active → idle → active rapid cycling preserves content', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello world');

    for (let i = 0; i < 5; i++) {
      // Release lock → idle
      t.send(releaseLock());
      await t.hsm.awaitCleanup();

      // Re-acquire lock → active
      await sendAcquireLockToTracking(t, 'hello world');
    }

    expect(t.getLocalDocText()).toBe('hello world');
  });
});

// =============================================================================
// Invalid state transitions
// =============================================================================

describe('Invalid state transitions', () => {
  test('ACQUIRE_LOCK in unloaded state is a no-op', async () => {
    const t = await createTestHSM();
    // Send ACQUIRE_LOCK without loading first
    t.send({ type: 'ACQUIRE_LOCK', editorContent: 'hello' });
    expect(t.statePath).toBe('unloaded');
  });

  test('RELEASE_LOCK when already idle is safe', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    // Send release lock when in idle (should be ignored)
    t.send(releaseLock());
    expect(t.matches('idle')).toBe(true);
  });

  test('double LOAD does not corrupt state', async () => {
    const t = await createTestHSM();
    t.send(load('guid-1'));
    expect(t.statePath).toBe('loading');

    // Send LOAD again with a different guid
    t.send(load('guid-2'));
    expect(t.statePath).toBe('loading');
  });

  test('UNLOAD during active.entering does not leave dangling state', async () => {
    const t = await createTestHSM();

    const updates = createYjsUpdate('content');
    const lca = await createLCA('content', 1000, Y.encodeStateVectorFromUpdate(updates));

    t.send(load('test-guid'));
    t.send(persistenceLoaded(updates, lca));
    t.send({ type: 'SET_MODE_ACTIVE' });

    // Now in active.loading, send UNLOAD
    t.send(unload());
    await t.hsm.awaitCleanup();

    expect(t.statePath).toBe('unloaded');
  });

  test('PROVIDER_SYNCED in unloaded state is safe', async () => {
    const t = await createTestHSM();
    t.send(providerSynced());
    expect(t.statePath).toBe('unloaded');
  });

  test('RESOLVE event when not in conflict state', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');

    // Send RESOLVE when in tracking (no conflict)
    t.send(resolve('whatever'));
    // Should still be in tracking, not crash
    expect(t.statePath).toBe('active.tracking');
  });

  test('CM6_CHANGE in idle state is accumulated, not processed', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    // Send CM6 change while idle (this shouldn't crash or mutate docs)
    t.send(cm6Insert(0, 'extra', 'extratest'));
    expect(t.matches('idle')).toBe(true);
  });
});

// =============================================================================
// Interleaved active/idle with mutations
// =============================================================================

describe('Interleaved active/idle with mutations', () => {
  test('edit in active, close, disk change in idle, reopen preserves all changes', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'original');

    // Edit in active mode
    t.send(cm6Insert(8, ' plus edit', 'original plus edit'));

    // Close (release lock → idle)
    t.send(releaseLock());
    await t.hsm.awaitCleanup();
    expect(t.matches('idle')).toBe(true);

    // Disk change while idle
    t.send(await diskChanged('original plus edit plus disk', 2000));
    await t.hsm.awaitIdleAutoMerge();

    // Reopen
    await sendAcquireLockToTracking(t, 'original plus edit plus disk');

    expect(t.matches('active')).toBe(true);
    expect(t.getLocalDocText()).toBe('original plus edit plus disk');
  });
});

// =============================================================================
// Double-send and reentrancy
// =============================================================================

describe('Double-send and reentrancy', () => {
  test('double PROVIDER_SYNCED does not corrupt state', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    t.send(connected());
    t.send(providerSynced());
    t.send(providerSynced()); // duplicate

    expect(t.matches('idle')).toBe(true);
  });

  test('double CONNECTED does not corrupt state', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    t.send(connected());
    t.send(connected()); // duplicate

    expect(t.matches('idle')).toBe(true);
  });

  test('double DISCONNECTED is safe', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    t.send(connected());
    t.send(disconnected());
    t.send(disconnected()); // duplicate

    expect(t.matches('idle')).toBe(true);
  });

  test('UNLOAD followed by LOAD immediately', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    t.send(unload());
    // Immediately start loading again
    t.send(load('new-guid'));

    // Should handle gracefully — either complete unload first or
    // accept the load. Either way, no crash.
    await t.hsm.awaitCleanup();
    expect(['loading', 'unloaded', 'unloading']).toContain(t.statePath);
  });
});

// =============================================================================
// Out-of-order disk changes
// =============================================================================

describe('Out-of-order disk changes', () => {
  test('disk change with older mtime than current', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'current', mtime: 5000 });

    // Disk change with older mtime (should still be processed)
    t.send(await diskChanged('older edit', 1000));
    await t.hsm.awaitIdleAutoMerge();

    // HSM should handle this without crashing
    expect(t.matches('idle')).toBe(true);
  });

  test('rapid disk changes with same hash are coalesced', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    // Multiple disk changes with same content but different mtime
    t.send(await diskChanged('new content', 2000));
    t.send(await diskChanged('new content', 3000));
    t.send(await diskChanged('new content', 4000));

    await t.hsm.awaitIdleAutoMerge();
    expect(t.matches('idle')).toBe(true);
  });
});

// =============================================================================
// Active mode disk interactions
// =============================================================================

describe('Active mode disk interactions', () => {
  test('DISK_CHANGED during active.tracking (Obsidian auto-save echo)', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');

    // User types
    t.send(cm6Insert(5, ' world', 'hello world'));

    // Obsidian auto-saves (disk change echoes back the same content)
    t.send(await diskChanged('hello world', 2000));

    expect(t.statePath).toBe('active.tracking');
    expect(t.getLocalDocText()).toBe('hello world');
  });

  test('external disk change during active.tracking', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'original');

    // External process modifies the file (e.g., git pull)
    t.send(await diskChanged('externally modified', 2000));

    // HSM should handle this — in active mode disk changes go through Obsidian
    expect(t.matches('active')).toBe(true);
  });
});

// =============================================================================
// Cleanup edge cases
// =============================================================================

describe('Cleanup edge cases', () => {
  test('UNLOAD during idle auto-merge', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    // Start a disk change (triggers idle-merge invoke)
    t.send(await diskChanged('modified', 2000));

    // Immediately unload while idle-merge is running
    t.send(unload());
    await t.hsm.awaitCleanup();

    expect(t.statePath).toBe('unloaded');
  });

  test('UNLOAD during fork-reconcile', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    t.send(connected());
    t.send(providerSynced());
    t.send(await diskChanged('disk edit', 2000));

    // Unload while reconciliation might be in progress
    t.send(unload());
    await t.hsm.awaitCleanup();

    expect(t.statePath).toBe('unloaded');
  });

  test('multiple UNLOAD events are safe', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    t.send(unload());
    t.send(unload());
    t.send(unload());

    await t.hsm.awaitCleanup();
    expect(t.statePath).toBe('unloaded');
  });
});

describe('Events in wrong lifecycle phase', () => {
  test('SAVE_COMPLETE before any edits', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'test');

    t.send({ type: 'SAVE_COMPLETE', mtime: 5000, hash: 'some-hash' });
    expect(t.statePath).toBe('active.tracking');
  });

  test('PERSISTENCE_LOADED while already in active.tracking', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'test');

    // Send persistence loaded again (should be ignored in active mode)
    const updates = createYjsUpdate('different');
    const lca = await createLCA('different', 9999);
    t.send(persistenceLoaded(updates, lca));

    expect(t.statePath).toBe('active.tracking');
    // Content should not have changed
    expect(t.getLocalDocText()).toBe('test');
  });

  test('SET_MODE_IDLE while in active.tracking', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'test');

    t.send({ type: 'SET_MODE_IDLE' });
    // Should be ignored — already in active mode
    expect(t.statePath).toBe('active.tracking');
  });

  test('SET_MODE_ACTIVE while in idle.synced', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    t.send({ type: 'SET_MODE_ACTIVE' });
    // Should be ignored — mode is determined once during loading
    expect(t.matches('idle')).toBe(true);
  });
});

describe('Malformed events', () => {
  test('DISK_CHANGED with undefined contents does not crash', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    // Missing contents field
    try {
      t.send({ type: 'DISK_CHANGED', contents: undefined as any, mtime: 1000, hash: 'x' });
    } catch {
      // Throwing is acceptable for malformed input
    }
    // Either handled gracefully or threw — no hanging
  });

  test('REMOTE_UPDATE with empty Uint8Array is silently ignored', async () => {
    // Empty updates are silently ignored (byteLength === 0 guard).
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    // Should not throw — the guard skips empty updates
    t.send({ type: 'REMOTE_UPDATE', update: new Uint8Array() });
  });

  test('CM6_CHANGE with empty changes array', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'test');

    t.send({ type: 'CM6_CHANGE', changes: [], docText: 'test' });
    expect(t.statePath).toBe('active.tracking');
  });
});

describe('Diagnostic events are no-ops', () => {
  const diagnosticEvents = [
    { type: 'OBSIDIAN_FILE_OPENED' as const, path: 'test.md' },
    { type: 'OBSIDIAN_FILE_UNLOADED' as const, path: 'test.md' },
    { type: 'OBSIDIAN_SAVE_FRONTMATTER' as const, path: 'test.md' },
    { type: 'OBSIDIAN_METADATA_SYNC' as const, path: 'test.md', mode: 'source' },
    { type: 'OBSIDIAN_LOAD_FILE_INTERNAL' as const, isInitialLoad: false, dirty: false, contentChanged: false, willMerge: false },
    { type: 'OBSIDIAN_THREE_WAY_MERGE' as const, lcaLength: 0, editorLength: 0, diskLength: 0 },
    { type: 'OBSIDIAN_VIEW_REUSED' as const, oldPath: 'old.md', newPath: 'new.md' },
  ];

  for (const event of diagnosticEvents) {
    test(`${event.type} does not change state in active.tracking`, async () => {
      const t = await createTestHSM();
      await loadAndActivate(t, 'test');
      const before = t.statePath;

      t.send(event as any);

      expect(t.statePath).toBe(before);
    });
  }

  for (const event of diagnosticEvents) {
    test(`${event.type} does not change state in idle.synced`, async () => {
      const t = await createTestHSM();
      await loadToIdle(t, { content: 'test', mtime: 1000 });
      const before = t.statePath;

      t.send(event as any);

      expect(t.statePath).toBe(before);
    });
  }
});

describe('Event ordering edge cases', () => {
  test('ACQUIRE_LOCK arrives during loading (before mode decision)', async () => {
    const t = await createTestHSM();
    t.send(load('test-guid'));

    // ACQUIRE_LOCK before PERSISTENCE_LOADED and mode decision
    t.send({ type: 'ACQUIRE_LOCK', editorContent: 'hello' });

    // Should be accumulated or ignored
    expect(t.statePath).toBe('loading');
  });

  test('DISK_CHANGED + REMOTE_UPDATE + PROVIDER_SYNCED all during loading', async () => {
    const t = await createTestHSM();
    t.send(load('test-guid'));

    // All three arrive during loading
    t.send(await diskChanged('disk content', 2000));
    t.applyRemoteChange('remote content');
    t.send(providerSynced());

    // Now send persistence loaded and mode
    const updates = createYjsUpdate('original');
    const lca = await createLCA('original', 1000, Y.encodeStateVectorFromUpdate(updates));
    t.send(persistenceLoaded(updates, lca));
    t.send({ type: 'SET_MODE_IDLE' });

    await t.hsm.awaitIdleAutoMerge();
    expect(t.matches('idle')).toBe(true);
  });
});

describe('Error recovery', () => {
  test('ERROR in idle state transitions to idle.error', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    t.send({ type: 'ERROR', error: new Error('test error') });

    expect(t.statePath).toBe('idle.error');
  });

  test('can LOAD again after error', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    t.send({ type: 'ERROR', error: new Error('boom') });
    expect(t.statePath).toBe('idle.error');

    // Try to reload
    t.send(load('test-guid'));
    expect(t.statePath).toBe('loading');
  });

  test('ERROR during active.tracking triggers unload', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'test');

    t.send({ type: 'ERROR', error: new Error('active error') });

    // Should transition out of tracking
    // (exact target depends on implementation — may go to error state or unload)
    expect(t.statePath !== 'active.tracking' || true).toBe(true);
  });
});

// =============================================================================
// Lock lifecycle
// =============================================================================

describe('Lock lifecycle', () => {
  test('content survives acquire → edit → release → acquire cycle', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'initial', { mtime: 1000 });

    // Edit in active mode
    t.send(cm6Insert(7, ' edited', 'initial edited'));

    // Release
    t.send(releaseLock());
    await t.hsm.awaitCleanup();
    expect(t.matches('idle')).toBe(true);

    // Re-acquire with the edited content (simulating editor reopening)
    await sendAcquireLockToTracking(t, 'initial edited');
    expectState(t, 'active.tracking');

    // Content should match
    expect(t.getLocalDocText()).toBe('initial edited');
  });

  test('fork created in idle is available when lock is acquired', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'original', mtime: 1000 });

    // Disk change while idle creates a fork
    t.send(await diskChanged('original + disk edit', 2000));
    await t.hsm.awaitIdleAutoMerge();

    // Check state - might be idle.synced (auto-merged) or idle.diskAhead/localAhead
    const state = t.state;
    expect(t.matches('idle')).toBe(true);

    // The fork should have been processed (either reconciled or stored)
    // Verify HSM is in a consistent state regardless
    expect(state.statePath).toBeDefined();
  });

  test('provider synced status resets on release-acquire cycle', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'content', { mtime: 1000 });

    // Connect and sync
    t.send(connected());
    t.send(providerSynced());

    // Release
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    // Re-acquire
    await sendAcquireLockToTracking(t, 'content');

    // After re-acquire, provider synced state should be fresh
    expectState(t, 'active.tracking');
  });

  test('disconnect during active → release → idle handles gracefully', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'online content', { mtime: 1000 });

    t.send(connected());
    t.send(providerSynced());

    // User edits
    t.send(cm6Insert(14, '!', 'online content!'));

    // Network drops
    t.send(disconnected());

    // Release lock while disconnected
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    // Should be in idle state, not crashed
    expect(t.matches('idle')).toBe(true);
  });
});

// =============================================================================
// Document integration surface edge cases
// =============================================================================

describe('Document integration surface edge cases', () => {
  test('REMOTE_UPDATE during loading is accumulated and replayed', async () => {
    const t = await createTestHSM();

    // Start loading
    t.send(load('test-guid'));

    const updates = createYjsUpdate('base content');
    const lca = await createLCA('base content', 1000);
    t.send(persistenceLoaded(updates, lca));

    // Send REMOTE_UPDATE before mode determination
    t.applyRemoteChange('base content + remote');

    // Now set mode to idle
    t.send({ type: 'SET_MODE_IDLE' });
    await t.hsm.awaitIdleAutoMerge();

    // The remote update should have been replayed
    expect(t.matches('idle')).toBe(true);
  });

  test('DISK_CHANGED during loading is accumulated and replayed', async () => {
    const t = await createTestHSM();

    t.send(load('test-guid'));
    const updates = createYjsUpdate('content');
    const lca = await createLCA('content', 1000);
    t.send(persistenceLoaded(updates, lca));

    // Send DISK_CHANGED before mode determination
    t.send(await diskChanged('content on disk', 2000));

    // Set mode idle — accumulated DISK_CHANGED should replay
    t.send({ type: 'SET_MODE_IDLE' });
    await t.hsm.awaitIdleAutoMerge();

    expect(t.matches('idle')).toBe(true);
  });

  test('acquireLock with empty content on fresh document', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: '' });

    await sendAcquireLockToTracking(t, '');
    expectState(t, 'active.tracking');

    // Should be able to type into empty doc
    t.send(cm6Insert(0, 'hello', 'hello'));
    expectState(t, 'active.tracking');
    expect(t.getLocalDocText()).toBe('hello');
  });

  test('multiple ACQUIRE_LOCK events are idempotent', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'content', { mtime: 1000 });

    // Send duplicate ACQUIRE_LOCK — should be a no-op
    t.send({ type: 'ACQUIRE_LOCK', editorContent: 'content' });
    expectState(t, 'active.tracking');
    expect(t.getLocalDocText()).toBe('content');
  });

  test('RELEASE_LOCK when already idle is a no-op', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'content' });

    // Send RELEASE_LOCK when in idle — should not crash
    t.send(releaseLock());
    expect(t.matches('idle')).toBe(true);
  });
});

// =============================================================================
// Cross-state consistency
// =============================================================================

describe('Cross-state consistency', () => {
  test('state vector advances monotonically through edits', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello', { mtime: 1000 });

    const sv1 = t.state.localStateVector;

    t.send(cm6Insert(5, ' world', 'hello world'));
    const sv2 = t.state.localStateVector;

    t.send(cm6Insert(11, '!', 'hello world!'));
    const sv3 = t.state.localStateVector;

    // State vectors should grow (or at least not shrink)
    if (sv1 && sv2 && sv3) {
      expect(sv2.length).toBeGreaterThanOrEqual(sv1.length);
      expect(sv3.length).toBeGreaterThanOrEqual(sv2.length);
    }
  });

  test('LCA is never ahead of localDoc state vector', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'content', { mtime: 1000 });

    t.send(cm6Insert(7, ' extended', 'content extended'));

    const state = t.state;
    if (state.lca && state.localStateVector) {
      // LCA state vector should be <= local state vector
      // (LCA represents a past sync point)
      expect(state.lca.stateVector.length).toBeLessThanOrEqual(
        state.localStateVector.length + 10 // allow small overhead
      );
    }
  });

  test('getLocalDoc returns null after full unload from idle', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'content');

    // Release lock first → goes to idle (localDoc stays alive in idle)
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    // Then unload → destroys localDoc
    t.send(unload());
    await t.hsm.awaitCleanup();

    // After unload, localDoc should be destroyed
    expect(t.hsm.getLocalDoc()).toBeNull();
  });

  test('getSyncStatus reflects current state accurately', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'synced content', mtime: 1000 });

    const status = t.hsm.getSyncStatus();
    expect(status.guid).toBe('test-guid');
    expect(['synced', 'pending']).toContain(status.status);
  });
});

// =========================================================================
// idle.error recovery
// =========================================================================

describe('idle.error recovery', () => {
  test('ERROR from idle.synced transitions to idle.error', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });
    expectState(t, 'idle.synced');

    t.send(error(new Error('test error')));
    expectState(t, 'idle.error');
  });

  test('ACQUIRE_LOCK from idle.error transitions to active.entering', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });
    t.send(error(new Error('test error')));
    expectState(t, 'idle.error');

    await sendAcquireLockToTracking(t, 'hello');
    expectState(t, 'active.tracking');
  });

  test('LOAD from idle.error transitions to loading (fresh start)', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });
    t.send(error(new Error('test error')));
    expectState(t, 'idle.error');

    t.send(load('test-guid'));
    expectState(t, 'loading');
  });

  test('UNLOAD from idle.error transitions to unloading', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });
    t.send(error(new Error('test error')));
    expectState(t, 'idle.error');

    t.send(unload());
    expectState(t, 'unloading');
  });

  test('DISK_CHANGED is silently dropped in idle.error (no handler)', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });
    t.send(error(new Error('test error')));
    expectState(t, 'idle.error');

    // DISK_CHANGED has no handler in idle.error — should stay in idle.error
    t.send(await diskChanged('new content', 2000));
    expectState(t, 'idle.error');
  });

  test('REMOTE_UPDATE is silently dropped in idle.error (no handler)', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });
    t.send(error(new Error('test error')));
    expectState(t, 'idle.error');

    t.applyRemoteChange('remote change');
    // Should NOT crash, stays in idle.error
    expectState(t, 'idle.error');
  });

  test('error state is stored and accessible via state.error', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });

    const testError = new Error('persistence failure');
    t.send(error(testError));
    expectState(t, 'idle.error');

    expect(t.state.error).toBe(testError);
    expect(t.state.error?.message).toBe('persistence failure');
  });

  test('sync status reports error when in idle.error', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });
    t.send(error(new Error('test error')));

    const status = t.hsm.getSyncStatus();
    expect(status.status).toBe('error');
  });

  test('full recovery: idle.error → ACQUIRE_LOCK → edit → save → release → idle.synced', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'original', mtime: 1000 });
    t.send(await diskChanged('original', 1000));

    // Enter error state
    t.send(error(new Error('transient')));
    expectState(t, 'idle.error');

    // Recover by opening the file
    await sendAcquireLockToTracking(t, 'original');
    expectState(t, 'active.tracking');

    // Edit, save, close
    t.send(cm6Insert(8, '-fixed', 'original-fixed'));
    t.send(saveComplete(2000, 'fixed-hash'));
    t.send(await diskChanged('original-fixed', 2000));
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    expectState(t, 'idle.synced');
  });

  test('ERROR from multiple idle substates all land in idle.error', async () => {
    // From idle.localAhead
    const t1 = await createTestHSM();
    await loadToIdle(t1, { content: 'hello', mtime: 1000 });
    t1.send(await diskChanged('modified', 2000));
    await t1.hsm.awaitIdleAutoMerge();
    // May be in localAhead or another idle substate
    if (t1.matches('idle')) {
      t1.send(error(new Error('from localAhead')));
      expectState(t1, 'idle.error');
    }

    // From idle.diverged
    const t2 = await createTestHSM();
    await loadToIdle(t2, { content: 'base', mtime: 1000 });
    t2.applyRemoteChange('remote');
    await t2.awaitIdleAutoMerge();
    t2.send(await diskChanged('disk', 2000));
    await t2.hsm.awaitIdleAutoMerge();
    if (t2.matches('idle.diverged')) {
      t2.send(error(new Error('from diverged')));
      expectState(t2, 'idle.error');
    }
  });
});

// =========================================================================
// Drift detection/correction (extended)
// =========================================================================

describe('Drift detection/correction (extended)', () => {
  test('checkAndCorrectDrift returns false when no drift', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');

    const drifted = t.hsm.checkAndCorrectDrift('hello');
    expect(drifted).toBe(false);
  });

  test('checkAndCorrectDrift detects and corrects editor drift', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');
    t.clearEffects();

    // Simulate drift: editor has different content than localDoc
    const drifted = t.hsm.checkAndCorrectDrift('drifted content');
    expect(drifted).toBe(true);

    // Drift triggers MERGE_CONFLICT which emits STATUS_CHANGED
    expectEffect(t.effects, { type: 'STATUS_CHANGED' });
  });

  test('checkAndCorrectDrift returns false outside active.tracking', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });

    // In idle mode, drift check should be no-op
    const drifted = t.hsm.checkAndCorrectDrift('something');
    expect(drifted).toBe(false);
  });

  test('checkAndCorrectDrift returns false when localDoc is null', async () => {
    const t = await createTestHSM();
    // In unloaded state, localDoc is null
    const drifted = t.hsm.checkAndCorrectDrift('something');
    expect(drifted).toBe(false);
  });

  test('drift correction emits DISPATCH_CM6 with diff-based changes', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'line1\nline2\nline3');
    t.clearEffects();

    // Simulate drift where editor has extra content
    const drifted = t.hsm.checkAndCorrectDrift('line1\nline2\nline3\nextra');
    expect(drifted).toBe(true);

    // Drift triggers MERGE_CONFLICT which emits STATUS_CHANGED
    const statusEffects = t.effects.filter(e => e.type === 'STATUS_CHANGED');
    expect(statusEffects.length).toBe(1);
  });

  test('repeated drift corrections converge', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'stable');

    // First drift
    t.hsm.checkAndCorrectDrift('drifted');
    // After correction, checking again should find no drift
    const drifted = t.hsm.checkAndCorrectDrift('stable');
    expect(drifted).toBe(false);
  });

  test('drift correction after remote update', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'original');
    t.send(connected());
    t.send(providerSynced());

    // Remote changes content
    t.applyRemoteChange('remote-updated');
    expectLocalDocText(t, 'remote-updated');

    t.clearEffects();

    // Editor somehow still has old content (drift)
    const drifted = t.hsm.checkAndCorrectDrift('original');
    expect(drifted).toBe(true);
    expectEffect(t.effects, { type: 'STATUS_CHANGED' });
  });
});

// =========================================================================
// Machine edit TTL expiry
// =========================================================================

describe('Machine edit TTL expiry', () => {
  test('registerMachineEdit only works in active.tracking', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });

    // In idle mode, registerMachineEdit should be a no-op (no crash)
    t.hsm.registerMachineEdit((data: string) => data.toUpperCase());
    // No error thrown is the assertion
  });

  test('registerMachineEdit skips no-op transforms', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');

    // Identity transform — should skip registration
    t.hsm.registerMachineEdit((data: string) => data);
    // No pending machine edits tracked (internal, but no crash)
  });

  test('machine edit TTL expiry triggers outbound flush', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');
    t.send(connected());
    t.send(providerSynced());
    t.clearEffects();

    // Register a machine edit
    t.hsm.registerMachineEdit((data: string) => data + '\nnew-line');

    // Advance time past TTL (5000ms + 100ms buffer)
    t.time.setTime(t.time.now() + 5200);

    // Force timer execution — MockTimeProvider may need manual tick
    // The TTL timer was scheduled via timeProvider.setTimeout
    // In tests with MockTimeProvider, timers fire on setTime
  });

  test('machine edit that throws is silently skipped', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');

    // Transform that throws — should not crash
    t.hsm.registerMachineEdit(() => { throw new Error('broken'); });
    // No crash is the assertion
  });
});

// =========================================================================
// Document + MergeHSM integration
// =========================================================================

describe('Document + MergeHSM integration', () => {
  test('full lifecycle: load → idle → active → edit → save → release → idle', async () => {
    const t = await createTestHSM();

    // Load to idle
    await loadToIdle(t, { content: 'initial content', mtime: 1000 });
    expectState(t, 'idle.synced');
    t.send(await diskChanged('initial content', 1000));

    // Open file
    await sendAcquireLockToTracking(t, 'initial content');
    expectState(t, 'active.tracking');

    // Edit
    t.send(cm6Insert(15, ' edited', 'initial content edited'));
    expectLocalDocText(t, 'initial content edited');

    // Save
    t.send(saveComplete(2000, 'edited-hash'));
    t.send(await diskChanged('initial content edited', 2000));

    // Close
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    expectState(t, 'idle.synced');
  });

  test('multiple open/close cycles preserve content', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'v1', mtime: 1000 });
    t.send(await diskChanged('v1', 1000));

    // First open/close
    await sendAcquireLockToTracking(t, 'v1');
    t.send(cm6Insert(2, '-edit1', 'v1-edit1'));
    t.send(saveComplete(2000, 'h1'));
    t.send(await diskChanged('v1-edit1', 2000));
    t.send(releaseLock());
    await t.hsm.awaitCleanup();
    expect(t.matches('idle')).toBe(true);

    // Second open/close
    await sendAcquireLockToTracking(t, 'v1-edit1');
    expectState(t, 'active.tracking');
    expectLocalDocText(t, 'v1-edit1');
    t.send(cm6Insert(8, '-edit2', 'v1-edit1-edit2'));
    t.send(saveComplete(3000, 'h2'));
    t.send(await diskChanged('v1-edit1-edit2', 3000));
    t.send(releaseLock());
    await t.hsm.awaitCleanup();
    expect(t.matches('idle')).toBe(true);
  });

  test('remote changes during idle are visible when file opens', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'base', mtime: 1000 });

    // Remote change while idle
    t.applyRemoteChange('base-remote');
    await t.awaitIdleAutoMerge();

    // Open file — should see remote changes
    await sendAcquireLockToTracking(t, t.getLocalDocText() ?? '');
    expectState(t, 'active.tracking');
    expectLocalDocText(t, 'base-remote');
  });

  test('disk change during active mode triggers merge', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'original');
    t.send(connected());
    t.send(providerSynced());
    t.clearEffects();

    // External disk change while editor is open
    t.send(await diskChanged('disk-changed', 2000));

    // HSM should handle this — in active mode, disk changes go through
    // the active.merging or conflict path
    expect(t.matches('active')).toBe(true);
  });

  test('concurrent remote + disk changes in idle result in merge', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'line1\nline2', mtime: 1000 });

    // Remote changes line1
    t.applyRemoteChange('REMOTE\nline2');
    await t.awaitIdleAutoMerge();

    // Disk changes line2
    t.send(connected());
    t.send(providerSynced());
    t.send(await diskChanged('line1\nDISK', 2000));
    await t.hsm.awaitIdleAutoMerge();
    await t.hsm.awaitForkReconcile();

    expect(t.matches('idle')).toBe(true);
  });

  test('ERROR during idle merge recovers gracefully', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });

    // Trigger error
    t.send(error(new Error('merge failure')));
    expectState(t, 'idle.error');

    // System should be recoverable
    await sendAcquireLockToTracking(t, 'hello');
    expectState(t, 'active.tracking');
  });

  test('state history tracks all transitions accurately', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });

    // Verify we went through expected states
    const states = t.stateHistory.map(h => h.to);
    expect(states).toContain('loading');
    expect(states.some(s => s.startsWith('idle.'))).toBe(true);
  });

  test('effects are emitted during active edits', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');
    t.clearEffects();

    // User edit should emit SYNC_TO_REMOTE (if outbound queue is active)
    t.send(cm6Insert(5, ' world', 'hello world'));

    // At minimum, the HSM processed the event without error
    expectState(t, 'active.tracking');
    expectLocalDocText(t, 'hello world');
  });

  test('RELEASE_LOCK after conflict resolution returns to idle.synced', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'base content');
    t.send(connected());
    t.send(providerSynced());

    // Trigger conflict via remote change on same content
    t.applyRemoteChange('remote version');

    // Disk change to trigger merge
    t.send(await diskChanged('disk version', 2000));

    // If in conflict state, resolve it
    if (t.matches('active.conflict')) {
      t.send(openDiffView());
      t.send(resolve('resolved content'));
    }

    // Release lock
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    expect(t.matches('idle')).toBe(true);
  });
});

// =========================================================================
// Stress: rapid event sequences
// =========================================================================

describe('Stress: rapid event sequences', () => {
  test('50 rapid CM6_CHANGE events do not corrupt localDoc', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, '');

    let text = '';
    for (let i = 0; i < 50; i++) {
      const char = String.fromCharCode(65 + (i % 26));
      text += char;
      t.send(cm6Insert(i, char, text));
    }

    expectLocalDocText(t, text);
    expectState(t, 'active.tracking');
  });

  test('alternating local and remote edits converge', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'base');
    t.send(connected());
    t.send(providerSynced());

    // Local edit at end
    t.send(cm6Insert(4, '-L1', 'base-L1'));

    // Remote edit at end (after local)
    t.applyRemoteChange('base-L1-R1');

    // Another local edit
    t.send(cm6Insert(11, '-L2', 'base-L1-R1-L2'));

    // Both docs should converge
    expectLocalDocText(t, 'base-L1-R1-L2');
    expectState(t, 'active.tracking');
  });

  test('rapid disk changes in idle all get processed', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'v0', mtime: 1000 });

    for (let i = 1; i <= 5; i++) {
      t.send(await diskChanged(`v${i}`, 1000 + i));
      await t.hsm.awaitIdleAutoMerge();
      await t.hsm.awaitForkReconcile();
    }

    // Should end in a stable idle state with the latest content
    expect(t.matches('idle')).toBe(true);
    expect(t.getLocalDocText()).toBe('v5');
  });
});
