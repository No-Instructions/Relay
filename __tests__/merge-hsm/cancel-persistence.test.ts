/**
 * Cancel + Persistence Tests
 *
 * Verifies that OpCapture.cancel() correctly removes cancelled update rows
 * from IndexedDB, preventing garbled text when the document is reopened.
 *
 * The bug: cancel() flips internal Y.js deleted flags in memory, but the
 * original ops remain in IDB. When IDB replays into a fresh Y.Doc, the
 * cancelled ops resurface as live inserts, producing duplicate content.
 */

import * as Y from 'yjs';
import {
  createTestHSM,
  createCrossVaultTest,
  loadAndActivate,
  createLCA,
  sha256,
} from 'src/merge-hsm/testing';
import { openDiffView, resolve } from 'src/merge-hsm/testing/events';
import type { CrossVaultTest } from 'src/merge-hsm/testing/createCrossVaultTest';

const BASE = '# Conflict Test\n\nLine 1: Original content\nLine 2: This line will be edited\nLine 3: More original content\n';
const LOCAL_EDIT = '# Conflict Test\n\nLine 1: Original content\nLine 2: LOCAL DISK EDIT from live1\nLine 3: More original content\n';
const REMOTE_EDIT = '# Conflict Test\n\nLine 1: Original content\nLine 2: REMOTE EDIT from live2\nLine 3: More original content\n';

// Helper: drive a TestHSM to idle.synced with content, then release lock
async function toIdleSynced(content: string) {
  const t = await createTestHSM();
  await loadAndActivate(t, content);
  t.send({ type: 'CONNECTED' });
  t.send({ type: 'PROVIDER_SYNCED' });
  t.send({ type: 'RELEASE_LOCK' });
  await t.hsm.awaitCleanup();
  expect(t.statePath).toBe('idle.synced');
  t.clearEffects();
  return t;
}

// Helper: write a disk file and wait for idle-merge
async function writeDisk(t: ReturnType<typeof createTestHSM extends (...args: any[]) => Promise<infer R> ? R : never>, content: string) {
  const hash = await sha256(content);
  t.send({ type: 'DISK_CHANGED', contents: content, mtime: Date.now(), hash });
  await t.awaitIdleAutoMerge();
}

