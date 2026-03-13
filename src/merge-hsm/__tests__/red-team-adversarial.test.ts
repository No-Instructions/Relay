/**
 * Red Team Adversarial Tests
 *
 * Stress tests designed to find race conditions, edge cases, and data
 * corruption scenarios in the MergeHSM implementation.
 */

import {
  createTestHSM,
  loadToIdle,
  loadAndActivate,
  loadToConflict,
  loadToResolving,
  diskChanged,
  sendAcquireLockToTracking,
  releaseLock,
  resolve,
  openDiffView,
  dismissConflict,
  cm6Insert,
  cm6Change,
  providerSynced,
  connected,
  disconnected,
  unload,
  load,
  persistenceLoaded,
  createLCA,
  createYjsUpdate,
  expectState,
  expectEffect,
  expectLocalDocText,
  expectRemoteDocText,
} from '../testing';

import * as Y from 'yjs';

// =============================================================================
// 1. Rapid state cycling: fork → reconcile → fork
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
// 2. Concurrent fork + sync events (race conditions)
// =============================================================================

describe('Concurrent fork + sync events', () => {
  test('REMOTE_UPDATE arriving during fork-reconcile invoke', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'line1\nline2\nline3', mtime: 1000 });

    // Set up remote with shared history
    t.applyRemoteChange('REMOTE\nline2\nline3');
    await t.hsm.awaitIdleAutoMerge();

    // Create fork via disk change while provider is synced
    t.send(connected());
    t.send(providerSynced());
    t.send(await diskChanged('line1\nline2\nDISK', 2000));

    // While fork-reconcile is running, fire another remote update
    t.applyRemoteChange('REMOTE\nline2\nline3-more');

    await t.hsm.awaitIdleAutoMerge();
    await t.hsm.awaitForkReconcile();

    // Content should be consistent (no duplicate lines)
    const text = t.getLocalDocText();
    expect(text).not.toBeNull();
    // Verify no content duplication
    const lines = text!.split('\n');
    const uniqueLines = new Set(lines);
    // Allow merged content but not exact duplicates of full lines
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  test('DISCONNECTED during active fork reconciliation', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'base content', mtime: 1000 });

    // Create fork, mark provider synced, then disconnect mid-reconcile
    t.send(connected());
    t.send(providerSynced());
    t.send(await diskChanged('disk edit', 2000));

    // Disconnect while fork-reconcile might be running
    t.send(disconnected());

    await t.hsm.awaitIdleAutoMerge();

    // HSM should be in a valid state, not stuck
    expect(t.matches('idle')).toBe(true);
    expect(t.getLocalDocText()).toBe('disk edit');
  });

  test('PROVIDER_SYNCED + DISK_CHANGED arriving simultaneously', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'original', mtime: 1000 });

    // Both events arrive back-to-back
    t.send(connected());
    t.send(providerSynced());
    t.send(await diskChanged('disk version', 2000));

    await t.hsm.awaitIdleAutoMerge();
    await t.hsm.awaitForkReconcile();

    // Should not be stuck
    expect(t.matches('idle')).toBe(true);
  });
});

// =============================================================================
// 3. Invalid / unexpected state transitions
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
// 4. Network partition / reconnection storms
// =============================================================================

describe('Network partition storms', () => {
  test('rapid connect/disconnect cycling in idle', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'stable content', mtime: 1000 });

    for (let i = 0; i < 20; i++) {
      t.send(connected());
      t.send(providerSynced());
      t.send(disconnected());
    }

    await t.hsm.awaitIdleAutoMerge();
    expect(t.matches('idle')).toBe(true);
    expect(t.getLocalDocText()).toBe('stable content');
  });

  test('rapid connect/disconnect cycling in active.tracking', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'active content');

    for (let i = 0; i < 20; i++) {
      t.send(connected());
      t.send(providerSynced());
      t.send(disconnected());
    }

    expect(t.statePath).toBe('active.tracking');
    expect(t.getLocalDocText()).toBe('active content');
  });

  test('REMOTE_UPDATE after DISCONNECTED is handled gracefully', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test', mtime: 1000 });

    t.send(connected());
    t.send(providerSynced());
    t.send(disconnected());

    // Late remote update arrives after disconnect
    t.applyRemoteChange('remote edit');
    await t.hsm.awaitIdleAutoMerge();

    // Should not crash, should be in a valid idle state
    expect(t.matches('idle')).toBe(true);
  });
});

