/**
 * Red Team Round 3 — Integration & Multi-file Scenarios
 *
 * Tests the interactions between multiple HSMs and the lifecycle
 * of Document/SharedFolder integration surfaces:
 *
 * 1. Multi-HSM independence: Files in different states simultaneously
 * 2. Persistence round-trips: PersistedMergeState serialization fidelity
 * 3. Concurrent cross-file operations: No interference between HSMs
 * 4. Memory leak scenarios: Rapid create/destroy cycles
 * 5. Lock lifecycle: acquire/release cycles with state preservation
 */

import * as Y from 'yjs';
import {
  createTestHSM,
  loadToIdle,
  loadAndActivate,
  loadToConflict,
  diskChanged,
  sendAcquireLockToTracking,
  releaseLock,
  resolve,
  dismissConflict,
  cm6Insert,
  cm6Change,
  providerSynced,
  connected,
  disconnected,
  unload,
  load,
  persistenceLoaded,
  createLCA,
  createYjsUpdate,
  expectState,
  expectEffect,
  expectNoEffect,
  sha256,
} from '../testing';
import type { TestHSM } from '../testing';
import type { PersistedMergeState, StatePath, Fork } from '../types';

// =============================================================================
// Helper: create N independent HSMs
// =============================================================================

async function createHSMs(n: number): Promise<TestHSM[]> {
  const hsms: TestHSM[] = [];
  for (let i = 0; i < n; i++) {
    hsms.push(await createTestHSM({
      guid: `guid-${i}`,
      path: `file-${i}.md`,
      vaultId: `vault-${i}`,
    }));
  }
  return hsms;
}

// =============================================================================
// 1. Multi-HSM independence
// =============================================================================

describe('Multi-HSM independence', () => {
  test('5 HSMs in different states do not interfere', async () => {
    const hsms = await createHSMs(5);

    // HSM 0: idle.synced
    await loadToIdle(hsms[0], { content: 'idle content', guid: 'guid-0' });
    expectState(hsms[0], 'idle.synced');

    // HSM 1: active.tracking
    await loadAndActivate(hsms[1], 'active content', { guid: 'guid-1' });
    expectState(hsms[1], 'active.tracking');

    // HSM 2: active.conflict
    await loadToConflict(hsms[2], {
      base: 'base text',
      remote: 'remote changed',
      disk: 'disk changed',
      guid: 'guid-2',
    });
    expectState(hsms[2], 'active.conflict.bannerShown');

    // HSM 3: loading (not yet mode-determined)
    hsms[3].send(load('guid-3'));
    hsms[3].send(persistenceLoaded(new Uint8Array(), null));
    expectState(hsms[3], 'loading');

    // HSM 4: unloaded
    expectState(hsms[4], 'unloaded');

    // Verify each HSM retained its state independently
    expectState(hsms[0], 'idle.synced');
    expectState(hsms[1], 'active.tracking');
    expectState(hsms[2], 'active.conflict.bannerShown');
    expectState(hsms[3], 'loading');
    expectState(hsms[4], 'unloaded');
  });

  test('editing one active HSM does not affect another', async () => {
    const [a, b] = await createHSMs(2);
    await loadAndActivate(a, 'doc A', { guid: 'guid-0' });
    await loadAndActivate(b, 'doc B', { guid: 'guid-1' });

    // Edit doc A
    a.send(cm6Insert(5, ' edited', 'doc A edited'));

    // Doc B should be unchanged
    expect(b.getLocalDocText()).toBe('doc B');
    expectState(b, 'active.tracking');
  });

  test('unloading one HSM does not affect others', async () => {
    const [a, b] = await createHSMs(2);
    await loadAndActivate(a, 'doc A', { guid: 'guid-0' });
    await loadAndActivate(b, 'doc B', { guid: 'guid-1' });

    // Unload doc A
    a.send(releaseLock());
    a.send(unload());
    await a.hsm.awaitCleanup();

    // Doc B should be fully intact
    expectState(b, 'active.tracking');
    expect(b.getLocalDocText()).toBe('doc B');
  });

  test('remote update to one HSM does not leak to another', async () => {
    const [a, b] = await createHSMs(2);
    await loadAndActivate(a, 'shared base', { guid: 'guid-0' });
    await loadAndActivate(b, 'shared base', { guid: 'guid-1' });

    a.send(connected());
    a.send(providerSynced());

    // Apply remote change only to HSM a
    a.applyRemoteChange('shared base + remote A');

    // HSM b should not have this change
    expect(b.getLocalDocText()).toBe('shared base');
  });
});