describe('cancel() removes update keys from IDB', () => {

  test('cancel removes disk-edit update rows from IDB', async () => {
    const t = await toIdleSynced(BASE);
    const countBefore = t.getStoredUpdateCount();

    // Disk edit creates fork, ops written to IDB
    await writeDisk(t, LOCAL_EDIT);
    expect(t.getStoredUpdateCount()).toBeGreaterThan(countBefore);
    expect(t.hsm.hasFork()).toBe(true);

    // Inject conflicting remote edit
    t.setRemoteContent(REMOTE_EDIT);
    t.send({ type: 'REMOTE_UPDATE', update: t.getRemoteUpdate() });

    // Reconnect to trigger divergence detection
    t.send({ type: 'PROVIDER_SYNCED' });

    // Wait for fork reconcile
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10));
      if (t.statePath === 'idle.diverged') break;
    }
    expect(t.statePath).toBe('idle.diverged');

    // Enter active mode → conflict
    t.send({ type: 'ACQUIRE_LOCK', editorContent: LOCAL_EDIT });
    await t.hsm.awaitState?.((s: string) =>
      !s.includes('entering') && !s.includes('awaitingPersistence'),
    );
    expect(t.statePath).toBe('active.conflict.bannerShown');

    // Resolve with disk content
    t.send(openDiffView());
    t.send(resolve(LOCAL_EDIT));
    expect(t.statePath).toBe('active.tracking');

    // THE KEY ASSERTION: IDB replay produces clean resolved text
    expect(t.replayFromIDB()).toBe(LOCAL_EDIT);
  });

  test('cancel removes multiple disk-edit update rows', async () => {
    const t = await toIdleSynced(BASE);

    // Two disk edits, each creating ops in the fork
    const EDIT_1 = BASE.replace('This line will be edited', 'FIRST DISK EDIT');
    await writeDisk(t, EDIT_1);
    expect(t.hsm.hasFork()).toBe(true);

    const EDIT_2 = EDIT_1.replace('FIRST DISK EDIT', 'SECOND DISK EDIT');
    await writeDisk(t, EDIT_2);

    // Inject conflicting remote
    t.setRemoteContent(REMOTE_EDIT);
    t.send({ type: 'REMOTE_UPDATE', update: t.getRemoteUpdate() });
    t.send({ type: 'PROVIDER_SYNCED' });

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10));
      if (t.statePath === 'idle.diverged') break;
    }

    t.send({ type: 'ACQUIRE_LOCK', editorContent: EDIT_2 });
    await t.hsm.awaitState?.((s: string) =>
      !s.includes('entering') && !s.includes('awaitingPersistence'),
    );

    t.send(openDiffView());
    t.send(resolve(EDIT_2));

    // Both disk edit row sets should be cleaned up
    expect(t.replayFromIDB()).toBe(EDIT_2);
  });

  test('cancel removes only disk-origin ops, preserves user edits', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, BASE);

    // User types via CM6_CHANGE
    const USER_EDIT = BASE.replace('Original content', 'USER TYPED THIS');
    t.send({
      type: 'CM6_CHANGE',
      changes: [{ from: 0, to: BASE.length, insert: USER_EDIT }],
      docText: USER_EDIT,
    });

    t.send({ type: 'CONNECTED' });
    t.send({ type: 'PROVIDER_SYNCED' });
    t.send({ type: 'RELEASE_LOCK' });
    await t.hsm.awaitCleanup();

    // Disk edit on top of user edit
    const DISK_OVER_USER = USER_EDIT.replace('This line will be edited', 'DISK EDIT');
    await writeDisk(t, DISK_OVER_USER);

    // Remote conflict
    const REMOTE = USER_EDIT.replace('This line will be edited', 'REMOTE EDIT');
    t.setRemoteContent(REMOTE);
    t.send({ type: 'REMOTE_UPDATE', update: t.getRemoteUpdate() });
    t.send({ type: 'PROVIDER_SYNCED' });

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10));
      if (t.statePath === 'idle.diverged') break;
    }

    t.send({ type: 'ACQUIRE_LOCK', editorContent: DISK_OVER_USER });
    await t.hsm.awaitState?.((s: string) =>
      !s.includes('entering') && !s.includes('awaitingPersistence'),
    );

    t.send(openDiffView());
    t.send(resolve(DISK_OVER_USER));

    // IDB should have user edits but not garbled disk ops
    const idbText = t.replayFromIDB();
    expect(idbText).toContain('USER TYPED THIS');
    expect(idbText).toBe(DISK_OVER_USER);
  });
});

describe('compaction suppression during fork', () => {

  test('compaction after cancel captures correct state', async () => {
    const t = await toIdleSynced(BASE);

    await writeDisk(t, LOCAL_EDIT);
    expect(t.hsm.hasFork()).toBe(true);

    // Remote conflict
    t.setRemoteContent(REMOTE_EDIT);
    t.send({ type: 'REMOTE_UPDATE', update: t.getRemoteUpdate() });
    t.send({ type: 'PROVIDER_SYNCED' });

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10));
      if (t.statePath === 'idle.diverged') break;
    }

    t.send({ type: 'ACQUIRE_LOCK', editorContent: LOCAL_EDIT });
    await t.hsm.awaitState?.((s: string) =>
      !s.includes('entering') && !s.includes('awaitingPersistence'),
    );

    t.send(openDiffView());
    t.send(resolve(LOCAL_EDIT));

    // Release lock triggers destroy() which compacts
    t.send({ type: 'RELEASE_LOCK' });
    await t.hsm.awaitCleanup();

    // After compaction, IDB should still be correct
    expect(t.replayFromIDB()).toBe(LOCAL_EDIT);
  });
});

