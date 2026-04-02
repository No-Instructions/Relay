/**
 * Provider Integration Lifecycle Tests
 *
 * Tests the interaction between MergeHSM, ProviderIntegration, and MockYjsProvider.
 * Uses createCrossVaultTest with useProviderIntegration: true to wire real
 * ProviderIntegration instances per vault.
 */

import * as Y from 'yjs';
import { createCrossVaultTest } from 'src/merge-hsm/testing/createCrossVaultTest';
import { loadAndActivate, createLCA } from 'src/merge-hsm/testing';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Boot both vaults with provider integration to active.tracking.
 * After boot, connects providers so sync() uses the provider path.
 */
async function bootWithProvider(content: string) {
  const ctx = await createCrossVaultTest({ useProviderIntegration: true });

  // Boot vault A (loadAndActivate does NOT send CONNECTED/PROVIDER_SYNCED)
  await loadAndActivate(ctx.vaultA.hsm, content);
  ctx.vaultA.disk.content = content;
  ctx.vaultA.disk.mtime = Date.now();

  // Propagate A's CRDT state to server
  const localDocA = ctx.vaultA.hsm.hsm.getLocalDoc()!;
  const canonicalUpdate = Y.encodeStateAsUpdate(localDocA);
  Y.applyUpdate(ctx.server, canonicalUpdate, 'vaultA');

  // Connect provider A (pulls server state, emits sync → PROVIDER_SYNCED + CONNECTED)
  ctx.vaultA.provider!.connect();

  // Boot vault B with shared CRDT history
  if (content) {
    ctx.vaultB.hsm.seedIndexedDB(canonicalUpdate);
    ctx.vaultB.hsm.syncRemoteWithUpdate(canonicalUpdate);
  }

  const mtime = Date.now();
  const stateVector = content ? Y.encodeStateVectorFromUpdate(canonicalUpdate) : new Uint8Array([0]);
  const lca = await createLCA(content, mtime, stateVector);
  const updates = content ? canonicalUpdate : new Uint8Array();

  ctx.vaultB.send({ type: 'LOAD', guid: 'cross-vault-doc' });
  ctx.vaultB.send({ type: 'PERSISTENCE_LOADED', updates, lca });
  ctx.vaultB.send({ type: 'SET_MODE_ACTIVE' });
  ctx.vaultB.send({ type: 'ACQUIRE_LOCK', editorContent: content });

  await ctx.vaultB.hsm.hsm.awaitState?.((s: string) => s === 'active.tracking');
  ctx.vaultB.disk.content = content;
  ctx.vaultB.disk.mtime = mtime;

  // Connect provider B
  ctx.vaultB.provider!.connect();

  // Drain any pending updates from setup
  ctx.sync();

  // Clear effects from setup
  ctx.vaultA.clearEffects();
  ctx.vaultB.clearEffects();

  return ctx;
}

// =============================================================================
// Tests
// =============================================================================

