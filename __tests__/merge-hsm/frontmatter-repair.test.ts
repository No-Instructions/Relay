/**
 * Frontmatter Y.Map Repair Tests
 *
 * Verifies that the Y.Map("frontmatter") mirror detects and repairs
 * corrupted frontmatter values caused by concurrent character-level
 * CRDT insertions (e.g., two clients writing different `modified` timestamps).
 *
 * Backward compatibility: repair only fires when the remote update
 * contains Y.Map ops (i.e., the remote client also has this feature).
 */

import * as Y from 'yjs';
import {
  createTestHSM,
  loadAndActivate,
} from 'src/merge-hsm/testing';

const FM_DOC = `---
title: Test
modified: 2025-01-01
tags: foo
---

# Hello
`;

/**
 * Build a remote update that includes Y.Map("frontmatter") ops,
 * simulating a remote client that also has the frontmatter mirror feature.
 * The returned update is relative to localDoc's state vector.
 */
function buildRemoteUpdateWithMap(
  localDoc: Y.Doc,
  remoteContent: string,
  frontmatterProps: Record<string, string>,
): Uint8Array {
  const remoteDoc = new Y.Doc();
  // Seed remote with localDoc's current state
  Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc));

  remoteDoc.transact(() => {
    // Apply content change
    const rtext = remoteDoc.getText('contents');
    const current = rtext.toString();
    if (current !== remoteContent) {
      rtext.delete(0, current.length);
      rtext.insert(0, remoteContent);
    }
    // Populate Y.Map (what a new client does)
    const rmap = remoteDoc.getMap('frontmatter');
    for (const [k, v] of Object.entries(frontmatterProps)) {
      rmap.set(k, v);
    }
  });

  const update = Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(localDoc));
  remoteDoc.destroy();
  return update;
}