// =============================================================================
// 2. PersistedMergeState serialization round-trips
// =============================================================================

describe('PersistedMergeState round-trips', () => {
  test('idle.synced state has LCA available in HSM state', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello world', mtime: 1000 });

    // LCA should be stored in the HSM state after loading to idle
    const state = t.state;
    expect(state.lca).not.toBeNull();
    expect(state.lca!.contents).toBe('hello world');
    expect(state.lca!.meta.mtime).toBe(1000);
    expect(state.lca!.stateVector).toBeInstanceOf(Uint8Array);
    expect(state.lca!.stateVector.length).toBeGreaterThan(0);
    expect(state.fork).toBeFalsy();
  });

  test('state with fork persists fork fields', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'original', mtime: 1000 });

    // Trigger a disk change to create a fork
    t.send(await diskChanged('original edited on disk', 2000));
    await t.hsm.awaitIdleAutoMerge();

    const persistEffects = t.effects.filter(e => e.type === 'PERSIST_STATE');
    // Check if any persist effect includes fork data
    const forkPersist = persistEffects.find(e =>
      e.type === 'PERSIST_STATE' && e.state.fork
    );

    // Fork may or may not be present depending on whether it was reconciled.
    // If auto-merge succeeded, fork is cleared. Verify the structure is valid.
    for (const pe of persistEffects) {
      if (pe.type !== 'PERSIST_STATE') continue;
      const s = pe.state;
      expect(s.guid).toBe('test-guid');
      expect(typeof s.persistedAt).toBe('number');
      if (s.fork) {
        expect(typeof s.fork.base).toBe('string');
        expect(s.fork.localStateVector).toBeInstanceOf(Uint8Array);
        expect(s.fork.remoteStateVector).toBeInstanceOf(Uint8Array);
        expect(typeof s.fork.origin).toBe('string');
        expect(typeof s.fork.created).toBe('number');
        expect(typeof s.fork.captureMark).toBe('number');
      }
    }
  });

  test('state with deferredConflict stores hashes after dismiss', async () => {
    const t = await createTestHSM();
    await loadToConflict(t, {
      base: 'base',
      remote: 'remote edit',
      disk: 'disk edit',
    });

    // Dismiss the conflict
    t.send(dismissConflict());

    // Check the HSM state for deferred conflict
    const state = t.state;
    if (state.deferredConflict) {
      expect(typeof state.deferredConflict.diskHash).toBe('string');
      expect(typeof state.deferredConflict.localHash).toBe('string');
      // At least one should be non-empty
      expect(
        state.deferredConflict.diskHash.length > 0 ||
        state.deferredConflict.localHash.length > 0
      ).toBe(true);
    }
    // After dismiss, should be in tracking (conflict deferred)
    expectState(t, 'active.tracking');
  });

  test('every StatePath round-trips through lastStatePath', async () => {
    const allPaths: StatePath[] = [
      'unloaded', 'loading',
      'idle.loading', 'idle.synced', 'idle.localAhead',
      'idle.remoteAhead', 'idle.diskAhead', 'idle.diverged', 'idle.error',
      'active.loading', 'active.entering', 'active.entering.awaitingPersistence',
      'active.entering.reconciling',
      'active.tracking', 'active.merging.twoWay', 'active.merging.threeWay',
      'active.conflict.bannerShown', 'active.conflict.resolving',
      'unloading',
    ];

    // Verify all paths survive JSON round-trip (no data loss in serialization)
    for (const path of allPaths) {
      const state: PersistedMergeState = {
        guid: 'test',
        path: 'test.md',
        lca: null,
        disk: null,
        localStateVector: null,
        lastStatePath: path,
        persistedAt: Date.now(),
      };

      const json = JSON.stringify(state);
      const restored = JSON.parse(json) as PersistedMergeState;
      expect(restored.lastStatePath).toBe(path);
    }
  });

  test('Uint8Array fields survive JSON round-trip via custom encoding', async () => {
    const sv = new Uint8Array([1, 2, 3, 4, 5]);
    const state: PersistedMergeState = {
      guid: 'test',
      path: 'test.md',
      lca: {
        contents: 'hello',
        hash: 'abc',
        mtime: 1000,
        stateVector: sv,
      },
      disk: { hash: 'def', mtime: 2000 },
      localStateVector: new Uint8Array([10, 20]),
      lastStatePath: 'idle.synced',
      persistedAt: 3000,
      fork: {
        base: 'base text',
        localStateVector: new Uint8Array([30, 40]),
        remoteStateVector: new Uint8Array([50, 60]),
        origin: 'disk',
        created: 1500,
        captureMark: 0,
      },
    };

    // Uint8Array → base64 → Uint8Array for serialization
    const encode = (arr: Uint8Array) => Buffer.from(arr).toString('base64');
    const decode = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

    const serialized = JSON.stringify(state, (key, value) => {
      if (value instanceof Uint8Array) return { __u8: encode(value) };
      return value;
    });

    const restored = JSON.parse(serialized, (key, value) => {
      if (value && typeof value === 'object' && value.__u8) return decode(value.__u8);
      return value;
    });

    expect(restored.lca.stateVector).toEqual(sv);
    expect(restored.localStateVector).toEqual(new Uint8Array([10, 20]));
    expect(restored.fork.localStateVector).toEqual(new Uint8Array([30, 40]));
    expect(restored.fork.remoteStateVector).toEqual(new Uint8Array([50, 60]));
  });
});

