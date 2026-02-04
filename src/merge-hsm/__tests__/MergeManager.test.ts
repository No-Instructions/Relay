/**
 * MergeManager Tests
 *
 * Tests the MergeManager lifecycle with persistent HSM instances:
 * - register(): Creates HSM in idle mode
 * - getHSM(): Acquires lock, transitions to active mode
 * - unload(): Releases lock, keeps HSM alive
 * - unregister(): Destroys HSM completely
 */

import * as Y from 'yjs';
import { MergeManager } from '../MergeManager';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';
import { PostOffice } from '../../../src/observable/Postie';

// Default LCA state for tests (needed because idle mode requires LCA)
const createDefaultLCA = () => ({
  contents: '',
  hash: 'empty-hash',
  mtime: 1000,
  stateVector: new Uint8Array([0]),
});

const defaultLoadState = async (guid: string) => ({
  guid,
  path: 'test.md',
  lca: createDefaultLCA(),
  disk: null,
  localStateVector: null,
  lastStatePath: 'idle.synced' as const,
  persistedAt: Date.now(),
});

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
      loadState: defaultLoadState,
    });
  });

  afterEach(() => {
    PostOffice.destroy();
  });

  describe('registration', () => {
    test('register creates HSM in idle state', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'notes/test.md', remoteDoc);

      expect(manager.isRegistered('doc-1')).toBe(true);
      expect(manager.getRegisteredGuids()).toContain('doc-1');
      expect(manager.getPath('doc-1')).toBe('notes/test.md');

      const hsm = manager.getIdleHSM('doc-1');
      expect(hsm).toBeDefined();
      expect(hsm?.state.statePath).toBe('idle.synced');
    });

    test('register initializes sync status from HSM', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'notes/test.md', remoteDoc);

      const status = manager.syncStatus.get('doc-1');
      expect(status).toBeDefined();
      expect(status?.status).toBe('synced');
    });

    test('register is idempotent', async () => {
      const remoteDoc1 = createRemoteDoc();
      const remoteDoc2 = createRemoteDoc();

      await manager.register('doc-1', 'notes/test.md', remoteDoc1);
      const hsm1 = manager.getIdleHSM('doc-1');

      await manager.register('doc-1', 'notes/test.md', remoteDoc2);
      const hsm2 = manager.getIdleHSM('doc-1');

      // Same HSM instance should be returned
      expect(hsm1).toBe(hsm2);
    });

    test('unregister destroys HSM', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'notes/test.md', remoteDoc);

      await manager.unregister('doc-1');

      expect(manager.isRegistered('doc-1')).toBe(false);
      expect(manager.getIdleHSM('doc-1')).toBeUndefined();
      expect(manager.syncStatus.get('doc-1')).toBeUndefined();
    });

    test('unregister handles active documents', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'notes/test.md', remoteDoc);
      await manager.getHSM('doc-1', 'notes/test.md', remoteDoc);

      expect(manager.isLoaded('doc-1')).toBe(true);

      await manager.unregister('doc-1');

      expect(manager.isRegistered('doc-1')).toBe(false);
      expect(manager.isLoaded('doc-1')).toBe(false);
    });
  });

  describe('HSM lifecycle', () => {
    test('getHSM returns existing HSM with lock acquired', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      const hsm = await manager.getHSM('doc-1', 'test.md', remoteDoc);

      expect(hsm.state.statePath).toBe('active.tracking');
      expect(manager.isLoaded('doc-1')).toBe(true);
    });

    test('getHSM registers if not already registered', async () => {
      const remoteDoc = createRemoteDoc();
      const hsm = await manager.getHSM('doc-1', 'test.md', remoteDoc);

      expect(manager.isRegistered('doc-1')).toBe(true);
      expect(hsm.state.statePath).toBe('active.tracking');
    });

    test('getHSM returns same instance on second call', async () => {
      const remoteDoc = createRemoteDoc();
      const hsm1 = await manager.getHSM('doc-1', 'test.md', remoteDoc);
      const hsm2 = await manager.getHSM('doc-1', 'test.md', remoteDoc);

      expect(hsm1).toBe(hsm2);
    });

    test('unload releases lock but keeps HSM', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);
      await manager.getHSM('doc-1', 'test.md', remoteDoc);

      expect(manager.isLoaded('doc-1')).toBe(true);

      await manager.unload('doc-1');

      expect(manager.isLoaded('doc-1')).toBe(false);
      expect(manager.isRegistered('doc-1')).toBe(true);

      const hsm = manager.getIdleHSM('doc-1');
      expect(hsm?.state.statePath).toBe('idle.synced');
    });

    test('HSM survives multiple lock cycles', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      // First open/close cycle
      const hsm1 = await manager.getHSM('doc-1', 'test.md', remoteDoc);
      expect(hsm1.isActive()).toBe(true);
      await manager.unload('doc-1');
      expect(hsm1.isIdle()).toBe(true);

      // Second open/close cycle - should get same HSM
      const hsm2 = await manager.getHSM('doc-1', 'test.md', remoteDoc);
      expect(hsm2.isActive()).toBe(true);

      expect(hsm1).toBe(hsm2);  // Same instance
    });

    test('unload on non-active doc is no-op', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      // Never called getHSM, so not active
      expect(manager.isLoaded('doc-1')).toBe(false);

      // Should not throw
      await manager.unload('doc-1');

      expect(manager.isRegistered('doc-1')).toBe(true);
      const hsm = manager.getIdleHSM('doc-1');
      expect(hsm?.state.statePath).toBe('idle.synced');
    });
  });

  describe('idle mode updates', () => {
    test('handleIdleRemoteUpdate forwards to HSM', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      const update = createTestUpdate('hello');
      await manager.handleIdleRemoteUpdate('doc-1', update);

      // HSM should have processed the update and auto-merged to clean
      const hsm = manager.getIdleHSM('doc-1');
      await hsm?.awaitIdleAutoMerge();
      expect(hsm?.state.statePath).toBe('idle.synced');
      // Verify remote state was updated (update was processed)
      expect(hsm?.state.remoteStateVector).not.toBeNull();
    });

    test('handleIdleRemoteUpdate works for active HSM too', async () => {
      const remoteDoc = createRemoteDoc();
      const hsm = await manager.getHSM('doc-1', 'test.md', remoteDoc);

      // Send YDOCS_READY to get to tracking state
      hsm.send({ type: 'YDOCS_READY' });
      expect(hsm.state.statePath).toBe('active.tracking');

      const update = createTestUpdate('hello');
      await manager.handleIdleRemoteUpdate('doc-1', update);

      // Should still be in active state (update processed)
      expect(hsm.state.statePath).toBe('active.tracking');
    });

    test('handleIdleRemoteUpdate ignores unregistered documents', async () => {
      const update = createTestUpdate('hello');

      // Should not throw
      await expect(
        manager.handleIdleRemoteUpdate('unknown-doc', update)
      ).resolves.toBeUndefined();
    });
  });

  describe('status change notifications', () => {
    test('onStatusChange notifies on status update', async () => {
      const statusChanges: Array<{ guid: string; status: string }> = [];

      manager.onStatusChange((guid, status) => {
        statusChanges.push({ guid, status: status.status });
      });

      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);
      // Advance time to trigger PostOffice notifications
      timeProvider.setTime(timeProvider.now() + 100);

      const update = createTestUpdate('hello');
      await manager.handleIdleRemoteUpdate('doc-1', update);
      // Advance time again for the update notification
      timeProvider.setTime(timeProvider.now() + 100);

      // Status changes should have been notified (transitions through pending→synced)
      expect(statusChanges.length).toBeGreaterThan(0);
    });

    test('onStatusChange can be unsubscribed', async () => {
      let callCount = 0;

      const unsubscribe = manager.onStatusChange(() => {
        callCount++;
      });

      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);
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
    test('pollAll sends DISK_CHANGED to HSMs', async () => {
      // Disk content must differ from LCA to trigger diskAhead
      const mockGetDiskState = jest.fn()
        .mockResolvedValueOnce({ contents: 'new content', mtime: 2000, hash: 'new-hash-different-from-lca' });

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
        loadState: defaultLoadState,
      });

      const remoteDoc = createRemoteDoc();
      await managerWithDisk.register('doc-1', 'test.md', remoteDoc);
      const hsm = managerWithDisk.getIdleHSM('doc-1');

      await managerWithDisk.pollAll();

      // HSM should have received DISK_CHANGED and updated disk state
      expect(hsm?.state.disk?.hash).toBe('new-hash-different-from-lca');
      expect(mockGetDiskState).toHaveBeenCalledWith('test.md');
    });

    test('pollAll works for specific guids', async () => {
      const mockGetDiskState = jest.fn()
        .mockResolvedValue({ contents: 'content', mtime: 1000, hash: 'hash' });

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
        loadState: defaultLoadState,
      });

      const remoteDoc1 = createRemoteDoc();
      const remoteDoc2 = createRemoteDoc();
      await managerWithDisk.register('doc-1', 'test1.md', remoteDoc1);
      await managerWithDisk.register('doc-2', 'test2.md', remoteDoc2);

      await managerWithDisk.pollAll({ guids: ['doc-1'] });

      // Should only poll doc-1
      expect(mockGetDiskState).toHaveBeenCalledTimes(1);
      expect(mockGetDiskState).toHaveBeenCalledWith('test1.md');
    });

    test('pollAll skips documents without getDiskState callback', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      // Should not throw
      await expect(manager.pollAll()).resolves.toBeUndefined();
    });

    test('pollAll uses correct path from HSM state', async () => {
      const mockGetDiskState = jest.fn()
        .mockResolvedValue({ contents: 'content', mtime: 1000, hash: 'hash' });

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
        loadState: defaultLoadState,
      });

      const remoteDoc = createRemoteDoc();
      await managerWithDisk.register('guid-1', 'shared-folder/subfolder/note.md', remoteDoc);

      await managerWithDisk.pollAll({ guids: ['guid-1'] });

      // Verify correct path was used
      expect(mockGetDiskState).toHaveBeenCalledWith('shared-folder/subfolder/note.md');
    });

    test('pollAll does NOT send DISK_CHANGED when disk state unchanged (BUG-007)', async () => {
      const mockGetDiskState = jest.fn()
        .mockResolvedValue({ contents: 'same content', mtime: 1000, hash: 'same-hash' });

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
        loadState: defaultLoadState,
      });

      const remoteDoc = createRemoteDoc();
      await managerWithDisk.register('doc-1', 'test.md', remoteDoc);
      const hsm = managerWithDisk.getIdleHSM('doc-1');

      // First poll - should send DISK_CHANGED since HSM has no disk state yet
      await managerWithDisk.pollAll();
      expect(hsm?.state.disk).toEqual({ mtime: 1000, hash: 'same-hash' });

      // Track state before second poll
      const stateBefore = hsm?.state.statePath;

      // Second poll with same mtime/hash - should NOT send another DISK_CHANGED
      mockGetDiskState.mockClear();
      await managerWithDisk.pollAll();

      // getDiskState was called but DISK_CHANGED should not have been sent
      // HSM state should remain unchanged since disk hasn't changed
      expect(mockGetDiskState).toHaveBeenCalledTimes(1);
      expect(hsm?.state.statePath).toBe(stateBefore);
      expect(hsm?.state.disk).toEqual({ mtime: 1000, hash: 'same-hash' });
    });

    test('pollAll sends DISK_CHANGED when mtime changes', async () => {
      const mockGetDiskState = jest.fn();

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
        loadState: defaultLoadState,
      });

      const remoteDoc = createRemoteDoc();
      await managerWithDisk.register('doc-1', 'test.md', remoteDoc);
      const hsm = managerWithDisk.getIdleHSM('doc-1');

      // First poll
      mockGetDiskState.mockResolvedValueOnce({ contents: 'content', mtime: 1000, hash: 'hash1' });
      await managerWithDisk.pollAll();
      expect(hsm?.state.disk?.mtime).toBe(1000);

      // Second poll with new mtime - should send DISK_CHANGED
      mockGetDiskState.mockResolvedValueOnce({ contents: 'content', mtime: 2000, hash: 'hash1' });
      await managerWithDisk.pollAll();
      expect(hsm?.state.disk?.mtime).toBe(2000);
    });

    test('pollAll sends DISK_CHANGED when hash changes', async () => {
      const mockGetDiskState = jest.fn();

      const managerWithDisk = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        getDiskState: mockGetDiskState,
        loadState: defaultLoadState,
      });

      const remoteDoc = createRemoteDoc();
      await managerWithDisk.register('doc-1', 'test.md', remoteDoc);
      const hsm = managerWithDisk.getIdleHSM('doc-1');

      // First poll
      mockGetDiskState.mockResolvedValueOnce({ contents: 'content', mtime: 1000, hash: 'hash1' });
      await managerWithDisk.pollAll();
      expect(hsm?.state.disk?.hash).toBe('hash1');

      // Second poll with new hash (same mtime) - should send DISK_CHANGED
      mockGetDiskState.mockResolvedValueOnce({ contents: 'new content', mtime: 1000, hash: 'hash2' });
      await managerWithDisk.pollAll();
      expect(hsm?.state.disk?.hash).toBe('hash2');
    });
  });

  describe('effect handling', () => {
    test('onEffect callback receives HSM effects', async () => {
      const effects: Array<{ guid: string; type: string }> = [];

      const managerWithEffects = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
        onEffect: (guid, effect) => {
          effects.push({ guid, type: effect.type });
        },
      });

      const remoteDoc = createRemoteDoc();
      await managerWithEffects.register('doc-1', 'test.md', remoteDoc);

      // Should have received STATUS_CHANGED effects during registration
      expect(effects.some(e => e.type === 'STATUS_CHANGED')).toBe(true);
    });
  });

  describe('idle ↔ active transitions', () => {
    test('state preserved across lock cycles', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      // Receive remote update in idle - auto-merges since disk==LCA
      const update = createTestUpdate('hello world');
      await manager.handleIdleRemoteUpdate('doc-1', update);

      // Wait for idle auto-merge to complete
      let hsm = manager.getIdleHSM('doc-1');
      await hsm?.awaitIdleAutoMerge();

      // Auto-merge completes, should be idle.synced
      expect(hsm?.state.statePath).toBe('idle.synced');

      hsm = await manager.getHSM('doc-1', 'test.md', remoteDoc);
      expect(hsm.state.statePath).toBe('active.tracking');

      await manager.unload('doc-1');

      hsm = manager.getIdleHSM('doc-1');
      expect(hsm?.state.statePath).toBe('idle.synced');
    });

    test('getIdleHSM returns HSM without acquiring lock', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      const hsm = manager.getIdleHSM('doc-1');

      expect(hsm).toBeDefined();
      expect(hsm?.isIdle()).toBe(true);
      expect(manager.isLoaded('doc-1')).toBe(false);  // No lock acquired
    });
  });

  describe('persistence callbacks', () => {
    test('loadState is called during registration', async () => {
      const mockLoadState = jest.fn().mockResolvedValue({
        guid: 'doc-1',
        path: 'test.md',
        lca: {
          contents: 'persisted content',
          hash: 'hash123',
          mtime: 1000,
          stateVector: new Uint8Array([0]),
        },
        disk: null,
        localStateVector: null,
        lastStatePath: 'idle.synced',
        persistedAt: Date.now(),
      });

      const managerWithPersistence = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: mockLoadState,
      });

      const remoteDoc = createRemoteDoc();
      await managerWithPersistence.register('doc-1', 'test.md', remoteDoc);

      expect(mockLoadState).toHaveBeenCalledWith('doc-1');

      const hsm = managerWithPersistence.getIdleHSM('doc-1');
      expect(hsm?.state.lca?.contents).toBe('persisted content');
    });

    test('persistence is handled internally by IndexeddbPersistence (no loadUpdates)', async () => {
      // loadUpdates callback has been removed. IndexeddbPersistence
      // attached to localDoc loads updates internally.
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      // HSM should be registered and in idle state
      expect(manager.isRegistered('doc-1')).toBe(true);
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createTestUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, content);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function createRemoteDoc(): Y.Doc {
  return new Y.Doc();
}
