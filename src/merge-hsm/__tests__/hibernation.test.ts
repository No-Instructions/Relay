/**
 * Hibernation Lifecycle Tests
 *
 * Tests the wake/hibernate lifecycle in MergeManager:
 * - Documents start warm after notifyHSMCreated (localDoc alive)
 * - Hibernate timer transitions warm → hibernated
 * - Hibernated documents buffer remote updates
 * - Wake drains buffer into HSM
 * - Priority wake queue respects bounded concurrency
 * - Active mode prevents hibernation
 */

import * as Y from 'yjs';
import { MergeManager, WakePriority, type HibernationState } from '../MergeManager';
import { MergeHSM } from '../MergeHSM';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';
import { PostOffice } from '../../../src/observable/Postie';

// Simulates a Document that owns an HSM
interface MockDocument {
  guid: string;
  path: string;
  hsm: MergeHSM | null;
  remoteDoc: Y.Doc | null;
  localDoc: Y.Doc;
  connectForForkReconcile(): Promise<void>;
  destroyIdleProviderIntegration(): void;
  hasProviderIntegration(): boolean;
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
  let documents: Map<string, MockDocument>;

  // Helper to create a mock document and its HSM
  function createMockDocument(
    guid: string,
    path: string,
    mgr: MergeManager = manager,
    remoteDoc: Y.Doc | null = null
  ): MockDocument {
    const localDoc = new Y.Doc();
    const doc: MockDocument = {
      guid,
      path,
      hsm: null,
      remoteDoc,
      localDoc,
      connectForForkReconcile: async () => {},
      destroyIdleProviderIntegration: () => {},
      hasProviderIntegration: () => false,
    };

    // Create HSM via manager factory
    doc.hsm = mgr.createHSM({
      guid,
      getPath: () => path,
      remoteDoc,
      getDiskContent: async () => ({ content: '', hash: 'empty', mtime: Date.now() }),
    });

    // Register document in our map (simulating SharedFolder.files)
    documents.set(guid, doc);

    // Notify manager that HSM was created
    mgr.notifyHSMCreated(guid);

    return doc;
  }

  beforeEach(() => {
    timeProvider = new MockTimeProvider();
    documents = new Map();

    PostOffice.destroy();
    // @ts-ignore
    PostOffice["instance"] = new PostOffice(timeProvider);
    // @ts-ignore
    PostOffice["_destroyed"] = false;

    manager = new MergeManager({
      getVaultId: (guid) => `test-${guid}`,
      getDocument: (guid) => documents.get(guid),
      timeProvider,
      hibernation: {
        hibernateTimeoutMs: 60_000,
        maxConcurrentWarm: 3,
      },
    });
  });

  afterEach(() => {
    manager.destroy();
    // Clean up documents
    for (const doc of documents.values()) {
      doc.localDoc.destroy();
      doc.remoteDoc?.destroy();
    }
    documents.clear();
    PostOffice.destroy();
  });

  describe('initial state', () => {
    test('registered documents start warm', () => {
      createMockDocument('doc-1', 'test.md');
      expect(manager.getHibernationState('doc-1')).toBe('warm');
    });

    test('unknown documents return hibernated', () => {
      expect(manager.getHibernationState('unknown')).toBe('hibernated');
    });
  });

