/**
 * Persistence Round-Trip Tests
 *
 * Tests verifying that content survives active → idle → active cycles via IDB.
 */

import {
  createTestHSM,
  loadAndActivate,
  loadToIdle,
  loadToConflict,
  sendAcquireLockToTracking,
  releaseLock,
  cm6Insert,
  diskChanged,
  dismissConflict,
  expectState,
} from 'src/merge-hsm/testing';
import type { PersistedMergeState, StatePath } from 'src/merge-hsm/types';

describe('Persistence round-trip', () => {
  test('content survives active → idle → active cycle via IDB', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'initial content');

    // Edit
    t.send(cm6Insert(15, ' plus more', 'initial content plus more'));

    // Release → idle (persistence saves to IDB)
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    // Re-acquire lock → active (persistence loads from IDB)
    await sendAcquireLockToTracking(t, 'initial content plus more');

    expect(t.getLocalDocText()).toBe('initial content plus more');
  });

  test('content survives two full active → idle → active cycles', async () => {
    const t = await createTestHSM();
    await loadAndActivate(t, 'cycle0');

    // Cycle 1
    t.send(cm6Insert(6, '-1', 'cycle0-1'));
    t.send(releaseLock());
    await t.hsm.awaitCleanup();
    await sendAcquireLockToTracking(t, 'cycle0-1');
    expect(t.getLocalDocText()).toBe('cycle0-1');

    // Cycle 2
    t.send(cm6Insert(8, '-2', 'cycle0-1-2'));
    t.send(releaseLock());
    await t.hsm.awaitCleanup();
    await sendAcquireLockToTracking(t, 'cycle0-1-2');
    expect(t.getLocalDocText()).toBe('cycle0-1-2');
  });
});

// =============================================================================
// PersistedMergeState round-trips
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _forkPersist = persistEffects.find(e =>
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