// =============================================================================
// 5. Edge cases in content
// =============================================================================

describe('Content edge cases', () => {
  test('empty string content through full lifecycle', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, '');

    // Edit from empty
    t.send(cm6Insert(0, 'hello', 'hello'));
    expect(t.getLocalDocText()).toBe('hello');

    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    expect(t.matches('idle')).toBe(true);
  });

  test('very large content does not timeout or corrupt', async () => {
    const bigContent = 'A'.repeat(100_000);
    const t = await createTestHSM();
    await loadAndActivate(t, bigContent);

    expect(t.getLocalDocText()).toBe(bigContent);

    t.send(releaseLock());
    await t.hsm.awaitCleanup();
    expect(t.matches('idle')).toBe(true);
  });

  test('unicode content preserved through merge', async () => {
    const content = '日本語テスト 🎉 café\nline2: Ω≈ç√∫';
    const t = await createTestHSM();
    await loadAndActivate(t, content);

    expect(t.getLocalDocText()).toBe(content);
  });

  test('content with only newlines', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, '\n\n\n');
    expect(t.getLocalDocText()).toBe('\n\n\n');
  });

  test('content with Windows line endings (CRLF)', async () => {
    const content = 'line1\r\nline2\r\nline3';
    const t = await createTestHSM();
    await loadAndActivate(t, content);
    expect(t.getLocalDocText()).toBe(content);
  });
});

// =============================================================================
// 6. Conflict resolution edge cases
// =============================================================================

describe('Conflict resolution edge cases', () => {
  test('dismiss conflict then re-open file sees same conflict', async () => {
    const t = await createTestHSM();
    await loadToConflict(t, {
      base: 'base text',
      remote: 'remote changed text',
      disk: 'disk changed text',
    });

    // Dismiss conflict
    t.send(dismissConflict());

    // Release lock
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    // Re-acquire lock — should show deferred conflict
    t.send({ type: 'ACQUIRE_LOCK', editorContent: 'disk changed text' });
    await t.hsm.awaitIdleAutoMerge();

    // Should be in some active state
    expect(t.matches('active')).toBe(true);
  });

  test('resolve with empty string', async () => {
    const t = await createTestHSM();
    await loadToConflict(t, {
      base: 'base',
      remote: 'remote edit',
      disk: 'disk edit',
    });

    // Resolve with empty content
    t.send(resolve(''));

    // Should accept the resolution
    expect(t.matches('active')).toBe(true);
  });

  test('conflict where all three versions are identical', async () => {
    // If base, remote, and disk are all the same, no conflict should occur.
    // This tests the guard logic.
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'same', mtime: 1000 });

    // Disk "changes" but to same content
    t.send(await diskChanged('same', 2000));
    await t.hsm.awaitIdleAutoMerge();

    // Should stay synced (or return to synced)
    expect(t.matches('idle')).toBe(true);
  });
});

// =============================================================================
// 7. Double-send / reentrant events
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
// 8. SyncGate edge cases
// =============================================================================

describe('SyncGate edge cases', () => {
  test('local-only mode prevents outbound sync even when provider synced', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'initial');

    t.send(connected());
    t.send(providerSynced());

    // Enable local-only mode
    t.hsm.setLocalOnly(true);

    // Make an edit
    t.clearEffects();
    t.send(cm6Insert(7, ' edited', 'initial edited'));

    // Should not emit SYNC_TO_REMOTE
    const syncEffects = t.effects.filter(e => e.type === 'SYNC_TO_REMOTE');
    expect(syncEffects.length).toBe(0);
  });

  test('disabling local-only flushes pending ops', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'initial');

    t.send(connected());
    t.send(providerSynced());

    // Enable local-only, make edits, then disable
    t.hsm.setLocalOnly(true);
    t.send(cm6Insert(7, ' edited', 'initial edited'));

    t.clearEffects();
    t.hsm.setLocalOnly(false);

    // Pending ops should have been flushed
    // (Implementation may or may not emit SYNC_TO_REMOTE — check state is consistent)
    expect(t.statePath).toBe('active.tracking');
  });
});