  describe('update buffering', () => {
    test('remote updates buffer when hibernated (concurrency 0)', () => {
      // Use concurrency 0 so processWakeQueue can't drain the buffer
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 0,
        },
      });
      createMockDocument('doc-1', 'test.md', strictManager);
      strictManager.hibernate('doc-1');
      expect(strictManager.getHibernationState('doc-1')).toBe('hibernated');

      const update = createUpdate('hello');
      strictManager.handleRemoteUpdate('doc-1', update);

      const buffer = strictManager.getHibernationBuffer('doc-1');
      expect(buffer).not.toBeNull();
      expect(buffer!.length).toBeGreaterThan(0);

      strictManager.destroy();
    });

    test('multiple updates are compacted via mergeUpdates', () => {
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 0,
        },
      });
      createMockDocument('doc-1', 'test.md', strictManager);
      strictManager.hibernate('doc-1');

      const update1 = createUpdate('hello');
      const update2 = createUpdate('world');

      strictManager.handleRemoteUpdate('doc-1', update1);
      strictManager.handleRemoteUpdate('doc-1', update2);
      const buffer = strictManager.getHibernationBuffer('doc-1');

      expect(buffer).not.toBeNull();
      expect(buffer!.length).toBeGreaterThan(0);

      strictManager.destroy();
    });

    test('warm documents receive updates directly (no buffer)', () => {
      createMockDocument('doc-1', 'test.md');
      expect(manager.getHibernationState('doc-1')).toBe('warm');

      const update = createUpdate('hello');
      manager.handleRemoteUpdate('doc-1', update);

      // No buffer — update goes directly to HSM
      expect(manager.getHibernationBuffer('doc-1')).toBeNull();
    });

    test('no buffer for unregistered documents', () => {
      const update = createUpdate('hello');
      manager.handleRemoteUpdate('unknown-guid', update);
      expect(manager.getHibernationBuffer('unknown-guid')).toBeNull();
    });
  });

  describe('wake()', () => {
    test('wake transitions from hibernated to warm', () => {
      createMockDocument('doc-1', 'test.md');
      manager.hibernate('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');

      const remoteDoc = new Y.Doc();
      manager.wake('doc-1', remoteDoc);

      expect(manager.getHibernationState('doc-1')).toBe('warm');
      remoteDoc.destroy();
    });

    test('wake drains buffered updates into HSM', () => {
      // Use concurrency 0 to accumulate buffer, then explicit wake() drains it
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 0,
        },
      });
      createMockDocument('doc-1', 'test.md', strictManager);
      strictManager.hibernate('doc-1');

      const update = createUpdate('hello');
      strictManager.handleRemoteUpdate('doc-1', update);
      expect(strictManager.getHibernationBuffer('doc-1')).not.toBeNull();

      const remoteDoc = new Y.Doc();
      strictManager.wake('doc-1', remoteDoc);

      // Buffer should be drained by explicit wake()
      expect(strictManager.getHibernationBuffer('doc-1')).toBeNull();

      strictManager.destroy();
      remoteDoc.destroy();
    });

    test('wake sets remoteDoc on HSM', () => {
      const doc = createMockDocument('doc-1', 'test.md');

      // Hibernate detaches remoteDoc
      manager.hibernate('doc-1');
      expect(doc.hsm?.getRemoteDoc()).toBeNull();

      const remoteDoc = new Y.Doc();
      manager.wake('doc-1', remoteDoc);

      expect(doc.hsm?.getRemoteDoc()).toBe(remoteDoc);
      remoteDoc.destroy();
    });
  });

  describe('hibernate()', () => {
    test('hibernate transitions from warm to hibernated', () => {
      createMockDocument('doc-1', 'test.md');
      expect(manager.getHibernationState('doc-1')).toBe('warm');

      manager.hibernate('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
    });

    test('hibernate detaches remoteDoc from HSM', () => {
      const remoteDoc = new Y.Doc();
      const doc = createMockDocument('doc-1', 'test.md', manager, remoteDoc);

      // remoteDoc was passed at creation
      expect(doc.hsm?.getRemoteDoc()).toBe(remoteDoc);

      manager.hibernate('doc-1');
      expect(doc.hsm?.getRemoteDoc()).toBeNull();
      remoteDoc.destroy();
    });

    test('hibernate is no-op for already hibernated', () => {
      createMockDocument('doc-1', 'test.md');
      manager.hibernate('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');

      // Second hibernate is no-op
      manager.hibernate('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
    });

    test('hibernate is no-op for active documents', () => {
      const remoteDoc = new Y.Doc();
      createMockDocument('doc-1', 'test.md', manager, remoteDoc);

      manager.markActive('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('active');

      manager.hibernate('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('active');
      remoteDoc.destroy();
    });
  });

  describe('hibernate timer', () => {
    test('warm documents re-hibernate after timeout', () => {
      createMockDocument('doc-1', 'test.md');
      expect(manager.getHibernationState('doc-1')).toBe('warm');

      // Advance time past the hibernate timeout
      timeProvider.setTime(timeProvider.now() + 61_000);
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
    });

    test('activity resets the hibernate timer', () => {
      createMockDocument('doc-1', 'test.md');
      expect(manager.getHibernationState('doc-1')).toBe('warm');

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
    test('markActive transitions to active and clears timer', () => {
      createMockDocument('doc-1', 'test.md');

      manager.markActive('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('active');

      // Timer should be cleared - advancing time should NOT hibernate
      timeProvider.setTime(timeProvider.now() + 120_000);
      expect(manager.getHibernationState('doc-1')).toBe('active');
    });

    test('unload transitions from active to warm with timer', async () => {
      const remoteDoc = new Y.Doc();
      const doc = createMockDocument('doc-1', 'test.md', manager, remoteDoc);

      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      manager.markActive('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('active');

      await manager.unload('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('warm');

      // Should eventually hibernate
      timeProvider.setTime(timeProvider.now() + 61_000);
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
      remoteDoc.destroy();
    });
  });

  describe('wake queue', () => {
    test('enqueueWake processes hibernated documents', () => {
      createMockDocument('doc-1', 'test.md');
      manager.hibernate('doc-1');
      expect(manager.getHibernationState('doc-1')).toBe('hibernated');

      manager.enqueueWake({
        guid: 'doc-1',
        priority: WakePriority.REMOTE_UPDATE,
      });

      // Background wake should have processed
      expect(manager.getHibernationState('doc-1')).toBe('warm');
    });

    test('enqueueWake respects bounded concurrency', () => {
      // Register 5 documents and hibernate them all
      for (let i = 1; i <= 5; i++) {
        createMockDocument(`doc-${i}`, `test-${i}.md`);
        manager.hibernate(`doc-${i}`);
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

    test('enqueueWake prioritizes higher priority requests', () => {
      // Manager with concurrency 1 to test ordering
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 1,
        },
      });

      createMockDocument('low', 'low.md', strictManager);
      createMockDocument('high', 'high.md', strictManager);

      // Hibernate both so wake queue is meaningful
      strictManager.hibernate('low');
      strictManager.hibernate('high');

      // Enqueue low priority first
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

    test('enqueueWake buffers updates for hibernated docs', () => {
      createMockDocument('doc-1', 'test.md');
      manager.hibernate('doc-1');

      const update = createUpdate('buffered');
      manager.enqueueWake({
        guid: 'doc-1',
        priority: WakePriority.REMOTE_UPDATE,
        update,
      });

      // Buffer should have been drained by wake
      expect(manager.getHibernationBuffer('doc-1')).toBeNull();
      // Doc should be warm after wake
      expect(manager.getHibernationState('doc-1')).toBe('warm');
    });

    test('enqueueWake is no-op for warm documents', () => {
      createMockDocument('doc-1', 'test.md');
      expect(manager.getHibernationState('doc-1')).toBe('warm');

      manager.enqueueWake({
        guid: 'doc-1',
        priority: WakePriority.REMOTE_UPDATE,
      });

      // Still warm, timer just reset
      expect(manager.getHibernationState('doc-1')).toBe('warm');
    });

    test('enqueueWake upgrades priority for queued requests', () => {
      // Manager with concurrency 0 (nothing processes) to test queue ordering
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 0,
        },
      });

      createMockDocument('doc-1', 'test.md', strictManager);
      // Hibernate so enqueueWake actually queues
      strictManager.hibernate('doc-1');

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
    test('notifyHSMDestroyed cleans up hibernation state', () => {
      // Use concurrency 0 to accumulate buffer
      const strictManager = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        hibernation: {
          hibernateTimeoutMs: 60_000,
          maxConcurrentWarm: 0,
        },
      });
      createMockDocument('doc-1', 'test.md', strictManager);
      strictManager.hibernate('doc-1');

      const update = createUpdate('buffered');
      strictManager.handleRemoteUpdate('doc-1', update);
      expect(strictManager.getHibernationBuffer('doc-1')).not.toBeNull();

      strictManager.notifyHSMDestroyed('doc-1');
      documents.delete('doc-1');

      expect(strictManager.getHibernationState('doc-1')).toBe('hibernated'); // default for unknown
      expect(strictManager.getHibernationBuffer('doc-1')).toBeNull();

      strictManager.destroy();
    });

    test('destroy cleans up all hibernation resources', () => {
      createMockDocument('doc-1', 'test.md');
      createMockDocument('doc-2', 'test2.md');

      // Hibernate doc-2 and buffer an update
      manager.hibernate('doc-2');
      manager.handleRemoteUpdate('doc-2', createUpdate('hello'));

      manager.destroy();

      expect(manager.getHibernationState('doc-1')).toBe('hibernated');
      expect(manager.getHibernationState('doc-2')).toBe('hibernated');
      expect(manager.getHibernationBuffer('doc-2')).toBeNull();
    });
  });
});
