/**
 * CRDT Content Integrity Tests
 *
 * Tests verifying that CRDT operations preserve content integrity
 * under concurrent edits, duplicate updates, and identical-content scenarios.
 */

import {
  createTestHSM,
  loadToIdle,
  loadAndActivate,
  sendAcquireLockToTracking,
  cm6Insert,
  releaseLock,
  providerSynced,
  connected,
} from 'src/merge-hsm/testing';

describe('CRDT content integrity under stress', () => {
  test('concurrent remote + local edits do not duplicate content', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'ABCDEF');

    t.send(connected());
    t.send(providerSynced());

    // User types at position 3
    t.send(cm6Insert(3, 'XYZ', 'ABCXYZDEF'));

    // Remote edit arrives modifying the end
    t.applyRemoteChange('ABCDEF!!!');

    // Both edits should merge — content should not have duplicates
    const text = t.getLocalDocText();
    expect(text).not.toBeNull();
    // The text should contain both edits without duplication of 'ABCDEF'
    expect(text!.indexOf('ABCDEF')).toBeLessThanOrEqual(0);
  });

  test('applying same update twice does not duplicate content', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });

    // Get a remote update
    t.setRemoteContent('hello world');
    const update = t.getRemoteUpdate();

    // Apply same update twice
    t.send({ type: 'REMOTE_UPDATE', update });
    t.send({ type: 'REMOTE_UPDATE', update });

    await t.hsm.awaitIdleAutoMerge();

    // Should be 'hello world', not 'hello world world'
    expect(t.getRemoteDocText()).toBe('hello world');
  });
});

describe('Identical content, different histories', () => {
  test('remote update producing same text as local does not create false conflict', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'same', mtime: 1000 });

    // Remote changes to same content (via different path)
    // In CRDT, even if text is same, ops may differ
    t.applyRemoteChange('same');
    await t.hsm.awaitIdleAutoMerge();

    expect(t.matches('idle')).toBe(true);
    expect(t.getLocalDocText()).toBe('same');
  });
});

// =============================================================================
// Content edge cases
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

  test('client ID is reused across lock cycles', async () => {
    // Invariant #5: the localDoc client ID must be preserved across lock cycles.
    // If a different client ID is used, the same content enrolled from IDB appears
    // as two independent insertions, causing content duplication.
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello world');

    const firstClientID = t.hsm.getLocalDoc()!.clientID;
    expect(firstClientID).toBeDefined();

    // Close the file (release lock → idle)
    t.send(releaseLock());
    await t.hsm.awaitIdle();

    // Reopen the file (acquire lock → active.tracking)
    await sendAcquireLockToTracking(t, 'hello world');

    const secondClientID = t.hsm.getLocalDoc()!.clientID;
    expect(secondClientID).toBe(firstClientID);
  });
});
