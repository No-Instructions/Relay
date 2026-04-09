/**
 * Cross-Vault Integration Tests
 *
 * Simulates two vaults syncing through a shared Y.Doc server.
 * Exercises upload/download, conflict detection, and bidirectional editing
 * without live Obsidian instances.
 *
 * CRDT INVARIANT: All vaults must share the same CRDT history. Content is
 * enrolled into the Y.Doc tree exactly once (by the originating vault), and
 * other vaults receive those updates via sync. Two independently-created
 * Y.Docs with the same text are NOT interchangeable — they have different
 * client IDs and applying updates between them produces concatenation.
 */

import * as Y from 'yjs';
import { createCrossVaultTest } from 'src/merge-hsm/testing/createCrossVaultTest';
import { loadAndActivate, createLCA } from 'src/merge-hsm/testing';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Boot both vaults to active.tracking with shared CRDT history.
 *
 * Vault A enrolls the content (creates the canonical CRDT items).
 * Vault A's updates are propagated to the server and then to vault B,
 * which loads from those same updates rather than creating independent items.
 */
async function bootBothVaults(content: string) {
  const ctx = await createCrossVaultTest();

  // Step 1: Boot vault A with content. This creates the canonical CRDT items.
  await loadAndActivate(ctx.vaultA.hsm, content);
  ctx.vaultA.disk.content = content;
  ctx.vaultA.disk.mtime = Date.now();

  // Step 2: Get vault A's CRDT state and propagate to server + vault B.
  // We need the update from A's localDoc (the canonical source).
  const localDocA = ctx.vaultA.hsm.hsm.getLocalDoc()!;
  const canonicalUpdate = Y.encodeStateAsUpdate(localDocA);

  // Apply to server to establish shared history
  Y.applyUpdate(ctx.server, canonicalUpdate, 'vaultA');

  // Step 3: Boot vault B using A's canonical updates (shared CRDT history).
  // Seed B's IDB and remoteDoc with the same updates.
  if (content) {
    ctx.vaultB.hsm.seedIndexedDB(canonicalUpdate);
    ctx.vaultB.hsm.syncRemoteWithUpdate(canonicalUpdate);
  }

  const mtime = Date.now();
  const stateVector = content ? Y.encodeStateVectorFromUpdate(canonicalUpdate) : new Uint8Array([0]);
  const lca = await createLCA(content, mtime, stateVector);
  const updates = content ? canonicalUpdate : new Uint8Array();

  // Drive B through state transitions manually (using shared updates)
  ctx.vaultB.send({ type: 'LOAD', guid: 'cross-vault-doc' });
  ctx.vaultB.send({ type: 'PERSISTENCE_LOADED', updates, lca });
  ctx.vaultB.send({ type: 'SET_MODE_ACTIVE' });
  ctx.vaultB.send({ type: 'ACQUIRE_LOCK', editorContent: content });

  // Wait for B to reach tracking
  await ctx.vaultB.hsm.hsm.awaitState?.((s: string) => s === 'active.tracking');
  ctx.vaultB.disk.content = content;
  ctx.vaultB.disk.mtime = mtime;

  // Drain any pending updates from setup
  ctx.sync();

  // Clear effects from setup
  ctx.vaultA.clearEffects();
  ctx.vaultB.clearEffects();

  return ctx;
}

// =============================================================================
// Test: Upload and Download
// =============================================================================

describe('Cross-vault: Upload and Download', () => {
  test('content created in vault A reaches vault B via server', async () => {
    const ctx = await bootBothVaults('seed');

    // Vault A edits content
    ctx.vaultA.editText('Hello from A');

    // Sync: A.localDoc -> A.remoteDoc -> server -> B.remoteDoc -> B.localDoc
    ctx.sync();

    // Vault B's local doc should have the content
    expect(ctx.vaultB.getLocalText()).toBe('Hello from A');

    ctx.destroy();
  });

  test('vault B receives DISPATCH_CM6 effect for remote content', async () => {
    const ctx = await bootBothVaults('seed');

    ctx.vaultA.editText('Hello from A');
    ctx.sync();

    // In active.tracking, remote updates produce DISPATCH_CM6 effects
    const dispatchEffects = ctx.vaultB.effects.filter(e => e.type === 'DISPATCH_CM6');
    expect(dispatchEffects.length).toBeGreaterThan(0);

    ctx.destroy();
  });
});

