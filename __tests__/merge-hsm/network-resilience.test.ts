/**
 * Network Resilience Tests
 *
 * Stress tests for network partition storms, rapid connect/disconnect cycling,
 * and REMOTE_UPDATE floods simulating heavy collaboration.
 */

import {
  createTestHSM,
  loadToIdle,
  loadAndActivate,
  diskChanged,
  cm6Insert,
  providerSynced,
  connected,
  disconnected,
  expectState,
  expectLocalDocText,
} from 'src/merge-hsm/testing';

// =============================================================================
// Network partition storms
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
// REMOTE_UPDATE flood
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

// =========================================================================
// Online/offline toggling during active editing
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