describe('Provider Integration Lifecycle', () => {

  test('stale providerSynced resets after fork (remoteDoc cleared)', async () => {
    const ctx = await bootWithProvider('Hello world');

    // Both vaults are synced and tracking
    expect(ctx.vaultA.hsm.matches('active.tracking')).toBe(true);
    expect(ctx.vaultA.provider!.synced).toBe(true);

    // Vault A edits
    ctx.vaultA.editText('Hello world edited');
    ctx.sync();

    // Verify sync propagated
    expect(ctx.vaultA.getLocalText()).toBe('Hello world edited');
    expect(ctx.vaultB.getLocalText()).toBe('Hello world edited');

    // Release lock on vault A (goes to idle)
    ctx.vaultA.send({ type: 'RELEASE_LOCK' });
    await ctx.vaultA.hsm.hsm.awaitCleanup();
    expect(ctx.vaultA.hsm.hsm.isIdle()).toBe(true);

    // Disconnect vault A — provider disconnects, synced resets
    ctx.vaultA.disconnect();
    expect(ctx.vaultA.provider!.synced).toBe(false);

    // Disk edit while disconnected
    await ctx.vaultA.writeFile('Hello world disk edit');

    // Reconnect — provider connect triggers sync event → PROVIDER_SYNCED
    ctx.vaultA.reconnect();
    // Provider sync is deferred to a microtask — await it
    await Promise.resolve();
    expect(ctx.vaultA.provider!.synced).toBe(true);

    ctx.destroy();
  });

  test('remote content available after reconnect', async () => {
    const ctx = await bootWithProvider('Base content');

    expect(ctx.vaultA.getLocalText()).toBe('Base content');
    expect(ctx.vaultB.getLocalText()).toBe('Base content');

    // Disconnect vault A
    ctx.vaultA.disconnect();

    // Vault B edits and syncs to server
    ctx.vaultB.editText('Base content + B edit');
    ctx.sync();

    // Server should have B's edit
    const serverText = ctx.server.getText('contents').toString();
    expect(serverText).toBe('Base content + B edit');

    // Reconnect vault A — provider pulls server state
    ctx.vaultA.reconnect();
    // Provider sync is deferred to a microtask — await it
    await Promise.resolve();

    // A's remoteDoc should have B's edit after provider sync
    expect(ctx.vaultA.getRemoteText()).toBe('Base content + B edit');

    // If A is in active.tracking, remote update propagates to localDoc
    if (ctx.vaultA.hsm.hsm.isActive()) {
      expect(ctx.vaultA.getLocalText()).toBe('Base content + B edit');
    }

    ctx.destroy();
  });

  test('TP-015 scenario: CRDT vs diff3 conflict contamination', async () => {
    const ctx = await bootWithProvider('Line 1\nLine 2\nLine 3');

    expect(ctx.vaultA.getLocalText()).toBe('Line 1\nLine 2\nLine 3');
    expect(ctx.vaultB.getLocalText()).toBe('Line 1\nLine 2\nLine 3');

    // Release lock on vault A (idle) so disk edits create forks
    ctx.vaultA.send({ type: 'RELEASE_LOCK' });
    await ctx.vaultA.hsm.hsm.awaitCleanup();
    expect(ctx.vaultA.hsm.hsm.isIdle()).toBe(true);

    // Disconnect vault A
    ctx.vaultA.disconnect();

    // Disk edit on A (Line 2 changed) while disconnected
    await ctx.vaultA.writeFile('Line 1\nLine 2 LOCAL\nLine 3');

    // Remote edit on B (same Line 2) syncs to server
    ctx.vaultB.editText('Line 1\nLine 2 REMOTE\nLine 3');
    ctx.sync();

    expect(ctx.server.getText('contents').toString()).toBe('Line 1\nLine 2 REMOTE\nLine 3');

    // Reconnect A — provider pulls server state into A's remoteDoc
    ctx.vaultA.reconnect();
    // Provider sync is deferred to a microtask — await it
    await Promise.resolve();

    // Re-acquire lock to trigger fork reconciliation
    ctx.vaultA.send({ type: 'SET_MODE_ACTIVE' });
    ctx.vaultA.send({ type: 'ACQUIRE_LOCK', editorContent: 'Line 1\nLine 2 LOCAL\nLine 3' });

    // ACQUIRE_LOCK resets providerSynced. The real provider is already synced,
    // so ProviderIntegration would fire PROVIDER_SYNCED on reconnect — but
    // ACQUIRE_LOCK clears it. Resend to trigger reconcileForkInActive.
    ctx.vaultA.send({ type: 'PROVIDER_SYNCED' });

    const statePath = ctx.vaultA.hsm.statePath;

    // diff3 detects conflict on Line 2:
    // base="Line 2", local="Line 2 LOCAL", remote="Line 2 REMOTE"
    expect(statePath === 'idle.diverged' || statePath.includes('conflict')).toBe(true);

    ctx.destroy();
  });
});
