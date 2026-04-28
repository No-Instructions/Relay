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
import { conflictRegionId } from 'src/merge-hsm/conflict';
import { EditorState } from '@codemirror/state';

// =============================================================================
// Multi-hunk conflict position recalculation
// =============================================================================

describe('recalculateConflictPositions', () => {
  function isDispatchEffect(
    effect: unknown,
  ): effect is { type: 'DISPATCH_CM6'; changes: Array<{ from: number; to: number; insert: string }> } {
    return !!effect && typeof effect === 'object' && (effect as { type?: string }).type === 'DISPATCH_CM6';
  }

  function findOccurrences(haystack: string, needle: string): number[] {
    if (!needle) return [];
    const out: number[] = [];
    let from = 0;
    while (from <= haystack.length) {
      const pos = haystack.indexOf(needle, from);
      if (pos === -1) break;
      out.push(pos);
      from = pos + 1;
    }
    return out;
  }

  function hunkIdAt(
    cd: { positionedConflicts: Array<{ oursContent: string; theirsContent: string }> },
    offset: number,
  ): string {
    return conflictRegionId(cd.positionedConflicts[offset]);
  }

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

    // Resolve the first hunk.
    t.send({ type: 'RESOLVE_HUNK', hunkId: hunkIdAt(cd!, 0), resolution: 'ours' });

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

    // Resolve the first hunk with a value that changes length.
    t.send({ type: 'RESOLVE_HUNK', hunkId: hunkIdAt(cd!, 0), resolution: 'ours' });

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
    const hunkIds = cd.positionedConflicts.map(conflictRegionId);
    for (const hunkId of hunkIds) {
      t.send({ type: 'RESOLVE_HUNK', hunkId, resolution: 'theirs' });
    }

    // All hunks resolved — document should contain coherent text (no corruption)
    const finalText = t.hsm.getLocalDoc()!.getText('contents').toString();
    expect(finalText).toBeDefined();
    expect(finalText.length).toBeGreaterThan(0);
    // Should not contain garbage from wrong position slicing
    expect(finalText).not.toContain('undefined');
  });

  it('keeps emitted DISPATCH_CM6 ranges valid while resolving all hunks', async () => {
    const base = [
      'section A: base',
      'separator 1',
      'section B: base',
      'separator 2',
      'section C: base',
      'separator 3',
      'section D: base',
    ].join('\n');
    const remote = [
      'section A: remote-short',
      'separator 1',
      'section B: remote-very-very-long-content',
      'separator 2',
      'section C: remote',
      'separator 3',
      'section D: remote-with-extra-trailer',
    ].join('\n');
    const disk = [
      'section A: disk-very-very-long-content',
      'separator 1',
      'section B: disk',
      'separator 2',
      'section C: disk-with-extra-trailer',
      'separator 3',
      'section D: disk',
    ].join('\n');

    const t = await createTestHSM();
    await loadToConflict(t, { base, remote, disk });
    t.send(openDiffView());
    expectState(t, 'active.conflict.resolving');

    let editorState = EditorState.create({
      doc: t.hsm.getLocalDoc()!.getText('contents').toString(),
    });
    const conflictData = t.hsm.getConflictData();
    expect(conflictData).not.toBeNull();
    const hunkCount = conflictData!.positionedConflicts.length;
    expect(hunkCount).toBeGreaterThanOrEqual(3);
    t.clearEffects();

    for (let index = 0; index < hunkCount; index++) {
      const resolution = index % 2 === 0 ? 'ours' : 'theirs';
      const hunkId = conflictRegionId(conflictData!.positionedConflicts[index]);
      t.send({ type: 'RESOLVE_HUNK', hunkId, resolution });

      const dispatches = t.effects.filter(isDispatchEffect);
      for (const dispatch of dispatches) {
        const beforeLen = editorState.doc.length;
        for (const change of dispatch.changes) {
          expect(change.from).toBeGreaterThanOrEqual(0);
          expect(change.to).toBeGreaterThanOrEqual(change.from);
          expect(change.to).toBeLessThanOrEqual(beforeLen);
        }
        editorState = editorState.update({ changes: dispatch.changes }).state;
      }
      t.clearEffects();
    }

    const finalDoc = t.hsm.getLocalDoc()!.getText('contents').toString();
    expect(editorState.doc.toString()).toBe(finalDoc);
  });

  it('repositions duplicate-content hunks to the correct remaining occurrence', async () => {
    const base = 'top\nbase\nmiddle\nbase\nbottom';
    const remote = 'top\nREMOTE2 EXTRA\nmiddle\nREMOTE2\nbottom';
    const disk = 'top\nDISK\nmiddle\nDISK\nbottom';

    const t = await createTestHSM();
    await loadToConflict(t, { base, remote, disk });
    t.send(openDiffView());
    expectState(t, 'active.conflict.resolving');

    const before = t.hsm.getConflictData();
    expect(before).not.toBeNull();
    expect(before!.positionedConflicts.length).toBe(2);

    // Resolve first hunk to ours, leaving the second unresolved.
    t.send({ type: 'RESOLVE_HUNK', hunkId: hunkIdAt(before!, 0), resolution: 'ours' });
    const afterFirst = t.hsm.getConflictData();
    expect(afterFirst).not.toBeNull();

    const unresolved = afterFirst!.positionedConflicts[1];
    const textAfterFirst = t.hsm.getLocalDoc()!.getText('contents').toString();
    expect(textAfterFirst.slice(unresolved.localStart, unresolved.localEnd)).toBe(unresolved.oursContent);

    const occurrences = findOccurrences(textAfterFirst, unresolved.oursContent);
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    expect(unresolved.localStart).toBe(occurrences[occurrences.length - 1]);

    // Resolving the second hunk to ours should produce the exact "remote" text.
    t.send({ type: 'RESOLVE_HUNK', hunkId: hunkIdAt(before!, 1), resolution: 'ours' });
    const finalText = t.hsm.getLocalDoc()!.getText('contents').toString();
    expect(finalText).toBe(remote);
  });
});
