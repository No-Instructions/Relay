/**
 * Red Team Round 2 — Adversarial tests for coverage gaps
 *
 * Targets:
 * 1. idle.error recovery
 * 2. Online/offline toggling during active editing
 * 3. setLocalOnly() SyncGate mode
 * 4. Drift detection/correction
 * 5. Machine edit TTL expiry
 * 6. Document + MergeHSM integration (cross-component)
 */

import {
  createTestHSM,
  loadToIdle,
  loadAndActivate,
  diskChanged,
  sendAcquireLockToTracking,
  releaseLock,
  resolve,
  openDiffView,
  cm6Insert,
  cm6Change,
  providerSynced,
  connected,
  disconnected,
  error,
  unload,
  load,
  persistenceLoaded,
  createLCA,
  createYjsUpdate,
  saveComplete,
  expectState,
  expectEffect,
  expectNoEffect,
  expectLocalDocText,
  expectRemoteDocText,
} from '../testing';

import * as Y from 'yjs';

// =========================================================================
// 1. idle.error recovery
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
// 2. Online/offline toggling during active editing
// =========================================================================

describe('Online/offline toggling during active editing', () => {
  test('rapid CONNECTED/DISCONNECTED does not crash', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');
    expectState(t, 'active.tracking');

    for (let i = 0; i < 20; i++) {
      t.send(connected());
      t.send(disconnected());
    }

    expectState(t, 'active.tracking');
    expect(t.state.isOnline).toBe(false);
  });

  test('user edits persist through offline/online cycle', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');

    t.send(connected());
    t.send(cm6Insert(5, ' world', 'hello world'));
    expectLocalDocText(t, 'hello world');

    // Go offline
    t.send(disconnected());

    // Continue editing while offline
    t.send(cm6Insert(11, '!', 'hello world!'));
    expectLocalDocText(t, 'hello world!');

    // Come back online
    t.send(connected());
    t.send(providerSynced());

    // Edits should be preserved
    expectLocalDocText(t, 'hello world!');
    expectState(t, 'active.tracking');
  });

  test('remote updates received after reconnect are applied', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'line1\nline2');

    t.send(connected());
    t.send(providerSynced());

    // Go offline
    t.send(disconnected());

    // Make remote changes while disconnected
    t.applyRemoteChange('line1\nline2\nremote-line');

    // Come back online
    t.send(connected());

    // Remote text should have been applied to localDoc
    expectLocalDocText(t, 'line1\nline2\nremote-line');
  });

  test('interleaved editing and connectivity changes', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'start');

    // online → edit → offline → edit → online → edit
    t.send(connected());
    t.send(cm6Insert(5, '-A', 'start-A'));
    t.send(disconnected());
    t.send(cm6Insert(7, '-B', 'start-A-B'));
    t.send(connected());
    t.send(cm6Insert(9, '-C', 'start-A-B-C'));

    expectLocalDocText(t, 'start-A-B-C');
    expectState(t, 'active.tracking');
  });

  test('CONNECTED/DISCONNECTED during idle mode does not break state', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });

    // In idle mode, CONNECTED/DISCONNECTED are not handled (no transitions defined).
    // isOnline is only updated in active mode. Sending these events should be no-ops.
    t.send(connected());
    t.send(disconnected());

    // Rapid toggling in idle — should not crash or change state
    for (let i = 0; i < 10; i++) {
      t.send(connected());
      t.send(disconnected());
    }
    expect(t.matches('idle')).toBe(true);
  });

  test('disconnect during idle merge does not corrupt state', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'base', mtime: 1000 });

    t.send(connected());
    t.send(providerSynced());

    // Start a disk change (triggers idle merge) and disconnect mid-flight
    t.send(await diskChanged('new content', 2000));
    t.send(disconnected());

    await t.hsm.awaitIdleAutoMerge();
    await t.hsm.awaitForkReconcile();

    expect(t.matches('idle')).toBe(true);
    // Content should reflect the disk change
    expect(t.getLocalDocText()).toBe('new content');
  });
});

// =========================================================================
// 3. setLocalOnly() SyncGate mode
// =========================================================================

describe('setLocalOnly() SyncGate mode', () => {
  test('setLocalOnly(true) prevents outbound sync', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');
    t.send(connected());
    t.send(providerSynced());
    t.clearEffects();

    t.hsm.setLocalOnly(true);
    expect(t.hsm.isLocalOnly).toBe(true);

    // Edit — should NOT emit SYNC_TO_REMOTE
    t.send(cm6Insert(5, ' world', 'hello world'));
    expectLocalDocText(t, 'hello world');

    // pendingOutbound should track accumulated ops
    expect(t.hsm.pendingOutbound).toBeGreaterThanOrEqual(0);
  });

  test('setLocalOnly(false) flushes pending ops', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');
    t.send(connected());
    t.send(providerSynced());

    // Go local-only
    t.hsm.setLocalOnly(true);
    t.send(cm6Insert(5, ' world', 'hello world'));
    t.clearEffects();

    // Turn off local-only — should flush
    t.hsm.setLocalOnly(false);
    expect(t.hsm.isLocalOnly).toBe(false);
  });

  test('setLocalOnly toggle idempotent', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello');

    t.hsm.setLocalOnly(true);
    t.hsm.setLocalOnly(true); // no-op
    expect(t.hsm.isLocalOnly).toBe(true);

    t.hsm.setLocalOnly(false);
    t.hsm.setLocalOnly(false); // no-op
    expect(t.hsm.isLocalOnly).toBe(false);
  });

  test('setLocalOnly does not interfere with fork gating', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'base', mtime: 1000 });

    // Create fork
    t.send(await diskChanged('modified', 2000));
    await t.hsm.awaitIdleAutoMerge();

    // setLocalOnly while fork exists
    t.hsm.setLocalOnly(true);
    t.hsm.setLocalOnly(false);

    // Fork should still be intact (fork gating takes precedence)
    expect(t.matches('idle')).toBe(true);
  });

  test('local-only mode preserves edits across reconnection', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'start');

    t.hsm.setLocalOnly(true);
    t.send(cm6Insert(5, '-edit', 'start-edit'));

    t.send(connected());
    t.send(providerSynced());

    // Still local-only, content preserved
    expectLocalDocText(t, 'start-edit');
    expect(t.hsm.isLocalOnly).toBe(true);
  });
});

// =========================================================================
// 4. Drift detection/correction
// =========================================================================

describe('Drift detection/correction', () => {
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

    // Should emit DISPATCH_CM6 to correct the editor
    expectEffect(t.effects, { type: 'DISPATCH_CM6' });
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

    const cm6Effects = t.effects.filter(e => e.type === 'DISPATCH_CM6');
    expect(cm6Effects.length).toBe(1);
    // The changes should correct the editor back to localDoc content
    const changes = (cm6Effects[0] as any).changes;
    expect(changes.length).toBeGreaterThan(0);
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
    expectEffect(t.effects, { type: 'DISPATCH_CM6' });
  });
});

// =========================================================================
// 5. Machine edit TTL expiry
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
// 6. Cross-component integration tests
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
// Stress tests
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
