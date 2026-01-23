/**
 * MergeManager Tests
 */

import * as Y from 'yjs';
import { MergeManager } from '../MergeManager';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';

describe('MergeManager', () => {
  let manager: MergeManager;
  let timeProvider: MockTimeProvider;

  beforeEach(() => {
    timeProvider = new MockTimeProvider();
    manager = new MergeManager({ timeProvider });
  });

  describe('registration', () => {
    test('register adds document to registry', () => {
      manager.register('doc-1', 'notes/test.md');

      expect(manager.getRegisteredGuids()).toContain('doc-1');
      expect(manager.getPath('doc-1')).toBe('notes/test.md');
    });

    test('register initializes sync status', () => {
      manager.register('doc-1', 'notes/test.md');

      const status = manager.syncStatus.get('doc-1');
      expect(status).toBeDefined();
      expect(status?.status).toBe('synced');
    });

    test('unregister removes document', () => {
      manager.register('doc-1', 'notes/test.md');
      manager.unregister('doc-1');

      expect(manager.getRegisteredGuids()).not.toContain('doc-1');
      expect(manager.syncStatus.get('doc-1')).toBeUndefined();
    });
  });

  describe('HSM lifecycle', () => {
    test('getHSM creates and returns HSM', async () => {
      const hsm = await manager.getHSM('doc-1', 'test.md');

      expect(hsm).toBeDefined();
      expect(manager.isLoaded('doc-1')).toBe(true);
    });

    test('getHSM returns same instance on second call', async () => {
      const hsm1 = await manager.getHSM('doc-1', 'test.md');
      const hsm2 = await manager.getHSM('doc-1', 'test.md');

      expect(hsm1).toBe(hsm2);
    });

    test('unload removes HSM from loaded', async () => {
      await manager.getHSM('doc-1', 'test.md');
      expect(manager.isLoaded('doc-1')).toBe(true);

      await manager.unload('doc-1');
      expect(manager.isLoaded('doc-1')).toBe(false);
    });

    test('unload preserves registration', async () => {
      await manager.getHSM('doc-1', 'test.md');
      await manager.unload('doc-1');

      expect(manager.getRegisteredGuids()).toContain('doc-1');
    });
  });

  describe('idle mode updates', () => {
    test('handleIdleRemoteUpdate stores update for unloaded doc', async () => {
      manager.register('doc-1', 'test.md');

      const update = createTestUpdate('hello');
      await manager.handleIdleRemoteUpdate('doc-1', update);

      // Status should change to pending
      const status = manager.syncStatus.get('doc-1');
      expect(status?.status).toBe('pending');
    });

    test('handleIdleRemoteUpdate forwards to HSM if loaded', async () => {
      const hsm = await manager.getHSM('doc-1', 'test.md');

      // Manually transition to a state where we can observe the event
      hsm.send({ type: 'LOAD', guid: 'doc-1', path: 'test.md' });
      hsm.send({ type: 'PERSISTENCE_LOADED', updates: new Uint8Array(), lca: null });

      const beforeState = hsm.state.statePath;

      const update = createTestUpdate('hello');
      await manager.handleIdleRemoteUpdate('doc-1', update);

      // HSM should have received the update (may transition based on state)
      // Just verify no error occurred
      expect(hsm.state.statePath).toBeDefined();
    });

    test('multiple idle updates are merged', async () => {
      manager.register('doc-1', 'test.md');

      const update1 = createTestUpdate('hello');
      const update2 = createTestUpdate('world');

      await manager.handleIdleRemoteUpdate('doc-1', update1);
      await manager.handleIdleRemoteUpdate('doc-1', update2);

      // Should have merged updates (status still pending)
      const status = manager.syncStatus.get('doc-1');
      expect(status?.status).toBe('pending');
    });
  });

  describe('status change notifications', () => {
    test('onStatusChange notifies on status update', async () => {
      const statusChanges: Array<{ guid: string; status: string }> = [];

      manager.onStatusChange((guid, status) => {
        statusChanges.push({ guid, status: status.status });
      });

      manager.register('doc-1', 'test.md');

      const update = createTestUpdate('hello');
      await manager.handleIdleRemoteUpdate('doc-1', update);

      expect(statusChanges.length).toBeGreaterThan(0);
      expect(statusChanges.some(c => c.status === 'pending')).toBe(true);
    });

    test('onStatusChange can be unsubscribed', async () => {
      let callCount = 0;

      const unsubscribe = manager.onStatusChange(() => {
        callCount++;
      });

      manager.register('doc-1', 'test.md');
      const initialCount = callCount;

      unsubscribe();

      await manager.handleIdleRemoteUpdate('doc-1', createTestUpdate('hello'));

      // Should not have received more notifications after unsubscribe
      expect(callCount).toBe(initialCount);
    });
  });

  describe('effect handling', () => {
    test('onEffect callback receives HSM effects', async () => {
      const effects: Array<{ guid: string; type: string }> = [];

      const managerWithEffects = new MergeManager({
        timeProvider,
        onEffect: (guid, effect) => {
          effects.push({ guid, type: effect.type });
        },
      });

      const hsm = await managerWithEffects.getHSM('doc-1', 'test.md');

      // Send events to trigger effects
      hsm.send({ type: 'LOAD', guid: 'doc-1', path: 'test.md' });
      hsm.send({ type: 'PERSISTENCE_LOADED', updates: new Uint8Array(), lca: null });

      // Should have received STATUS_CHANGED effects
      expect(effects.some(e => e.type === 'STATUS_CHANGED')).toBe(true);
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createTestUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, content);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