/**
 * Build a remote update WITHOUT Y.Map ops, simulating an old client.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _buildRemoteUpdateWithoutMap(
  localDoc: Y.Doc,
  remoteContent: string,
): Uint8Array {
  const remoteDoc = new Y.Doc();
  Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc));

  const rtext = remoteDoc.getText('contents');
  const current = rtext.toString();
  if (current !== remoteContent) {
    remoteDoc.transact(() => {
      rtext.delete(0, current.length);
      rtext.insert(0, remoteContent);
    });
  }

  const update = Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(localDoc));
  remoteDoc.destroy();
  return update;
}

describe('frontmatter Y.Map repair', () => {

  test('syncFrontmatterToMap populates Y.Map from Y.Text frontmatter', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, FM_DOC);
    t.send({ type: 'CONNECTED' });
    t.send({ type: 'PROVIDER_SYNCED' });

    // Partial edit: "Test" -> "Tasty" (replace 'est' with 'asty')
    const editedDoc = FM_DOC.replace('Test', 'Tasty');
    const estIdx = FM_DOC.indexOf('est');
    t.send({
      type: 'CM6_CHANGE',
      changes: [{ from: estIdx, to: estIdx + 3, insert: 'asty' }],
      docText: editedDoc,
    });

    const ymap = t.hsm.getLocalDoc()!.getMap('frontmatter');
    expect(ymap.get('title')).toBe('"Tasty"');
    expect(ymap.get('modified')).toBe('"2025-01-01"');
    expect(ymap.get('tags')).toBe('"foo"');
  });

  test('CM6 edit updates Y.Map atomically', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, FM_DOC);
    t.send({ type: 'CONNECTED' });
    t.send({ type: 'PROVIDER_SYNCED' });

    const newDoc = FM_DOC.replace('2025-01-01', '2025-06-15');
    const idx = FM_DOC.indexOf('2025-01-01');
    t.send({
      type: 'CM6_CHANGE',
      changes: [{ from: idx, to: idx + 10, insert: '2025-06-15' }],
      docText: newDoc,
    });

    const ymap = t.hsm.getLocalDoc()!.getMap('frontmatter');
    expect(ymap.get('modified')).toBe('"2025-06-15"');
  });

  test('repairs corrupted Y.Text frontmatter when remote update includes Y.Map', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, FM_DOC);
    t.send({ type: 'CONNECTED' });
    t.send({ type: 'PROVIDER_SYNCED' });

    // Partial edit to populate Y.Map: "foo" -> "food"
    const fooEnd = FM_DOC.indexOf('foo') + 3;
    const editedDoc = FM_DOC.replace('tags: foo', 'tags: food');
    t.send({
      type: 'CM6_CHANGE',
      changes: [{ from: fooEnd, to: fooEnd, insert: 'd' }],
      docText: editedDoc,
    });
    t.clearEffects();

    const localDoc = t.hsm.getLocalDoc()!;
    const ytext = localDoc.getText('contents');
    const ymap = localDoc.getMap('frontmatter');

    // Corrupt Y.Text frontmatter (simulates interleaved concurrent inserts)
    const text = ytext.toString();
    const modStart = text.indexOf('2025-01-01');
    localDoc.transact(() => {
      ytext.delete(modStart, 10);
      ytext.insert(modStart, '20252025');
    }, 'simulated-corruption');

    expect(ytext.toString()).toContain('20252025');
    // Y.Map retains the clean value (LWW, not corrupted by Y.Text mutation)
    expect(ymap.get('modified')).toBe('"2025-01-01"');

    // Remote update WITH Y.Map ops (new client) — triggers repair
    // Values must be JSON-stringified to match how syncFrontmatterToMap stores them
    const update = buildRemoteUpdateWithMap(localDoc, editedDoc, {
      title: '"Test"',
      modified: '"2025-01-01"',
      tags: '"food"',
    });
    t.send({ type: 'REMOTE_UPDATE', update });

    const repairedText = ytext.toString();
    expect(repairedText).toContain('modified: 2025-01-01');
    expect(repairedText).not.toContain('20252025');
  });

  test('skips repair when remote update has no Y.Map ops (old client)', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, FM_DOC);
    t.send({ type: 'CONNECTED' });
    t.send({ type: 'PROVIDER_SYNCED' });

    // Partial edit to populate Y.Map: "foo" -> "food"
    const fooEnd = FM_DOC.indexOf('foo') + 3;
    const editedDoc = FM_DOC.replace('tags: foo', 'tags: food');
    t.send({
      type: 'CM6_CHANGE',
      changes: [{ from: fooEnd, to: fooEnd, insert: 'd' }],
      docText: editedDoc,
    });

    const localDoc = t.hsm.getLocalDoc()!;
    const ytext = localDoc.getText('contents');

    // Corrupt Y.Text frontmatter
    const text = ytext.toString();
    const modStart = text.indexOf('2025-01-01');
    localDoc.transact(() => {
      ytext.delete(modStart, 10);
      ytext.insert(modStart, 'GARBLED');
    }, 'simulated-corruption');

    t.clearEffects();

    // Remote update WITHOUT Y.Map ops (old client) — body-only edit via
    // targeted insert, not delete-all/insert-all (which would overwrite corruption)
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc));
    const rtext = remoteDoc.getText('contents');
    const helloIdx = rtext.toString().indexOf('# Hello');
    remoteDoc.transact(() => {
      rtext.insert(helloIdx + 7, ' World');
    });
    const update = Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(localDoc));
    remoteDoc.destroy();
    t.send({ type: 'REMOTE_UPDATE', update });

    // Corruption in frontmatter persists (no Y.Map → no repair)
    expect(ytext.toString()).toContain('GARBLED');
  });

  test('document without frontmatter does not crash', async () => {
    const noFm = '# Just a heading\n\nSome content\n';
    const t = await createTestHSM();
    await loadAndActivate(t, noFm);
    t.send({ type: 'CONNECTED' });
    t.send({ type: 'PROVIDER_SYNCED' });

    const ymap = t.hsm.getLocalDoc()!.getMap('frontmatter');
    expect(ymap.size).toBe(0);
  });
});
