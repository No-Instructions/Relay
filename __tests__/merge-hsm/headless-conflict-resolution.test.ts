import {
  connected,
  createTestHSM,
  expectEffect,
  expectLocalDocText,
  expectNoEffect,
  expectRemoteDocText,
  expectState,
  loadAndActivate,
  providerSynced,
  releaseLock,
  sha256,
} from 'src/merge-hsm/testing';
import { conflictRegionId } from 'src/merge-hsm/conflict';

const BASE = 'line1\nshared line\nline3\n';
const LOCAL_EDIT = 'line1\nlocal edit\nline3\n';
const REMOTE_EDIT = 'line1\nremote edit\nline3\n';

async function toIdleSynced(content: string) {
  const t = await createTestHSM();
  await loadAndActivate(t, content);
  t.send(connected());
  t.send(providerSynced());
  t.send(releaseLock());
  await t.hsm.awaitCleanup();
  expectState(t, 'idle.synced');
  t.clearEffects();
  return t;
}

async function writeDisk(t: Awaited<ReturnType<typeof createTestHSM>>, content: string) {
  t.send({
    type: 'DISK_CHANGED',
    contents: content,
    mtime: Date.now(),
    hash: await sha256(content),
  });
  await t.awaitIdleAutoMerge();
}

async function loadIdleConflict() {
  const t = await toIdleSynced(BASE);

  await writeDisk(t, LOCAL_EDIT);
  expect(t.hsm.hasFork()).toBe(true);

  t.setRemoteContent(REMOTE_EDIT);
  t.send({ type: 'REMOTE_UPDATE', update: t.getRemoteUpdate() });
  t.send(providerSynced());
  await t.hsm.awaitForkReconcile();
  await t.awaitIdleAutoMerge();

  expectState(t, 'idle.conflict');
  expect(t.hsm.getConflictData()).not.toBeNull();
  t.clearEffects();
  return t;
}

describe('headless conflict resolution', () => {
  it('resolves an idle.conflict conflict with final contents without editor effects', async () => {
    const t = await loadIdleConflict();

    await t.hsm.resolveConflictHeadless(REMOTE_EDIT);

    expectState(t, 'idle.synced');
    expectLocalDocText(t, REMOTE_EDIT);
    expectRemoteDocText(t, REMOTE_EDIT);
    expect(t.replayFromIDB()).toBe(REMOTE_EDIT);
    expect(t.hsm.hasFork()).toBe(false);
    expect(t.hsm.getConflictData()).toBeNull();
    expect(t.state.lca?.contents).toBe(REMOTE_EDIT);
    expectNoEffect(t.effects, 'DISPATCH_CM6');
    expectEffect(t.effects, { type: 'WRITE_DISK', contents: REMOTE_EDIT });
    expectEffect(t.effects, { type: 'SYNC_TO_REMOTE' });
    expectEffect(t.effects, { type: 'STATUS_CHANGED' });
    expectEffect(t.effects, { type: 'PERSIST_STATE' });
  });

  it('resolves idle.conflict hunks without opening an editor or diff view', async () => {
    const t = await loadIdleConflict();
    const conflict = t.hsm.getConflictData();
    expect(conflict?.conflictRegions).toHaveLength(1);

    await t.hsm.resolveHunkHeadless(conflictRegionId(conflict!.conflictRegions[0]), 'theirs');

    expectState(t, 'idle.synced');
    expectLocalDocText(t, REMOTE_EDIT);
    expectRemoteDocText(t, REMOTE_EDIT);
    expectNoEffect(t.effects, 'DISPATCH_CM6');
    expectEffect(t.effects, { type: 'WRITE_DISK', contents: REMOTE_EDIT });
  });

  it('resolves idle.conflict hunks by stable hunk id through the HSM helper', async () => {
    const t = await loadIdleConflict();
    const info = t.hsm.getConflictInfoSnapshot();
    expect(info.hunks).toHaveLength(1);

    const statePath = await t.hsm.resolveConflictHunk(info.hunks[0].id, 'theirs');

    expect(statePath).toBe('idle.synced');
    expectLocalDocText(t, REMOTE_EDIT);
    expectRemoteDocText(t, REMOTE_EDIT);
    expectNoEffect(t.effects, 'DISPATCH_CM6');
  });

  it('does not report success for hibernated hunk resolution without CRDT docs', async () => {
    const t = await loadIdleConflict();
    const conflict = t.hsm.getConflictData();
    expect(conflict).not.toBeNull();

    t.hsm.setRemoteDoc(null);
    await t.hsm.destroyLocalDoc();

    await expect(
      t.hsm.resolveHunkHeadless(conflictRegionId(conflict!.conflictRegions[0]), 'theirs'),
    ).rejects.toThrow(
      /requires localDoc and remoteDoc/,
    );

    expectState(t, 'idle.conflict');
    expect(t.hsm.getConflictData()).not.toBeNull();
  });
});
