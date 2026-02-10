/**
 * Hibernation Lifecycle Tests
 *
 * Tests the wake/hibernate lifecycle in MergeManager:
 * - Documents start hibernated (no YDocs in memory)
 * - Remote updates buffer while hibernated
 * - Wake drains buffer into HSM
 * - Hibernate timer re-hibernates warm documents
 * - Priority wake queue respects bounded concurrency
 * - Active mode prevents hibernation
 */

import * as Y from 'yjs';
import { MergeManager, WakePriority, type HibernationState } from '../MergeManager';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';
import { PostOffice } from '../../../src/observable/Postie';

function createRemoteDoc(): Y.Doc {
  return new Y.Doc();
}

function createUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, content);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

describe('Hibernation Lifecycle', () => {
  let manager: MergeManager;
  let timeProvider: MockTimeProvider;

  beforeEach(() => {
    timeProvider = new MockTimeProvider();

    PostOffice.destroy();
    // @ts-ignore
    PostOffice["instance"] = new PostOffice(timeProvider);
    // @ts-ignore
    PostOffice["_destroyed"] = false;

    manager = new MergeManager({
      getVaultId: (guid) => `test-${guid}`,
      timeProvider,
      hibernation: {
        hibernateTimeoutMs: 60_000,
        maxConcurrentWarm: 3,
      },
    });
  });

  afterEach(() => {
    manager.destroy();
    PostOffice.destroy();
  });

  describe('initial state', () => {
    test('registered documents start hibernated', async () => {
      await manager.register('doc-1', 'test.md', null);
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
    });

    test('getOrRegisterHSM documents start hibernated', () => {
      manager.getOrRegisterHSM('doc-1', 'test.md', null);
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
    });

    test('unknown documents return hibernated', () => {
      expect(manager.getHibernationState('unknown')).toBe('hibernated');
    });
  });

  describe('update buffering', () => {
    test('remote updates buffer then drain via wake queue', async () => {
      // Use concurrency 0 to prevent auto-draining
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 0,
        },
      });
      await strictManager.register('doc-1', 'test.md', null);

      const update = createUpdate('hello');
      strictManager.handleRemoteUpdate('doc-1', update);

      const buffer = strictManager.getHibernationBuffer('doc-1');
      expect(buffer).not.toBeNull();
      expect(buffer!.length).toBeGreaterThan(0);

      strictManager.destroy();
    });

    test('multiple updates are compacted via mergeUpdates', async () => {
      // Use concurrency 0 to prevent auto-draining
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 0,
        },
      });
      await strictManager.register('doc-1', 'test.md', null);

      const update1 = createUpdate('hello');
      const update2 = createUpdate('world');

      strictManager.handleRemoteUpdate('doc-1', update1);
      strictManager.handleRemoteUpdate('doc-1', update2);
      const buffer = strictManager.getHibernationBuffer('doc-1');

      expect(buffer).not.toBeNull();
      expect(buffer!.length).toBeGreaterThan(0);

      strictManager.destroy();
    });

    test('no buffer for unregistered documents', () => {
      const update = createUpdate('hello');
      manager.handleRemoteUpdate('unknown-guid', update);
      expect(manager.getHibernationBuffer('unknown-guid')).toBeNull();
    });
  });

  describe('wake()', () => {
    test('wake transitions from hibernated to warm', async () => {
      await manager.register('doc-1', 'test.md', null);
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');

      const remoteDoc = createRemoteDoc();
      manager.wake('doc-1', remoteDoc);

      expect(manager.getHibernationState('doc-1')).toBe('warm');
    });

    test('wake drains buffered updates into HSM', async () => {
      // Use concurrency 0 to keep buffer intact until explicit wake()
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 0,
        },
      });
      await strictManager.register('doc-1', 'test.md', null);

      const update = createUpdate('hello');
      strictManager.handleRemoteUpdate('doc-1', update);
      expect(strictManager.getHibernationBuffer('doc-1')).not.toBeNull();

      const remoteDoc = createRemoteDoc();
      strictManager.wake('doc-1', remoteDoc);

      // Buffer should be drained
      expect(strictManager.getHibernationBuffer('doc-1')).toBeNull();

      strictManager.destroy();
    });

    test('wake sets remoteDoc on HSM', async () => {
      await manager.register('doc-1', 'test.md', null);

      const hsm = manager.getIdleHSM('doc-1');
      expect(hsm?.getRemoteDoc()).toBeNull();

      const remoteDoc = createRemoteDoc();
      manager.wake('doc-1', remoteDoc);

      expect(hsm?.getRemoteDoc()).toBe(remoteDoc);
    });
  });

  describe('hibernate()', () => {
    test('hibernate transitions from warm to hibernated', async () => {
      await manager.register('doc-1', 'test.md', null);

      const remoteDoc = createRemoteDoc();
      manager.wake('doc-1', remoteDoc);
      expect(manager.getHibernationState('doc-1')).toBe('warm');

      manager.hibernate('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
    });

    test('hibernate detaches remoteDoc from HSM', async () => {
      await manager.register('doc-1', 'test.md', null);

      const remoteDoc = createRemoteDoc();
      manager.wake('doc-1', remoteDoc);
      expect(manager.getIdleHSM('doc-1')?.getRemoteDoc()).toBe(remoteDoc);

      manager.hibernate('doc-1');
      expect(manager.getIdleHSM('doc-1')?.getRemoteDoc()).toBeNull();
    });

    test('hibernate is no-op for already hibernated', async () => {
      await manager.register('doc-1', 'test.md', null);
      manager.hibernate('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
    });

    test('hibernate is no-op for active documents', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      manager.wake('doc-1', remoteDoc);
      manager.markActive('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('active');

      manager.hibernate('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('active');
    });
  });

  describe('hibernate timer', () => {
    test('warm documents re-hibernate after timeout', async () => {
      await manager.register('doc-1', 'test.md', null);

      const remoteDoc = createRemoteDoc();
      manager.wake('doc-1', remoteDoc);
      expect(manager.getHibernationState('doc-1')).toBe('warm');

      // Advance time past the hibernate timeout
      timeProvider.setTime(timeProvider.now() + 61_000);
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
    });

    test('activity resets the hibernate timer', async () => {
      await manager.register('doc-1', 'test.md', null);

      const remoteDoc = createRemoteDoc();
      manager.wake('doc-1', remoteDoc);

      // Advance 30 seconds
      timeProvider.setTime(timeProvider.now() + 30_000);
      expect(manager.getHibernationState('doc-1')).toBe('warm');

      // Send a remote update (resets timer)
      const update = createUpdate('activity');
      manager.handleRemoteUpdate('doc-1', update);

      // Advance another 45 seconds (75s total, but only 45s since last activity)
      timeProvider.setTime(timeProvider.now() + 45_000);
      expect(manager.getHibernationState('doc-1')).toBe('warm');

      // Advance past 60s since last activity
      timeProvider.setTime(timeProvider.now() + 20_000);
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
    });
  });

  describe('active mode', () => {
    test('markActive transitions to active and clears timer', async () => {
      await manager.register('doc-1', 'test.md', null);

      const remoteDoc = createRemoteDoc();
      manager.wake('doc-1', remoteDoc);
      manager.markActive('doc-1');

      expect(manager.getHibernationState('doc-1')).toBe('active');

      // Timer should be cleared - advancing time should NOT hibernate
      timeProvider.setTime(timeProvider.now() + 120_000);
      expect(manager.getHibernationState('doc-1')).toBe('active');
    });

    test('unload transitions from active to warm with timer', async () => {
      const remoteDoc = createRemoteDoc();
      const hsm = await manager.getHSM('doc-1', 'test.md', remoteDoc);

      expect(manager.getHibernationState('doc-1')).toBe('active');

      await manager.unload('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('warm');

      // Should eventually hibernate
      timeProvider.setTime(timeProvider.now() + 61_000);
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
    });
  });

  describe('wake queue', () => {
    test('enqueueWake processes hibernated documents', async () => {
      await manager.register('doc-1', 'test.md', null);

      manager.enqueueWake({
        guid: 'doc-1',
        priority: WakePriority.REMOTE_UPDATE,
      });

      // Background wake should have processed
      expect(manager.getHibernationState('doc-1')).toBe('warm');
    });

    test('enqueueWake respects bounded concurrency', async () => {
      // Register 5 documents
      for (let i = 1; i <= 5; i++) {
        await manager.register(`doc-${i}`, `test-${i}.md`, null);
      }

      // Enqueue all at same priority
      for (let i = 1; i <= 5; i++) {
        manager.enqueueWake({
          guid: `doc-${i}`,
          priority: WakePriority.CACHE_VALIDATION,
        });
      }

      // Max 3 concurrent warm
      let warmCount = 0;
      for (let i = 1; i <= 5; i++) {
        if (manager.getHibernationState(`doc-${i}`) === 'warm') {
          warmCount++;
        }
      }
      expect(warmCount).toBeLessThanOrEqual(3);
    });

    test('enqueueWake prioritizes higher priority requests', async () => {
      // Manager with concurrency 1 to test ordering
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 1,
        },
      });

      await strictManager.register('low', 'low.md', null);
      await strictManager.register('high', 'high.md', null);

      // Enqueue low priority first, then high
      strictManager.enqueueWake({
        guid: 'low',
        priority: WakePriority.CACHE_VALIDATION,
      });

      // Low should have been processed (concurrency 1)
      expect(strictManager.getHibernationState('low')).toBe('warm');
      expect(strictManager.getHibernationState('high')).toBe('hibernated');

      // Hibernate the low-priority doc to free up slot
      strictManager.hibernate('low');

      strictManager.enqueueWake({
        guid: 'high',
        priority: WakePriority.OPEN_DOC,
      });
      expect(strictManager.getHibernationState('high')).toBe('warm');

      strictManager.destroy();
    });

    test('enqueueWake buffers updates', async () => {
      await manager.register('doc-1', 'test.md', null);

      const update = createUpdate('buffered');
      manager.enqueueWake({
        guid: 'doc-1',
        priority: WakePriority.REMOTE_UPDATE,
        update,
      });

      // Buffer should have been drained by wake
      expect(manager.getHibernationBuffer('doc-1')).toBeNull();
    });

    test('enqueueWake is no-op for warm documents', async () => {
      await manager.register('doc-1', 'test.md', null);

      const remoteDoc = createRemoteDoc();
      manager.wake('doc-1', remoteDoc);

      manager.enqueueWake({
        guid: 'doc-1',
        priority: WakePriority.REMOTE_UPDATE,
      });

      // Still warm, timer just reset
      expect(manager.getHibernationState('doc-1')).toBe('warm');
    });

    test('enqueueWake upgrades priority for queued requests', async () => {
      // Manager with concurrency 0 (nothing processes) to test queue ordering
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 0, // nothing can wake
        },
      });

      await strictManager.register('doc-1', 'test.md', null);

      strictManager.enqueueWake({
        guid: 'doc-1',
        priority: WakePriority.CACHE_VALIDATION,
      });

      // Upgrade priority
      strictManager.enqueueWake({
        guid: 'doc-1',
        priority: WakePriority.OPEN_DOC,
      });

      // Still hibernated (concurrency 0), but priority should be upgraded
      expect(strictManager.getHibernationState('doc-1')).toBe('hibernated');

      strictManager.destroy();
    });
  });

  describe('cleanup', () => {
    test('unregister cleans up hibernation state', async () => {
      // Use concurrency 0 to prevent auto-draining
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 0,
        },
      });
      await strictManager.register('doc-1', 'test.md', null);

      const update = createUpdate('buffered');
      strictManager.handleRemoteUpdate('doc-1', update);
      expect(strictManager.getHibernationBuffer('doc-1')).not.toBeNull();

      await strictManager.unregister('doc-1');

      expect(strictManager.getHibernationState('doc-1')).toBe('hibernated'); // default
      expect(strictManager.getHibernationBuffer('doc-1')).toBeNull();

      strictManager.destroy();
    });

    test('destroy cleans up all hibernation resources', async () => {
      await manager.register('doc-1', 'test.md', null);
      await manager.register('doc-2', 'test2.md', null);

      manager.wake('doc-1', createRemoteDoc());
      manager.handleRemoteUpdate('doc-2', createUpdate('hello'));

      manager.destroy();

      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
      expect(manager.getHibernationState('doc-2')).toBe('hibernated');
      expect(manager.getHibernationBuffer('doc-2')).toBeNull();
    });
  });
});
