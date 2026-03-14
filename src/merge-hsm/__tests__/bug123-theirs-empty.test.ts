/**
 * BUG-123 Reproduction Test
 *
 * Scenario: Remote and disk edits to the same line arrive while the file is
 * idle. The three-way auto-merge detects a conflict and creates a fork.
 * Fork-reconcile then runs and populates conflictData. When the user opens
 * the file, conflictData.theirs must contain the remote edit — not an empty
 * string.
 *
 * Flow:
 *   idle.synced
 *     → REMOTE_UPDATE (edit Line 2) → idle.remoteAhead
 *     → DISK_CHANGED (different edit Line 2) → idle.diverged
 *     → invokeIdleThreeWayAutoMerge → conflict → fork → idle.localAhead
 *     → invokeForkReconcile (needs PROVIDER_SYNCED) → conflictData set
 *     → ACQUIRE_LOCK → active.conflict.bannerShown
 *     → ASSERT: conflictData.theirs === remote edit
 */

import {
  createTestHSM,
  loadToIdle,
  sendAcquireLockToTracking,
  diskChanged,
  providerSynced,
  connected,
  expectState,
} from '../testing';

describe('BUG-123: conflictData.theirs must contain remote edit', () => {
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
    const cdBeforeOpen = t.hsm.getConflictData();

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

    // BUG-123: "theirs" must contain the remote edit, not empty string
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
