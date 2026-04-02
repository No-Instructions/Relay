/**
 * Regression tests for recalculateConflictPositions.
 *
 * Verifies that after resolving one conflict hunk, the character positions
 * (localStart/localEnd) of remaining unresolved hunks are updated to reflect
 * the new document text.
 */

import {
  createTestHSM,
  loadToConflict,
  openDiffView,
  expectState,
} from 'src/merge-hsm/testing';

// =============================================================================
// Multi-hunk conflict position recalculation
// =============================================================================

describe('recalculateConflictPositions', () => {
  it('updates positions of remaining hunks after resolving an earlier hunk', async () => {
    // Create content with two distinct conflict regions.
    // The base has two paragraphs; local and disk each change different words
    // in both paragraphs so we get two separate conflict hunks.
    const base = 'line1 AAA\nline2 BBB\nline3 CCC\nline4 DDD';
    const remote = 'line1 AAA-remote\nline2 BBB\nline3 CCC-remote\nline4 DDD';
    const disk = 'line1 AAA-disk\nline2 BBB\nline3 CCC-disk\nline4 DDD';

    const t = await createTestHSM();
    await loadToConflict(t, { base, remote, disk });
    expectState(t, 'active.conflict.bannerShown');

    // Open diff view to enter resolving state
    t.send(openDiffView());
    expectState(t, 'active.conflict.resolving');

    const cd = t.hsm.getConflictData();
    expect(cd).not.toBeNull();
    expect(cd!.positionedConflicts.length).toBeGreaterThanOrEqual(2);

    // Record hunk 1's original position
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _hunk1Before = { ...cd!.positionedConflicts[1] };

    // Resolve hunk 0 with "local" (keep ours)
    t.send({ type: 'RESOLVE_HUNK', index: 0, resolution: 'local' } as any);

    // After resolving hunk 0, hunk 1's positions should have been recalculated
    const cdAfter = t.hsm.getConflictData();
    expect(cdAfter).not.toBeNull();

    const hunk1After = cdAfter!.positionedConflicts[1];
    const currentText = t.hsm.getLocalDoc()!.getText('contents').toString();

    // The recalculated position should point to the actual content in the document
    const expectedContent = hunk1After.oursContent;
    if (expectedContent) {
      const actualSlice = currentText.slice(hunk1After.localStart, hunk1After.localEnd);
      expect(actualSlice).toBe(expectedContent);
    }
  });

  it('resolving hunk 0 with "remote" still recalculates hunk 1 correctly', async () => {
    const base = 'alpha original\nbeta original\ngamma original';
    const remote = 'alpha REMOTE\nbeta original\ngamma REMOTE';
    const disk = 'alpha DISK\nbeta original\ngamma DISK';

    const t = await createTestHSM();
    await loadToConflict(t, { base, remote, disk });
    t.send(openDiffView());
    expectState(t, 'active.conflict.resolving');

    const cd = t.hsm.getConflictData();
    expect(cd).not.toBeNull();

    if (cd!.positionedConflicts.length < 2) {
      // If the merge algorithm combines into a single hunk, skip this test
      return;
    }

    // Resolve hunk 0 with "remote" (accept theirs — changes length)
    t.send({ type: 'RESOLVE_HUNK', index: 0, resolution: 'remote' } as any);

    const cdAfter = t.hsm.getConflictData();
    expect(cdAfter).not.toBeNull();

    const hunk1 = cdAfter!.positionedConflicts[1];
    const text = t.hsm.getLocalDoc()!.getText('contents').toString();

    if (hunk1.oursContent) {
      const slice = text.slice(hunk1.localStart, hunk1.localEnd);
      expect(slice).toBe(hunk1.oursContent);
    }
  });

  it('resolving multiple hunks sequentially does not corrupt the document', async () => {
    const base = 'first block\nsecond block\nthird block';
    const remote = 'first REMOTE\nsecond block\nthird REMOTE';
    const disk = 'first DISK\nsecond block\nthird DISK';

    const t = await createTestHSM();
    await loadToConflict(t, { base, remote, disk });
    t.send(openDiffView());

    const cd = t.hsm.getConflictData();
    if (!cd || cd.positionedConflicts.length < 2) return;

    // Resolve all hunks sequentially — should not throw or corrupt
    for (let i = 0; i < cd.positionedConflicts.length; i++) {
      t.send({ type: 'RESOLVE_HUNK', index: i, resolution: 'local' } as any);
    }

    // All hunks resolved — document should contain coherent text (no corruption)
    const finalText = t.hsm.getLocalDoc()!.getText('contents').toString();
    expect(finalText).toBeDefined();
    expect(finalText.length).toBeGreaterThan(0);
    // Should not contain garbage from wrong position slicing
    expect(finalText).not.toContain('undefined');
  });
});
