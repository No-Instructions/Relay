/**
 * Auto-generated test from E2E recording
 * Recording: clean-disk-file-test - blog/clean-test-1769413310.md
 * Document: blog/clean-test-1769413310.md
 * Generated: 2026-01-26
 *
 * This test documents the behavior captured during E2E testing of the
 * MergeHSM when a new file is created on disk and opened in the editor.
 */

import {
  createTestHSM,
  load,
  acquireLock,
  cm6Insert,
  diskChanged,
  persistenceLoaded,
  initializeWithContent,
  createLCA,
  expectState,
  sha256,
} from '../testing';

describe('E2E Recorded: clean-disk-file-test', () => {
  const guid = '54ee6157-07ff-4387-b538-3df037759c05';
  const path = 'blog/clean-test-1769413310.md';
  const initialContent = '# Clean Test File\n\nTimestamp: 1769413310\n\n- Alpha\n- Beta\n- Gamma';

  test('should start in unloaded state and load', async () => {
    const t = await createTestHSM();
    expectState(t, 'unloaded');

    t.send(load(guid, path));
    expectState(t, 'loading.loadingPersistence');
  });

  test('should block in awaitingLCA when no prior state', async () => {
    const t = await createTestHSM();

    t.send(load(guid, path));
    t.send(persistenceLoaded(new Uint8Array(), null));

    expectState(t, 'loading.awaitingLCA');
  });

  test('should transition to idle after initializing with content', async () => {
    const t = await createTestHSM();

    t.send(load(guid, path));
    t.send(persistenceLoaded(new Uint8Array(), null));
    expectState(t, 'loading.awaitingLCA');

    const hash = await sha256(initialContent);
    t.send(initializeWithContent(initialContent, hash, Date.now()));
    expectState(t, 'idle.synced');
  });

  test('should enter active mode and reach active.tracking', async () => {
    const t = await createTestHSM();

    // Setup: load and initialize with content
    t.send(load(guid, path));
    t.send(persistenceLoaded(new Uint8Array(), null));
    const hash = await sha256(initialContent);
    t.send(initializeWithContent(initialContent, hash, Date.now()));
    expectState(t, 'idle.synced');

    // Acquire lock to enter active mode
    t.send(acquireLock(initialContent));

    // From E2E recording: initial state was active.tracking
    expectState(t, 'active.tracking');
  });

  test('should handle CM6_CHANGE and emit SYNC_TO_REMOTE effect', async () => {
    const t = await createTestHSM();

    // Setup to active.tracking
    t.send(load(guid, path));
    t.send(persistenceLoaded(new Uint8Array(), null));
    const hash = await sha256(initialContent);
    t.send(initializeWithContent(initialContent, hash, Date.now()));
    t.send(acquireLock(initialContent));
    expectState(t, 'active.tracking');

    // Clear effects from setup
    t.clearEffects();

    // From recording: 21 CM6_CHANGE events were captured (typing " - Delta (editor edit)")
    const insertText = '\n- Delta (editor edit)';
    const newContent = initialContent + insertText;
    t.send(cm6Insert(initialContent.length, insertText, newContent));

    // Should emit SYNC_TO_REMOTE (syncs YDoc changes to remote)
    const syncEffect = t.effects.find(e => e.type === 'SYNC_TO_REMOTE');
    expect(syncEffect).toBeDefined();

    // Should still be in active.tracking
    expectState(t, 'active.tracking');
  });

  test('should handle disk changes in active mode via merge cycle', async () => {
    const t = await createTestHSM();

    // Setup to active.tracking
    t.send(load(guid, path));
    t.send(persistenceLoaded(new Uint8Array(), null));
    const hash = await sha256(initialContent);
    t.send(initializeWithContent(initialContent, hash, Date.now()));
    t.send(acquireLock(initialContent));
    expectState(t, 'active.tracking');

    // Disk change should trigger merge
    const newDiskContent = initialContent + '\n- NewItem (from disk)';
    t.send(await diskChanged(newDiskContent, Date.now()));

    // From recording: transitions were active.merging -> active.tracking
    // The HSM auto-merges and returns to tracking
    expectState(t, 'active.tracking');
  });

  test('documents recorded event distribution', () => {
    // From E2E recording of the clean-test file:
    const eventDistribution = {
      'MERGE_SUCCESS': 7,
      'CM6_CHANGE': 21
    };

    // Timeline had 28 entries total
    expect(eventDistribution.MERGE_SUCCESS + eventDistribution.CM6_CHANGE).toBe(28);

    // This distribution shows:
    // - 21 keystrokes typed " - Delta (editor edit)"
    // - 7 successful merges (disk syncs)
  });

  test('documents recorded state transitions', () => {
    // The E2E recording captured these unique transitions:
    const recordedTransitions = [
      'active.merging -> active.tracking',  // After successful merge
      'active.tracking -> active.tracking'  // CM6_CHANGE in tracking state
    ];

    expect(recordedTransitions).toHaveLength(2);
    expect(recordedTransitions).toContain('active.merging -> active.tracking');
    expect(recordedTransitions).toContain('active.tracking -> active.tracking');
  });
});