// =============================================================================
// Test: Conflict Detection and Resolution
// =============================================================================

describe('Cross-vault: Conflict Detection', () => {
  test('offline edits on both sides diverge then converge on reconnect', async () => {
    const ctx = await bootBothVaults('Original content');

    // Vault A goes offline
    ctx.vaultA.disconnect();

    // Both vaults edit independently
    ctx.vaultA.editText('Edit from A');
    ctx.vaultB.editText('Edit from B');

    // Sync (only B reaches server since A is disconnected)
    ctx.sync();

    // Verify B's edit reached the server
    expect(ctx.server.getText('contents').toString()).toBe('Edit from B');

    // Vault A reconnects
    ctx.vaultA.reconnect();
    ctx.sync();

    // After reconnect+sync, both vaults should converge.
    // Y.js merges concurrent edits deterministically.
    const localTextA = ctx.vaultA.getLocalText();
    const localTextB = ctx.vaultB.getLocalText();

    expect(localTextA).not.toBeNull();
    expect(localTextB).not.toBeNull();
    // Both should see the same merged result
    expect(localTextA).toBe(localTextB);

    ctx.destroy();
  });
});

// =============================================================================
// Test: Bidirectional Real-Time Editing
// =============================================================================

describe('Cross-vault: Bidirectional Editing', () => {
  test('sequential edits from both vaults converge', async () => {
    const ctx = await bootBothVaults('seed');

    // Vault A edits
    ctx.vaultA.editText('Hello');
    ctx.sync();

    // Vault B should see "Hello"
    expect(ctx.vaultB.getLocalText()).toBe('Hello');

    // Vault B edits
    ctx.vaultB.editText('Hello World');
    ctx.sync();

    // Both should see "Hello World"
    expect(ctx.vaultA.getLocalText()).toBe('Hello World');
    expect(ctx.vaultB.getLocalText()).toBe('Hello World');

    ctx.destroy();
  });

  test('simultaneous edits at different positions merge correctly', async () => {
    const ctx = await bootBothVaults('Hello World');

    // Vault A prepends ">> "
    ctx.vaultA.editText('>> Hello World');

    // Vault B appends " !!"
    ctx.vaultB.editText('Hello World !!');

    // Sync both directions
    ctx.sync();

    // After CRDT merge, both should converge
    const textA = ctx.vaultA.getLocalText();
    const textB = ctx.vaultB.getLocalText();

    expect(textA).toBe(textB);
    // Both edits should be present
    expect(textA).toContain('>>');
    expect(textA).toContain('!!');

    ctx.destroy();
  });
});

// =============================================================================
// Hibernation upload-download
// =============================================================================