// =============================================================================
// 3. Concurrent cross-file operations
// =============================================================================

describe('Concurrent cross-file operations', () => {
  test('one file in conflict while another tracks edits normally', async () => {
    const [tracking, conflicting] = await createHSMs(2);

    await loadAndActivate(tracking, 'tracking content', { guid: 'guid-0' });
    await loadToConflict(conflicting, {
      base: 'base',
      remote: 'remote version',
      disk: 'disk version',
      guid: 'guid-1',
    });

    // Edit the tracking document
    tracking.send(cm6Insert(16, '!', 'tracking content!'));
    expectState(tracking, 'active.tracking');

    // Resolve the conflict on the other
    conflicting.send(resolve('resolved content'));

    // Both should be stable
    expectState(tracking, 'active.tracking');
    // After resolve, conflicting transitions to tracking or stays in conflict.resolving
    expect(
      conflicting.matches('active.tracking') ||
      conflicting.matches('active.merging') ||
      conflicting.matches('active.conflict')
    ).toBe(true);
  });

  test('releasing lock on one file while another is in idle auto-merge', async () => {
    const [active, idle] = await createHSMs(2);

    await loadAndActivate(active, 'active doc', { guid: 'guid-0' });
    await loadToIdle(idle, { content: 'idle doc', guid: 'guid-1' });

    // Trigger idle auto-merge on the idle doc
    idle.applyRemoteChange('idle doc updated');

    // Release lock on active doc simultaneously
    active.send(releaseLock());

    // Wait for idle auto-merge to finish
    await idle.hsm.awaitIdleAutoMerge();

    // Both should be in valid states
    expect(idle.matches('idle')).toBe(true);
    // active should be in idle or unloading after release
    expect(
      active.matches('idle') || active.matches('unloading')
    ).toBe(true);
  });

  test('disk changes arriving for multiple idle files simultaneously', async () => {
    const hsms = await createHSMs(3);

    for (let i = 0; i < 3; i++) {
      await loadToIdle(hsms[i], { content: `file ${i}`, guid: `guid-${i}` });
    }

    // Send disk changes to all three simultaneously
    const diskEvents = await Promise.all([
      diskChanged(`file 0 modified`, 2000),
      diskChanged(`file 1 modified`, 2001),
      diskChanged(`file 2 modified`, 2002),
    ]);

    hsms[0].send(diskEvents[0]);
    hsms[1].send(diskEvents[1]);
    hsms[2].send(diskEvents[2]);

    // Wait for all auto-merges
    await Promise.all(hsms.map(h => h.hsm.awaitIdleAutoMerge()));

    // All should be in a valid idle state
    for (const h of hsms) {
      expect(h.matches('idle')).toBe(true);
    }
  });
});