// Shared cross-vault boot helper
async function bootCrossVault(): Promise<CrossVaultTest> {
    const ctx = await createCrossVaultTest();

    await loadAndActivate(ctx.vaultA.hsm, BASE);
    ctx.vaultA.disk.content = BASE;
    ctx.vaultA.disk.mtime = Date.now();

    const localDocA = ctx.vaultA.hsm.hsm.getLocalDoc()!;
    const canonicalUpdate = Y.encodeStateAsUpdate(localDocA);
    Y.applyUpdate(ctx.server, canonicalUpdate, 'vaultA');

    ctx.vaultA.send({ type: 'CONNECTED' });
    ctx.vaultA.send({ type: 'PROVIDER_SYNCED' });

    ctx.vaultB.hsm.seedIndexedDB(canonicalUpdate);
    ctx.vaultB.hsm.syncRemoteWithUpdate(canonicalUpdate);

    const mtime = Date.now();
    const stateVector = Y.encodeStateVectorFromUpdate(canonicalUpdate);
    const lca = await createLCA(BASE, mtime, stateVector);

    ctx.vaultB.send({ type: 'LOAD', guid: 'cross-vault-doc' });
    ctx.vaultB.send({ type: 'PERSISTENCE_LOADED', updates: canonicalUpdate, lca });
    ctx.vaultB.send({ type: 'SET_MODE_ACTIVE' });
    ctx.vaultB.send({ type: 'ACQUIRE_LOCK', editorContent: BASE });
    await ctx.vaultB.hsm.hsm.awaitState?.((s: string) => s === 'active.tracking');
    ctx.vaultB.disk.content = BASE;
    ctx.vaultB.disk.mtime = mtime;

    ctx.vaultB.send({ type: 'CONNECTED' });
    ctx.vaultB.send({ type: 'PROVIDER_SYNCED' });
    ctx.sync();
    ctx.vaultA.clearEffects();
    ctx.vaultB.clearEffects();

    return ctx;
  }

async function driveToConflict(ctx: CrossVaultTest): Promise<void> {
    // A releases lock, disconnects
    ctx.vaultA.send({ type: 'RELEASE_LOCK' });
    await ctx.vaultA.hsm.hsm.awaitCleanup();
    ctx.vaultA.disconnect();

    // B types remote edit
    ctx.vaultB.editText(REMOTE_EDIT);
    ctx.sync();

    ctx.vaultB.send({ type: 'RELEASE_LOCK' });
    await ctx.vaultB.hsm.hsm.awaitCleanup();

    // A writes disk edit → fork
    await ctx.vaultA.writeFile(LOCAL_EDIT);
    await ctx.vaultA.hsm.awaitIdleAutoMerge();

    // Reconnect → diverged
    ctx.vaultA.reconnect();
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10));
      if (ctx.vaultA.hsm.statePath !== 'idle.localAhead') break;
    }
    expect(ctx.vaultA.hsm.statePath).toBe('idle.diverged');

    // Enter active → conflict
    ctx.vaultA.send({ type: 'ACQUIRE_LOCK', editorContent: LOCAL_EDIT });
    await ctx.vaultA.hsm.hsm.awaitState?.((s: string) =>
      !s.includes('entering') && !s.includes('awaitingPersistence'),
    );
    expect(ctx.vaultA.hsm.statePath).toBe('active.conflict.bannerShown');
}