describe('Hibernation upload-download', () => {
  test('vault A creates content, hibernates (remoteDoc destroyed), vault B downloads', async () => {
    // Scenario: vault A creates content, its remoteDoc is destroyed (hibernation),
    // then vault B tries to get the content from the server.
    // Failure mode: server has uninitialized Y.Doc because content was never uploaded.
    const ctx = await bootBothVaults('seed');

    // Vault A writes real content
    ctx.vaultA.editText('Important document content');
    ctx.sync();

    // Verify server actually has the content before hibernation
    const serverText = ctx.server.getText('contents').toString();
    expect(serverText).toBe('Important document content');

    // Simulate vault A hibernating: disconnect + destroy remoteDoc reference
    ctx.vaultA.disconnect();

    // Vault B should still be able to read content from the server
    expect(ctx.vaultB.getLocalText()).toBe('Important document content');

    // Now simulate a NEW vault B session that only has the server.
    // Create a fresh Y.Doc and try to get content from server.
    const freshDoc = new Y.Doc();
    const serverUpdate = Y.encodeStateAsUpdate(ctx.server);
    Y.applyUpdate(freshDoc, serverUpdate);
    const downloaded = freshDoc.getText('contents').toString();
    freshDoc.destroy();

    expect(downloaded).toBe('Important document content');

    ctx.destroy();
  });

  test('server Y.Doc is not empty after vault A enrolls and syncs', async () => {
    // Directly test: after enrollment + sync, does server have content?
    const ctx = await createCrossVaultTest();

    // Boot vault A with content
    await loadAndActivate(ctx.vaultA.hsm, 'Enrolled content');
    ctx.vaultA.disk.content = 'Enrolled content';
    ctx.vaultA.disk.mtime = Date.now();

    // Propagate to server
    ctx.sync();

    // Server must have content
    const serverText = ctx.server.getText('contents').toString();
    expect(serverText).toBe('Enrolled content');

    ctx.destroy();
  });

  test('full round-trip: vault A uploads, vault B downloads, disk write occurs', async () => {
    const ctx = await bootBothVaults('initial');

    // Vault A edits
    ctx.vaultA.editText('Round-trip content');
    ctx.sync();

    // Vault B should have content in localDoc
    expect(ctx.vaultB.getLocalText()).toBe('Round-trip content');

    // Check that WRITE_DISK or DISPATCH_CM6 effect was emitted for B
    const writeEffects = ctx.vaultB.effects.filter(
      (e: any) => e.type === 'WRITE_DISK' || e.type === 'DISPATCH_CM6'
    );
    expect(writeEffects.length).toBeGreaterThan(0);

    ctx.destroy();
  });

  test('vault A enrolls content but sync delayed — vault B sees empty until sync completes', async () => {
    // Scenario: ensureRemoteDoc runs but updates haven't propagated yet
    const ctx = await createCrossVaultTest();

    // Boot vault A with content (creates canonical CRDT items)
    await loadAndActivate(ctx.vaultA.hsm, 'Content from A');
    ctx.vaultA.disk.content = 'Content from A';
    ctx.vaultA.disk.mtime = Date.now();

    // Do NOT sync yet — simulate delay

    // Server should be empty at this point
    const serverTextBeforeSync = ctx.server.getText('contents').toString();
    expect(serverTextBeforeSync).toBe('');

    // Now sync
    ctx.sync();

    // Server should have content after sync
    const serverTextAfterSync = ctx.server.getText('contents').toString();
    expect(serverTextAfterSync).toBe('Content from A');

    ctx.destroy();
  });
});

// =============================================================================
// Conflict resolution
// =============================================================================