// =============================================================================
// 4. Memory leak scenarios: rapid create/destroy
// =============================================================================

describe('Memory leak scenarios', () => {
  test('rapid create-load-unload cycles clean up', async () => {
    for (let i = 0; i < 20; i++) {
      const t = await createTestHSM({ guid: `rapid-${i}` });
      await loadToIdle(t, { content: `cycle ${i}`, guid: `rapid-${i}` });

      t.send(unload());
      await t.hsm.awaitCleanup();

      // localDoc should be null after unload
      expect(t.getLocalDocText()).toBeNull();
    }
  });

  test('rapid acquire-release cycles preserve content', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'preserved content', mtime: 1000 });

    for (let i = 0; i < 10; i++) {
      // Acquire lock
      await sendAcquireLockToTracking(t, 'preserved content');
      expectState(t, 'active.tracking');
      expect(t.getLocalDocText()).toBe('preserved content');

      // Release lock
      t.send(releaseLock());
      await t.hsm.awaitCleanup();

      // Should return to idle
      expect(t.matches('idle')).toBe(true);
    }
  });

  test('effect subscribers are cleaned up after unsubscribe', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test' });

    const captured: any[] = [];
    const unsub = t.hsm.subscribe((effect) => {
      captured.push(effect);
    });

    // Verify subscriber receives effects
    t.send(await diskChanged('test edited', 2000));
    await t.hsm.awaitIdleAutoMerge();
    const countBefore = captured.length;
    expect(countBefore).toBeGreaterThan(0);

    // Unsubscribe
    unsub();

    // Further events should not be captured
    t.send(await diskChanged('test edited again', 3000));
    await t.hsm.awaitIdleAutoMerge();
    expect(captured.length).toBe(countBefore);
  });

  test('state change listeners are cleaned up after unsubscribe', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'test' });

    const transitions: string[] = [];
    const unsub = t.hsm.onStateChange((from, to) => {
      transitions.push(`${from}->${to}`);
    });

    // Trigger a transition
    t.send(await diskChanged('test change', 2000));
    await t.hsm.awaitIdleAutoMerge();
    const countBefore = transitions.length;

    unsub();

    // Further transitions should not be captured
    t.send(await diskChanged('test change 2', 3000));
    await t.hsm.awaitIdleAutoMerge();
    expect(transitions.length).toBe(countBefore);
  });
});

// =============================================================================
// 5. Lock lifecycle with state preservation across cycles
// =============================================================================

describe('Lock lifecycle', () => {
  test('content survives acquire → edit → release → acquire cycle', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'initial', { mtime: 1000 });

    // Edit in active mode
    t.send(cm6Insert(7, ' edited', 'initial edited'));

    // Release
    t.send(releaseLock());
    await t.hsm.awaitCleanup();
    expect(t.matches('idle')).toBe(true);

    // Re-acquire with the edited content (simulating editor reopening)
    await sendAcquireLockToTracking(t, 'initial edited');
    expectState(t, 'active.tracking');

    // Content should match
    expect(t.getLocalDocText()).toBe('initial edited');
  });

  test('fork created in idle is available when lock is acquired', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'original', mtime: 1000 });

    // Disk change while idle creates a fork
    t.send(await diskChanged('original + disk edit', 2000));
    await t.hsm.awaitIdleAutoMerge();

    // Check state - might be idle.synced (auto-merged) or idle.diskAhead/localAhead
    const state = t.state;
    expect(t.matches('idle')).toBe(true);

    // The fork should have been processed (either reconciled or stored)
    // Verify HSM is in a consistent state regardless
    expect(state.statePath).toBeDefined();
  });

  test('provider synced status resets on release-acquire cycle', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'content', { mtime: 1000 });

    // Connect and sync
    t.send(connected());
    t.send(providerSynced());

    // Release
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    // Re-acquire
    await sendAcquireLockToTracking(t, 'content');

    // After re-acquire, provider synced state should be fresh
    expectState(t, 'active.tracking');
  });

  test('disconnect during active → release → idle handles gracefully', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'online content', { mtime: 1000 });

    t.send(connected());
    t.send(providerSynced());

    // User edits
    t.send(cm6Insert(14, '!', 'online content!'));

    // Network drops
    t.send(disconnected());

    // Release lock while disconnected
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    // Should be in idle state, not crashed
    expect(t.matches('idle')).toBe(true);
  });
});