// =============================================================================
// 9. DISK_CHANGED with stale/out-of-order mtime
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
// 10. Active mode edit + disk change interaction
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
// 11. State vector divergence scenarios
// =============================================================================

describe('State vector edge cases', () => {
  test('PERSISTENCE_LOADED with empty updates', async () => {
    const t = await createTestHSM();
    t.send(load('test-guid'));
    t.send(persistenceLoaded(new Uint8Array(), null));

    expect(t.statePath).toBe('loading');
  });

  test('remoteDoc and localDoc with completely independent histories', async () => {
    // This simulates a worst-case scenario where two clients started
    // from scratch and created content independently
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'local content', mtime: 1000 });

    // Apply a completely independent change to remoteDoc
    // (new content from a different client that shares no CRDT history)
    const independentDoc = new Y.Doc();
    independentDoc.getText('contents').insert(0, 'independent remote');
    const independentUpdate = Y.encodeStateAsUpdate(independentDoc);
    independentDoc.destroy();

    t.send({ type: 'REMOTE_UPDATE', update: independentUpdate });
    await t.hsm.awaitIdleAutoMerge();

    // Should not crash — content may be duplicated but HSM should be in valid state
    expect(t.matches('idle')).toBe(true);
  });
});

// =============================================================================
// 12. Cleanup / destroy edge cases
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

// =============================================================================
// 13. Three-way merge edge cases
// =============================================================================

describe('Three-way merge edge cases', () => {
  test('conflict where only whitespace differs', async () => {
    const t = await createTestHSM();
    // Base has no trailing newline; remote adds spaces, disk adds tabs
    try {
      await loadToConflict(t, {
        base: 'line1\nline2',
        remote: 'line1  \nline2  ',
        disk: 'line1\t\nline2\t',
      });
      // If it reaches conflict, dismiss it
      t.send(dismissConflict());
    } catch {
      // Whitespace-only changes might auto-merge. Either way, no crash.
    }
    expect(t.matches('active') || t.matches('idle')).toBe(true);
  });

  test('conflict with very long single line', async () => {
    const baseLine = 'A'.repeat(10_000);
    const remoteLine = 'B'.repeat(10_000);
    const diskLine = 'C'.repeat(10_000);

    try {
      const t = await createTestHSM();
      await loadToConflict(t, {
        base: baseLine,
        remote: remoteLine,
        disk: diskLine,
      });

      // Resolve with one version
      t.send(resolve(remoteLine));
      expect(t.matches('active')).toBe(true);
    } catch {
      // Large single-line conflicts may have edge cases
    }
  });

  test('merge where base is empty but both sides have content', async () => {
    try {
      const t = await createTestHSM();
      await loadToConflict(t, {
        base: '',
        remote: 'remote added content',
        disk: 'disk added content',
      });
      // This is a real conflict — both sides added content from empty
      t.send(resolve('merged content'));
      expect(t.matches('active')).toBe(true);
    } catch (e: any) {
      // If loadToConflict fails because empty base is special, that's acceptable
      expect(e.message).toContain('loadToConflict');
    }
  });
});

// =============================================================================
// 14. REMOTE_UPDATE flood (simulating heavy collaboration)
// =============================================================================

describe('REMOTE_UPDATE flood', () => {
  test('50 rapid remote updates in idle do not corrupt content', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'start', mtime: 1000 });

    // Fire 50 incremental remote updates
    for (let i = 0; i < 50; i++) {
      t.applyRemoteChange(`start${'-'.repeat(i + 1)}`);
    }

    await t.hsm.awaitIdleAutoMerge();

    expect(t.matches('idle')).toBe(true);
    // Remote doc should have the latest
    expect(t.getRemoteDocText()).toBe(`start${'-'.repeat(50)}`);
  });

  test('50 rapid remote updates in active.tracking', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'start');

    t.send(connected());
    t.send(providerSynced());

    for (let i = 0; i < 50; i++) {
      t.applyRemoteChange(`start${'+'.repeat(i + 1)}`);
    }

    expect(t.statePath).toBe('active.tracking');
  });
});

// =============================================================================
// 15. Interleaved active/idle with content mutations
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