describe('IDB replay fidelity after cancel (cross-vault)', () => {

  test('IDB replay matches in-memory after cancel + accept disk', async () => {
    const ctx = await bootCrossVault();
    await driveToConflict(ctx);

    ctx.vaultA.send(openDiffView());
    ctx.vaultA.send(resolve(LOCAL_EDIT));

    const localDocText = ctx.vaultA.getLocalText();
    const idbText = ctx.vaultA.hsm.replayFromIDB();

    expect(localDocText).toBe(LOCAL_EDIT);
    expect(idbText).toBe(localDocText);

    ctx.destroy();
  });

  test('IDB replay matches in-memory after cancel + accept remote', async () => {
    const ctx = await bootCrossVault();
    await driveToConflict(ctx);

    ctx.vaultA.send(openDiffView());
    ctx.vaultA.send(resolve(REMOTE_EDIT));

    const localDocText = ctx.vaultA.getLocalText();
    const idbText = ctx.vaultA.hsm.replayFromIDB();

    expect(localDocText).toBe(REMOTE_EDIT);
    expect(idbText).toBe(localDocText);

    ctx.destroy();
  });

  test('IDB replay survives lock cycle', async () => {
    const ctx = await bootCrossVault();
    await driveToConflict(ctx);

    ctx.vaultA.send(openDiffView());
    ctx.vaultA.send(resolve(LOCAL_EDIT));
    expect(ctx.vaultA.getLocalText()).toBe(LOCAL_EDIT);

    // Release lock → destroy persistence (compacts to IDB)
    ctx.vaultA.send({ type: 'RELEASE_LOCK' });
    await ctx.vaultA.hsm.hsm.awaitCleanup();

    // Re-acquire → new persistence loads from IDB
    ctx.vaultA.send({ type: 'ACQUIRE_LOCK', editorContent: LOCAL_EDIT });
    await ctx.vaultA.hsm.hsm.awaitState?.((s: string) =>
      !s.includes('entering') && !s.includes('awaitingPersistence'),
    );

    // Cancelled ops must not resurface
    expect(ctx.vaultA.getLocalText()).toBe(LOCAL_EDIT);

    ctx.destroy();
  });
});

describe('IDB replay without compaction (raw row replay)', () => {

  test('IDB rows reflect cancel: un-tombstoned deletions persist', async () => {
    // This test specifically checks that the un-tombstone from cancel()
    // is reflected in IDB. The disk edit deletes "This line will be edited"
    // and inserts "LOCAL DISK EDIT from live1". Cancel should:
    // 1. Delete the insertion (proper CRDT op → persists) ✓
    // 2. Un-tombstone the deletion (raw flag flip → does NOT persist) ✗
    //
    // After cancel + remote merge + DMP resolution, we check IDB replay
    // WITHOUT compaction to see if the un-tombstone is reflected.
    const t = await toIdleSynced(BASE);

    // Check IDB text matches BASE before disk edit
    expect(t.replayFromIDB()).toBe(BASE);

    // Disk edit creates fork
    await writeDisk(t, LOCAL_EDIT);
    expect(t.hsm.hasFork()).toBe(true);

    // IDB now has disk edit applied
    expect(t.replayFromIDB()).toBe(LOCAL_EDIT);

    // Remote conflict
    t.setRemoteContent(REMOTE_EDIT);
    t.send({ type: 'REMOTE_UPDATE', update: t.getRemoteUpdate() });
    t.send({ type: 'PROVIDER_SYNCED' });

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10));
      if (t.statePath === 'idle.diverged') break;
    }

    t.send({ type: 'ACQUIRE_LOCK', editorContent: LOCAL_EDIT });
    await t.hsm.awaitState?.((s: string) =>
      !s.includes('entering') && !s.includes('awaitingPersistence'),
    );

    // Resolve with BASE (accept neither side — go back to original)
    // This maximally exercises un-tombstone: the resolution text matches
    // what was there before the disk edit deleted it.
    t.send(openDiffView());
    t.send(resolve(BASE));

    // In-memory should be correct
    expect(t.getLocalDocText()).toBe(BASE);

    // IDB replay (raw rows, no compaction) must also be correct.
    // If un-tombstone doesn't persist, the deleted "This line will be edited"
    // will still be missing from IDB replay.
    expect(t.replayFromIDB()).toBe(BASE);
  });
});