describe('Cross-vault: Conflict resolution', () => {
  test('select-then-type (delete + insert) — both ops reach server', async () => {
    // The insert was getting lost after a select-then-type
    // (which is a delete followed by an insert at the same position).
    const ctx = await bootBothVaults('The quick brown fox');

    // Vault B does a select-then-type: select "quick" and type "slow"
    // This is delete(4,9) + insert(4, "slow") = "The slow brown fox"
    ctx.vaultB.send({
      type: 'CM6_CHANGE',
      changes: [{ from: 4, to: 9, insert: 'slow' }],
      docText: 'The slow brown fox',
    });

    ctx.sync();

    // Both vaults must see "The slow brown fox"
    expect(ctx.vaultA.getLocalText()).toBe('The slow brown fox');
    expect(ctx.vaultB.getLocalText()).toBe('The slow brown fox');

    // Server must also have the complete content
    const serverText = ctx.server.getText('contents').toString();
    expect(serverText).toBe('The slow brown fox');

    ctx.destroy();
  });

  test('conflict detection: both vaults edit same content offline, reconnect', async () => {
    const ctx = await bootBothVaults('Line one');

    // Both go offline
    ctx.vaultA.disconnect();
    ctx.vaultB.disconnect();

    // Both edit the same text differently
    ctx.vaultA.editText('Line A');
    ctx.vaultB.editText('Line B');

    // A reconnects first, syncs to server
    ctx.vaultA.reconnect();
    ctx.sync();

    // Server should have A's version
    expect(ctx.server.getText('contents').toString()).toBe('Line A');

    // B reconnects — CRDT merges concurrent edits
    ctx.vaultB.reconnect();
    ctx.sync();

    // After merge, both should converge to the same text
    const textA = ctx.vaultA.getLocalText();
    const textB = ctx.vaultB.getLocalText();
    expect(textA).toBe(textB);

    // The merged result should NOT be concatenation of both
    // (that would indicate independent CRDT histories)
    expect(textA!.length).toBeLessThan('Line A'.length + 'Line B'.length);

    ctx.destroy();
  });

  test('accept-disk resolution convergence — no concatenation', async () => {
    // Scenario: A and B both edit. A resolves conflict by accepting disk (local).
    // After sync, B should converge to A's resolution, NOT get concatenation.
    const ctx = await bootBothVaults('Original');

    // B goes offline and edits
    ctx.vaultB.disconnect();
    ctx.vaultB.editText('B version');

    // A edits while B is offline
    ctx.vaultA.editText('A version');
    ctx.sync(); // A -> server

    // B reconnects — CRDT merges both edits
    ctx.vaultB.reconnect();
    ctx.sync();

    // Both should converge (CRDT merge, not concatenation)
    const textA = ctx.vaultA.getLocalText();
    const textB = ctx.vaultB.getLocalText();
    expect(textA).toBe(textB);

    // Now simulate A "accepting disk" by overwriting with a clean resolve
    // A's user decides the correct content is "A version"
    ctx.vaultA.editText('A version');
    ctx.sync();

    // After resolution sync, B must converge to exactly "A version"
    expect(ctx.vaultB.getLocalText()).toBe('A version');
    expect(ctx.vaultA.getLocalText()).toBe('A version');

    ctx.destroy();
  });

  test('resolution durability — late remote ops do not undo resolution', async () => {
    // After A resolves a conflict, a delayed update from B should NOT
    // revert or corrupt the resolution.
    const ctx = await bootBothVaults('Base text');

    // B disconnects and makes edits
    ctx.vaultB.disconnect();
    ctx.vaultB.editText('B late edit');

    // A edits and resolves
    ctx.vaultA.editText('Resolved by A');
    ctx.sync(); // A -> server

    // A's resolution is final
    expect(ctx.server.getText('contents').toString()).toBe('Resolved by A');

    // B reconnects — its "late" edit merges in
    ctx.vaultB.reconnect();
    ctx.sync();

    // Both must converge
    const textA = ctx.vaultA.getLocalText();
    const textB = ctx.vaultB.getLocalText();
    expect(textA).toBe(textB);

    // The result should contain A's resolution text (CRDT merge is deterministic)
    // It may also contain remnants of B's edit due to CRDT merge semantics,
    // but it must NOT be a simple concatenation or revert to B's version
    expect(textA).not.toBe('B late edit');

    // Now A overwrites again to assert resolution sticks
    ctx.vaultA.editText('Final resolution');
    ctx.sync();

    expect(ctx.vaultB.getLocalText()).toBe('Final resolution');
    expect(ctx.vaultA.getLocalText()).toBe('Final resolution');

    ctx.destroy();
  });

  test('simultaneous same-line edit produces CRDT merge, not data loss', async () => {
    // Both vaults edit the exact same range simultaneously.
    // This is the core conflict scenario: neither edit should be lost.
    const ctx = await bootBothVaults('Hello World');

    // Both vaults replace "World" with different text simultaneously
    // A: "Hello World" -> "Hello Alice"
    ctx.vaultA.send({
      type: 'CM6_CHANGE',
      changes: [{ from: 6, to: 11, insert: 'Alice' }],
      docText: 'Hello Alice',
    });

    // B: "Hello World" -> "Hello Bob"
    ctx.vaultB.send({
      type: 'CM6_CHANGE',
      changes: [{ from: 6, to: 11, insert: 'Bob' }],
      docText: 'Hello Bob',
    });

    ctx.sync();

    const textA = ctx.vaultA.getLocalText();
    const textB = ctx.vaultB.getLocalText();

    // Must converge
    expect(textA).toBe(textB);

    // Both edits must be present (CRDT keeps both inserts)
    expect(textA).toContain('Alice');
    expect(textA).toContain('Bob');

    // Must NOT be the original (no data loss)
    expect(textA).not.toBe('Hello World');

    ctx.destroy();
  });
});
