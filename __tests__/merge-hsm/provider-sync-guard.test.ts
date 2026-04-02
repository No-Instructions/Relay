/**
 * Provider Sync Guard Tests
 *
 * Verifies that three-way auto-merge and fork reconciliation defer when
 * the provider hasn't synced yet.  Without these guards, remoteDoc may
 * contain empty or stale content, producing spurious MERGE_CONFLICT results.
 */

import {
  createTestHSM,
  loadToIdle,
  diskChanged,
  providerSynced,
  connected,
  expectState,
  expectLocalDocText,
} from 'src/merge-hsm/testing';

describe('Provider sync guard: invokeIdleThreeWayAutoMerge', () => {
  test('defers merge when fork exists and provider has not synced', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'base content', mtime: 1000 });

    // Remote changes arrive via CRDT (but provider not marked synced)
    t.applyRemoteChange('remote content');
    await t.awaitIdleAutoMerge();

    // Disk edit creates fork, transitions through diskAhead → localAhead
    t.send(await diskChanged('disk content', 2000));
    await t.hsm.awaitIdleAutoMerge();

    // Without provider sync, the HSM must NOT be in idle.synced with
    // conflict data — it should stay in localAhead or diverged, waiting.
    // The key assertion: no MERGE_CONFLICT should have been produced
    // from a three-way merge against unsynchronized remote content.
    expect(t.hsm.getConflictData()).toBeNull();
  });

  test('merge proceeds after PROVIDER_SYNCED and produces correct conflict data', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'original line', mtime: 1000 });

    // Disk edit creates fork
    t.send(await diskChanged('disk changed this', 2000));
    await t.hsm.awaitIdleAutoMerge();
    expectState(t, 'idle.localAhead');

    // Remote makes a conflicting change to the same line
    t.applyRemoteChange('remote changed this');

    // Provider syncs — fork reconciliation runs diff3 with real remote content
    t.send(connected());
    t.send(providerSynced());
    await t.hsm.awaitForkReconcile();
    await t.hsm.awaitIdleAutoMerge();

    // A real conflict should be detected with correct "theirs" content
    const cd = t.hsm.getConflictData();
    expect(cd).toBeDefined();
    expect(cd?.base).toBe('original line');
    expect(cd?.ours).toBe('disk changed this');
    expect(cd?.theirs).toBe('remote changed this');

    expectState(t, 'idle.diverged');
  });

  test('non-conflicting merge succeeds after PROVIDER_SYNCED', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'line1\nline2\nline3', mtime: 1000 });

    // Disk changes line3 only
    t.send(await diskChanged('line1\nline2\nDISK', 2000));
    await t.hsm.awaitIdleAutoMerge();
    expectState(t, 'idle.localAhead');

    // Remote changes line1 only (non-overlapping)
    t.applyRemoteChange('REMOTE\nline2\nline3');

    // Provider syncs — fork reconciliation should auto-merge cleanly
    t.send(connected());
    t.send(providerSynced());
    await t.hsm.awaitForkReconcile();
    await t.hsm.awaitIdleAutoMerge();

    // No conflict expected
    expect(t.hsm.getConflictData()).toBeNull();
    expect(t.matches('idle')).toBe(true);
  });
});

describe('Provider sync guard: invokeForkReconcile', () => {
  test('defers reconciliation when provider has not synced', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'original', mtime: 1000 });

    // Disk edit creates fork → transitions to idle.localAhead
    t.send(await diskChanged('modified', 2000));
    await t.hsm.awaitIdleAutoMerge();

    // In idle.localAhead, fork-reconcile fires but provider isn't synced.
    // The HSM should stay in idle.localAhead (deferred).
    expectState(t, 'idle.localAhead');
    expect(t.state.fork).not.toBeNull();
  });

  test('reconciliation succeeds after PROVIDER_SYNCED when remote is unchanged', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'original', mtime: 1000 });

    // Disk edit creates fork
    t.send(await diskChanged('modified by disk', 2000));
    await t.hsm.awaitIdleAutoMerge();
    expectState(t, 'idle.localAhead');

    // Provider syncs — remote content matches base, so no conflict
    t.send(connected());
    t.send(providerSynced());
    await t.hsm.awaitForkReconcile();
    await t.hsm.awaitIdleAutoMerge();

    // Fork should be cleared, content preserved
    expect(t.state.fork).toBeNull();
    expect(t.hsm.getConflictData()).toBeNull();
    expectLocalDocText(t, 'modified by disk');
  });

  test('multiple disk edits before provider sync are handled correctly', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'v1', mtime: 1000 });

    // First disk edit
    t.send(await diskChanged('v2', 2000));
    await t.hsm.awaitIdleAutoMerge();

    // Second disk edit while still waiting for provider
    t.send(await diskChanged('v3', 3000));
    await t.hsm.awaitIdleAutoMerge();

    // Provider syncs — should reconcile with latest disk content
    t.send(connected());
    t.send(providerSynced());
    await t.hsm.awaitForkReconcile();
    await t.hsm.awaitIdleAutoMerge();

    expect(t.matches('idle')).toBe(true);
    // localDoc should have the latest disk content
    expectLocalDocText(t, 'v3');
  });
});