describe('cross-vault IDB: receiver side garbling', () => {

  test('resolveConflict full-state update does not garble receiver IDB', async () => {
    // End-to-end: A resolves conflict, sends full state to server,
    // B opens file from IDB + provider. B must not have garbled text.
    //
    // The key: B's IDB has B's editing ops. A's resolution creates
    // NEW ops (under A's clientID) via DMP. When B receives A's update
    // and merges with its IDB, the concurrent inserts at the same
    // position may interleave — unless CRDT histories are shared.
    const ctx = await bootCrossVault();

    ctx.vaultA.send({ type: 'RELEASE_LOCK' });
    await ctx.vaultA.hsm.hsm.awaitCleanup();
    ctx.vaultA.disconnect();

    // B edits → ops stored in B's IDB
    ctx.vaultB.editText(REMOTE_EDIT);
    ctx.sync();
    ctx.vaultB.send({ type: 'RELEASE_LOCK' });
    await ctx.vaultB.hsm.hsm.awaitCleanup();

    // A writes disk, resolves conflict
    await ctx.vaultA.writeFile(LOCAL_EDIT);
    await ctx.vaultA.hsm.awaitIdleAutoMerge();
    ctx.vaultA.reconnect();

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10));
      if (ctx.vaultA.hsm.statePath !== 'idle.localAhead') break;
    }

    ctx.vaultA.send({ type: 'ACQUIRE_LOCK', editorContent: LOCAL_EDIT });
    await ctx.vaultA.hsm.hsm.awaitState?.((s: string) =>
      !s.includes('entering') && !s.includes('awaitingPersistence'),
    );

    ctx.vaultA.send(openDiffView());
    ctx.vaultA.send(resolve(LOCAL_EDIT));
    ctx.sync();

    // B reopens: IDB has B's old REMOTE_EDIT ops, provider has A's resolved state.
    // Simulate by applying B's raw binary IDB updates (preserving CRDT history),
    // then merging the server state on top.
    const serverUpdate = Y.encodeStateAsUpdate(ctx.server);
    const bStoredUpdates = ctx.vaultB.hsm.getStoredUpdates();

    const mergeDoc = new Y.Doc();
    if (bStoredUpdates) {
      Y.applyUpdate(mergeDoc, bStoredUpdates);
    }
    Y.applyUpdate(mergeDoc, serverUpdate);

    const mergedText = mergeDoc.getText('contents').toString();

    // Must not contain garbled concatenation
    expect(mergedText).not.toContain('REMOTE EDIT from live2Line 2: LOCAL DISK EDIT');
    expect(mergedText).toBe(LOCAL_EDIT);

    mergeDoc.destroy();
    ctx.destroy();
  });
});

describe('edge cases', () => {

  test('successful auto-merge (no cancel) — no IDB leak', async () => {
    const t = await toIdleSynced(BASE);

    // Disk edit on line 1 (non-conflicting)
    const DISK_LINE1 = BASE.replace('Original content', 'DISK CHANGED LINE 1');
    await writeDisk(t, DISK_LINE1);
    expect(t.hsm.hasFork()).toBe(true);

    // Remote edit on line 3 (non-conflicting)
    const REMOTE_LINE3 = BASE.replace('More original content', 'REMOTE CHANGED LINE 3');
    t.setRemoteContent(REMOTE_LINE3);
    t.send({ type: 'REMOTE_UPDATE', update: t.getRemoteUpdate() });
    t.send({ type: 'PROVIDER_SYNCED' });

    // Auto-merge should succeed (non-overlapping)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10));
      if (t.statePath === 'idle.synced') break;
    }

    // Fork should be cleared after successful merge
    expect(t.hsm.hasFork()).toBe(false);

    // IDB should have both edits merged
    const idbText = t.replayFromIDB();
    expect(idbText).toContain('DISK CHANGED LINE 1');
    expect(idbText).toContain('REMOTE CHANGED LINE 3');
  });
});