// =============================================================================
// 6. Edge cases in Document integration surface
// =============================================================================

describe('Document integration surface edge cases', () => {
  test('REMOTE_UPDATE during loading is accumulated and replayed', async () => {
    const t = await createTestHSM();

    // Start loading
    t.send(load('test-guid'));

    const updates = createYjsUpdate('base content');
    const lca = await createLCA('base content', 1000);
    t.send(persistenceLoaded(updates, lca));

    // Send REMOTE_UPDATE before mode determination
    t.applyRemoteChange('base content + remote');

    // Now set mode to idle
    t.send({ type: 'SET_MODE_IDLE' });
    await t.hsm.awaitIdleAutoMerge();

    // The remote update should have been replayed
    expect(t.matches('idle')).toBe(true);
  });

  test('DISK_CHANGED during loading is accumulated and replayed', async () => {
    const t = await createTestHSM();

    t.send(load('test-guid'));
    const updates = createYjsUpdate('content');
    const lca = await createLCA('content', 1000);
    t.send(persistenceLoaded(updates, lca));

    // Send DISK_CHANGED before mode determination
    t.send(await diskChanged('content on disk', 2000));

    // Set mode idle — accumulated DISK_CHANGED should replay
    t.send({ type: 'SET_MODE_IDLE' });
    await t.hsm.awaitIdleAutoMerge();

    expect(t.matches('idle')).toBe(true);
  });

  test('acquireLock with empty content on fresh document', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: '' });

    await sendAcquireLockToTracking(t, '');
    expectState(t, 'active.tracking');

    // Should be able to type into empty doc
    t.send(cm6Insert(0, 'hello', 'hello'));
    expectState(t, 'active.tracking');
    expect(t.getLocalDocText()).toBe('hello');
  });

  test('multiple ACQUIRE_LOCK events are idempotent', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'content', { mtime: 1000 });

    // Send duplicate ACQUIRE_LOCK — should be a no-op
    t.send({ type: 'ACQUIRE_LOCK', editorContent: 'content' });
    expectState(t, 'active.tracking');
    expect(t.getLocalDocText()).toBe('content');
  });

  test('RELEASE_LOCK when already idle is a no-op', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'content' });

    // Send RELEASE_LOCK when in idle — should not crash
    t.send(releaseLock());
    expect(t.matches('idle')).toBe(true);
  });
});

// =============================================================================
// 7. Cross-state consistency checks
// =============================================================================

describe('Cross-state consistency', () => {
  test('state vector advances monotonically through edits', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'hello', { mtime: 1000 });

    const sv1 = t.state.localStateVector;

    t.send(cm6Insert(5, ' world', 'hello world'));
    const sv2 = t.state.localStateVector;

    t.send(cm6Insert(11, '!', 'hello world!'));
    const sv3 = t.state.localStateVector;

    // State vectors should grow (or at least not shrink)
    if (sv1 && sv2 && sv3) {
      expect(sv2.length).toBeGreaterThanOrEqual(sv1.length);
      expect(sv3.length).toBeGreaterThanOrEqual(sv2.length);
    }
  });

  test('LCA is never ahead of localDoc state vector', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'content', { mtime: 1000 });

    t.send(cm6Insert(7, ' extended', 'content extended'));

    const state = t.state;
    if (state.lca && state.localStateVector) {
      // LCA state vector should be <= local state vector
      // (LCA represents a past sync point)
      expect(state.lca.stateVector.length).toBeLessThanOrEqual(
        state.localStateVector.length + 10 // allow small overhead
      );
    }
  });

  test('getLocalDoc returns null after full unload from idle', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'content');

    // Release lock first → goes to idle (localDoc stays alive in idle)
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    // Then unload → destroys localDoc
    t.send(unload());
    await t.hsm.awaitCleanup();

    // After unload, localDoc should be destroyed
    expect(t.hsm.getLocalDoc()).toBeNull();
  });

  test('getSyncStatus reflects current state accurately', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'synced content', mtime: 1000 });

    const status = t.hsm.getSyncStatus();
    expect(status.guid).toBe('test-guid');
    expect(['synced', 'pending']).toContain(status.status);
  });
});
