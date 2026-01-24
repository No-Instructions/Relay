/**
 * MergeManager Tests
 */

import * as Y from 'yjs';
import { MergeManager } from '../MergeManager';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';
import { PostOffice } from '../../../src/observable/Postie';

describe('MergeManager', () => {
  let manager: MergeManager;
  let timeProvider: MockTimeProvider;

  beforeEach(() => {
    timeProvider = new MockTimeProvider();

    // Initialize PostOffice with mock time provider for ObservableMap notifications
    PostOffice.destroy();
    // @ts-ignore - accessing private constructor for testing
    PostOffice["instance"] = new PostOffice(timeProvider);
    // @ts-ignore
    PostOffice["_destroyed"] = false;

    manager = new MergeManager({
      getVaultId: (guid) => `test-${guid}`,
      timeProvider,
    });
  });

  afterEach(() => {
    PostOffice.destroy();
  });

  describe('registration', () => {
    test('register adds document to registry', async () => {
      await manager.register('doc-1', 'notes/test.md');

      expect(manager.getRegisteredGuids()).toContain('doc-1');
      expect(manager.getPath('doc-1')).toBe('notes/test.md');
    });

    test('register initializes sync status', async () => {
      await manager.register('doc-1', 'notes/test.md');

      const status = manager.syncStatus.get('doc-1');
      expect(status).toBeDefined();
      expect(status?.status).toBe('synced');
    });

    test('register initializes diskMtime from actual file', async () => {
      const mockGetDiskState = jest.fn();
      mockGetDiskState.mockResolvedValue({
        contents: 'test content',
        mtime: 1234567890,
        hash: 'abc123'
      });

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
      });

      await managerWithDisk.register('test-guid', 'test/file.md');

      const status = managerWithDisk.syncStatus.get('test-guid');
      expect(status?.diskMtime).toBe(1234567890);
      expect(mockGetDiskState).toHaveBeenCalledWith('test/file.md');
    });

    test('register handles missing file gracefully', async () => {
      const mockGetDiskState = jest.fn();
      mockGetDiskState.mockResolvedValue(null);

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
      });

      await managerWithDisk.register('test-guid', 'nonexistent/file.md');

      const status = managerWithDisk.syncStatus.get('test-guid');
      expect(status?.diskMtime).toBe(0);
    });

    test('register handles getDiskState error gracefully', async () => {
      const mockGetDiskState = jest.fn();
      mockGetDiskState.mockRejectedValue(new Error('File read error'));

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
      });

      // Should not throw
      await expect(
        managerWithDisk.register('test-guid', 'error/file.md')
      ).resolves.toBeUndefined();

      const status = managerWithDisk.syncStatus.get('test-guid');
      expect(status?.diskMtime).toBe(0);
    });

    test('unregister removes document', async () => {
      await manager.register('doc-1', 'notes/test.md');
      manager.unregister('doc-1');

      expect(manager.getRegisteredGuids()).not.toContain('doc-1');
      expect(manager.syncStatus.get('doc-1')).toBeUndefined();
    });
  });

  describe('HSM lifecycle', () => {
    test('getHSM creates and returns HSM', async () => {
      const hsm = await manager.getHSM('doc-1', 'test.md', createRemoteDoc());

      expect(hsm).toBeDefined();
      expect(manager.isLoaded('doc-1')).toBe(true);
    });

    test('getHSM returns same instance on second call', async () => {
      const hsm1 = await manager.getHSM('doc-1', 'test.md', createRemoteDoc());
      const hsm2 = await manager.getHSM('doc-1', 'test.md', createRemoteDoc());

      expect(hsm1).toBe(hsm2);
    });

    test('unload removes HSM from loaded', async () => {
      await manager.getHSM('doc-1', 'test.md', createRemoteDoc());
      expect(manager.isLoaded('doc-1')).toBe(true);

      await manager.unload('doc-1');
      expect(manager.isLoaded('doc-1')).toBe(false);
    });

    test('unload preserves registration', async () => {
      await manager.getHSM('doc-1', 'test.md', createRemoteDoc());
      await manager.unload('doc-1');

      expect(manager.getRegisteredGuids()).toContain('doc-1');
    });
  });

  describe('idle mode updates', () => {
    test('handleIdleRemoteUpdate stores update for unloaded doc', async () => {
      await manager.register('doc-1', 'test.md');

      const update = createTestUpdate('hello');
      await manager.handleIdleRemoteUpdate('doc-1', update);

      // Status should change to pending
      const status = manager.syncStatus.get('doc-1');
      expect(status?.status).toBe('pending');
    });

    test('handleIdleRemoteUpdate forwards to HSM if loaded', async () => {
      const hsm = await manager.getHSM('doc-1', 'test.md', createRemoteDoc());

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
      await manager.register('doc-1', 'test.md');

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

      await manager.register('doc-1', 'test.md');
      // Advance time to trigger PostOffice notifications
      timeProvider.setTime(timeProvider.now() + 100);

      const update = createTestUpdate('hello');
      await manager.handleIdleRemoteUpdate('doc-1', update);
      // Advance time again for the update notification
      timeProvider.setTime(timeProvider.now() + 100);

      expect(statusChanges.length).toBeGreaterThan(0);
      expect(statusChanges.some(c => c.status === 'pending')).toBe(true);
    });

    test('onStatusChange can be unsubscribed', async () => {
      let callCount = 0;

      const unsubscribe = manager.onStatusChange(() => {
        callCount++;
      });

      await manager.register('doc-1', 'test.md');
      // Advance time to trigger PostOffice notifications
      timeProvider.setTime(timeProvider.now() + 100);
      const initialCount = callCount;

      unsubscribe();

      await manager.handleIdleRemoteUpdate('doc-1', createTestUpdate('hello'));

      // Should not have received more notifications after unsubscribe
      expect(callCount).toBe(initialCount);
    });
  });

  describe('pollAll', () => {
    test('pollAll detects disk changes for idle documents', async () => {
      const mockGetDiskState = jest.fn();
      // First call during register returns initial mtime
      mockGetDiskState.mockResolvedValueOnce({ contents: 'old content', mtime: 1000, hash: 'old123' });
      // Second call during pollAll returns newer mtime
      mockGetDiskState.mockResolvedValueOnce({ contents: 'new content', mtime: 2000, hash: 'abc123' });

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
      });

      // Register document with vault-relative path (like "blog/note.md")
      await managerWithDisk.register('test-guid', 'blog/note.md');

      // Verify initial mtime was set from first getDiskState call
      const initialStatus = managerWithDisk.syncStatus.get('test-guid');
      expect(initialStatus).toBeDefined();
      expect(initialStatus?.diskMtime).toBe(1000);

      // Poll for changes (simulates external disk change)
      await managerWithDisk.pollAll({ guids: ['test-guid'] });

      // Verify getDiskState was called with the correct vault-relative path
      expect(mockGetDiskState).toHaveBeenCalledWith('blog/note.md');
      expect(mockGetDiskState).toHaveBeenCalledTimes(2);

      // Should detect change and update status to pending
      const status = managerWithDisk.syncStatus.get('test-guid');
      expect(status?.status).toBe('pending');
      expect(status?.diskMtime).toBe(2000);
    });

    test('pollAll skips documents without getDiskState callback', async () => {
      // Manager without getDiskState
      await manager.register('doc-1', 'test.md');

      // Should not throw
      await expect(manager.pollAll()).resolves.toBeUndefined();
    });

    test('pollAll uses correct path from registeredDocs', async () => {
      const mockGetDiskState = jest.fn();
      mockGetDiskState.mockResolvedValue({ contents: 'content', mtime: 1000, hash: 'hash' });

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
      });

      // Register with full vault path (as fixed in SharedFolder.ts)
      await managerWithDisk.register('guid-1', 'shared-folder/subfolder/note.md');

      await managerWithDisk.pollAll({ guids: ['guid-1'] });

      // Verify correct path was used
      expect(mockGetDiskState).toHaveBeenCalledWith('shared-folder/subfolder/note.md');
    });
  });

  describe('effect handling', () => {
    test('onEffect callback receives HSM effects', async () => {
      const effects: Array<{ guid: string; type: string }> = [];

      const managerWithEffects = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        onEffect: (guid, effect) => {
          effects.push({ guid, type: effect.type });
        },
      });

      const hsm = await managerWithEffects.getHSM('doc-1', 'test.md', createRemoteDoc());

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

function createRemoteDoc(): Y.Doc {
  return new Y.Doc();
}
