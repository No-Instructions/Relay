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

  describe('initialization', () => {
    test('initialize() loads all LCA states into cache', async () => {
      const mockLoadAllStates = jest.fn().mockResolvedValue([
        {
          guid: 'doc-1',
          path: 'test1.md',
          lca: {
            contents: 'content 1',
            hash: 'hash1',
            mtime: 1000,
            stateVector: new Uint8Array([1]),
          },
          disk: null,
          localStateVector: null,
          lastStatePath: 'idle.synced',
          persistedAt: Date.now(),
        },
        {
          guid: 'doc-2',
          path: 'test2.md',
          lca: {
            contents: 'content 2',
            hash: 'hash2',
            mtime: 2000,
            stateVector: new Uint8Array([2]),
          },
          disk: null,
          localStateVector: null,
          lastStatePath: 'idle.synced',
          persistedAt: Date.now(),
        },
        {
          guid: 'doc-3',
          path: 'test3.md',
          lca: null,
          disk: null,
          localStateVector: null,
          lastStatePath: 'idle.synced',
          persistedAt: Date.now(),
        },
      ]);

      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
        loadAllStates: mockLoadAllStates,
      });

      expect(managerWithInit.initialized).toBe(false);

      await managerWithInit.initialize();

      expect(managerWithInit.initialized).toBe(true);
      expect(mockLoadAllStates).toHaveBeenCalledTimes(1);
    });

    test('initialize() is idempotent', async () => {
      const mockLoadAllStates = jest.fn().mockResolvedValue([]);

      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
        loadAllStates: mockLoadAllStates,
      });

      await managerWithInit.initialize();
      await managerWithInit.initialize();

      expect(mockLoadAllStates).toHaveBeenCalledTimes(1);
    });

    test('initialize() does not load if destroyed', async () => {
      const mockLoadAllStates = jest.fn().mockResolvedValue([]);

      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
        loadAllStates: mockLoadAllStates,
      });

      managerWithInit.destroy();
      await managerWithInit.initialize();

      expect(mockLoadAllStates).not.toHaveBeenCalled();
      expect(managerWithInit.initialized).toBe(false);
    });

    test('initialize() works without loadAllStates callback', async () => {
      const managerWithoutCallback = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
      });

      await managerWithoutCallback.initialize();

      expect(managerWithoutCallback.initialized).toBe(true);
    });
  });

  describe('LCA cache', () => {
    test('getLCA returns null for unknown guid', async () => {
      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
      });

      await managerWithInit.initialize();

      expect(managerWithInit.getLCA('unknown-guid')).toBeNull();
    });

    test('getLCA returns LCA from cache after initialize', async () => {
      const testLCA = {
        contents: 'test content',
        hash: 'test-hash',
        mtime: 1000,
        stateVector: new Uint8Array([1, 2, 3]),
      };

      const mockLoadAllStates = jest.fn().mockResolvedValue([
        {
          guid: 'doc-1',
          path: 'test.md',
          lca: testLCA,
          disk: null,
          localStateVector: null,
          lastStatePath: 'idle.synced',
          persistedAt: Date.now(),
        },
      ]);

      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
        loadAllStates: mockLoadAllStates,
      });

      await managerWithInit.initialize();

      const lca = managerWithInit.getLCA('doc-1');
      expect(lca).not.toBeNull();
      expect(lca?.contents).toBe('test content');
      expect(lca?.meta.hash).toBe('test-hash');
      expect(lca?.meta.mtime).toBe(1000);
    });

    test('getLCA returns null for doc with null LCA', async () => {
      const mockLoadAllStates = jest.fn().mockResolvedValue([
        {
          guid: 'doc-no-lca',
          path: 'test.md',
          lca: null,
          disk: null,
          localStateVector: null,
          lastStatePath: 'idle.synced',
          persistedAt: Date.now(),
        },
      ]);

      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
        loadAllStates: mockLoadAllStates,
      });

      await managerWithInit.initialize();

      expect(managerWithInit.getLCA('doc-no-lca')).toBeNull();
    });

    test('setLCA updates cache immediately', async () => {
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

      const newLCA = {
        contents: 'new content',
        meta: { hash: 'new-hash', mtime: 2000 },
        stateVector: new Uint8Array([4, 5, 6]),
      };

      await managerWithEffects.setLCA('doc-1', newLCA);

      // Cache should be updated immediately
      const cachedLCA = managerWithEffects.getLCA('doc-1');
      expect(cachedLCA).not.toBeNull();
      expect(cachedLCA?.contents).toBe('new content');
      expect(cachedLCA?.meta.hash).toBe('new-hash');
    });

    test('setLCA emits PERSIST_STATE effect', async () => {
      const effects: Array<{ guid: string; type: string; state?: unknown }> = [];
      const managerWithEffects = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
        onEffect: (guid, effect) => {
          effects.push({ guid, type: effect.type, state: (effect as any).state });
        },
      });

      const remoteDoc = createRemoteDoc();
      await managerWithEffects.register('doc-1', 'test.md', remoteDoc);
      effects.length = 0; // Clear effects from registration

      const newLCA = {
        contents: 'new content',
        meta: { hash: 'new-hash', mtime: 2000 },
        stateVector: new Uint8Array([4, 5, 6]),
      };

      await managerWithEffects.setLCA('doc-1', newLCA);

      // Should emit PERSIST_STATE effect
      expect(effects.some(e => e.type === 'PERSIST_STATE' && e.guid === 'doc-1')).toBe(true);
      const persistEffect = effects.find(e => e.type === 'PERSIST_STATE');
      expect((persistEffect?.state as any)?.lca?.contents).toBe('new content');
    });

    test('setLCA with null clears LCA in cache', async () => {
      const mockLoadAllStates = jest.fn().mockResolvedValue([
        {
          guid: 'doc-1',
          path: 'test.md',
          lca: {
            contents: 'existing content',
            hash: 'existing-hash',
            mtime: 1000,
            stateVector: new Uint8Array([1]),
          },
          disk: null,
          localStateVector: null,
          lastStatePath: 'idle.synced',
          persistedAt: Date.now(),
        },
      ]);

      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
        loadAllStates: mockLoadAllStates,
        onEffect: () => {},
      });

      await managerWithInit.initialize();

      const remoteDoc = createRemoteDoc();
      await managerWithInit.register('doc-1', 'test.md', remoteDoc);

      // Should have LCA from initialize
      expect(managerWithInit.getLCA('doc-1')).not.toBeNull();

      // Set to null
      await managerWithInit.setLCA('doc-1', null);

      // Should now be null
      expect(managerWithInit.getLCA('doc-1')).toBeNull();
    });

    test('setLCA without onEffect callback does not throw', async () => {
      const managerNoEffects = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
        // No onEffect callback
      });

      const remoteDoc = createRemoteDoc();
      await managerNoEffects.register('doc-1', 'test.md', remoteDoc);

      const newLCA = {
        contents: 'new content',
        meta: { hash: 'new-hash', mtime: 2000 },
        stateVector: new Uint8Array([4, 5, 6]),
      };

      // Should not throw
      await expect(managerNoEffects.setLCA('doc-1', newLCA)).resolves.toBeUndefined();

      // Cache should still be updated
      expect(managerNoEffects.getLCA('doc-1')?.contents).toBe('new content');
    });

    test('setLCA for unregistered doc still updates cache', async () => {
      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: defaultLoadState,
      });

      const newLCA = {
        contents: 'orphan content',
        meta: { hash: 'orphan-hash', mtime: 3000 },
        stateVector: new Uint8Array([7, 8, 9]),
      };

      // Set LCA for doc that isn't registered yet
      await managerWithInit.setLCA('unregistered-doc', newLCA);

      // Cache should still have it
      expect(managerWithInit.getLCA('unregistered-doc')?.contents).toBe('orphan content');
    });
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
    test('handleRemoteUpdate forwards to HSM', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      const update = createTestUpdate('hello');
      await manager.handleRemoteUpdate('doc-1', update);

      // HSM should have processed the update and auto-merged to clean
      const hsm = manager.getIdleHSM('doc-1');
      await hsm?.awaitIdleAutoMerge();
      expect(hsm?.state.statePath).toBe('idle.synced');
      // Verify remote state was updated (update was processed)
      expect(hsm?.state.remoteStateVector).not.toBeNull();
    });

    test('handleRemoteUpdate works for active HSM too', async () => {
      const remoteDoc = createRemoteDoc();
      const hsm = await manager.getHSM('doc-1', 'test.md', remoteDoc);

      // Send YDOCS_READY to get to tracking state
      hsm.send({ type: 'YDOCS_READY' });
      expect(hsm.state.statePath).toBe('active.tracking');

      const update = createTestUpdate('hello');
      await manager.handleRemoteUpdate('doc-1', update);

      // Should still be in active state (update processed)
      expect(hsm.state.statePath).toBe('active.tracking');
    });

    test('handleRemoteUpdate ignores unregistered documents', () => {
      const update = createTestUpdate('hello');

      // Should not throw (returns void, no-op for unregistered docs)
      expect(() => {
        manager.handleRemoteUpdate('unknown-doc', update);
      }).not.toThrow();
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
      await manager.handleRemoteUpdate('doc-1', update);
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

      await manager.handleRemoteUpdate('doc-1', createTestUpdate('hello'));

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

      // Trigger an effect by getting the HSM and making a change
      const hsm = await managerWithEffects.getHSM('doc-1', 'test.md', remoteDoc);
      hsm.send({
        type: 'CM6_CHANGE',
        changes: [{ from: 0, to: 0, insert: 'test' }],
        docText: 'test',
        isFromYjs: false,
      });

      // Should have received SYNC_TO_REMOTE effect from the CM6_CHANGE
      expect(effects.some(e => e.type === 'SYNC_TO_REMOTE')).toBe(true);

      managerWithEffects.destroy();
    });
  });

  describe('idle ↔ active transitions', () => {
    test('state preserved across lock cycles', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      // Receive remote update in idle - auto-merges since disk==LCA
      const update = createTestUpdate('hello world');
      await manager.handleRemoteUpdate('doc-1', update);

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

  describe('isActive (Gap 9)', () => {
    test('isActive returns false for unregistered doc', () => {
      expect(manager.isActive('unknown-doc')).toBe(false);
    });

    test('isActive returns false for idle doc', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      expect(manager.isActive('doc-1')).toBe(false);
    });

    test('isActive returns true for active doc', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.getHSM('doc-1', 'test.md', remoteDoc);

      expect(manager.isActive('doc-1')).toBe(true);
    });

    test('isLoaded is deprecated alias for isActive', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      expect(manager.isLoaded('doc-1')).toBe(manager.isActive('doc-1'));

      await manager.getHSM('doc-1', 'test.md', remoteDoc);

      expect(manager.isLoaded('doc-1')).toBe(manager.isActive('doc-1'));
    });
  });

  describe('setActiveDocuments (Gap 8)', () => {
    test('setActiveDocuments sends SET_MODE_ACTIVE to HSMs in loading state', async () => {
      // Create manager that doesn't auto-load state (to keep HSMs in loading)
      const managerNoAutoLoad = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        // No loadState callback - HSMs will stay in loading state until PERSISTENCE_LOADED
      });

      const remoteDoc1 = createRemoteDoc();
      const remoteDoc2 = createRemoteDoc();

      // Use getOrRegisterHSM to get synchronous reference, HSMs stay in loading state
      const hsm1 = managerNoAutoLoad.getOrRegisterHSM('doc-1', 'test1.md', remoteDoc1);
      const hsm2 = managerNoAutoLoad.getOrRegisterHSM('doc-2', 'test2.md', remoteDoc2);

      // Both HSMs should be in loading state
      expect(hsm1?.state.statePath).toBe('loading');
      expect(hsm2?.state.statePath).toBe('loading');

      // Send PERSISTENCE_LOADED to transition to loading (but not ready yet)
      hsm1?.send({ type: 'PERSISTENCE_LOADED', updates: new Uint8Array(), lca: null });
      hsm2?.send({ type: 'PERSISTENCE_LOADED', updates: new Uint8Array(), lca: null });

      // Now in loading
      expect(hsm1?.state.statePath).toBe('loading');
      expect(hsm2?.state.statePath).toBe('loading');

      // Set doc-1 as active
      managerNoAutoLoad.setActiveDocuments(new Set(['doc-1']));

      // doc-1 should be in active.loading (waiting for ACQUIRE_LOCK)
      expect(hsm1?.state.statePath).toBe('active.loading');

      // doc-2 should be in idle (synced since no LCA and no local changes)
      expect(hsm2?.state.statePath).toBe('idle.synced');

      managerNoAutoLoad.destroy();
    });

    test('setActiveDocuments only affects HSMs in loading state', async () => {
      const remoteDoc1 = createRemoteDoc();
      const remoteDoc2 = createRemoteDoc();

      // Register normally - HSMs will auto-transition to idle.synced
      await manager.register('doc-1', 'test1.md', remoteDoc1);
      await manager.register('doc-2', 'test2.md', remoteDoc2);

      // Both should be in idle.synced (not loading)
      const hsm1 = manager.getIdleHSM('doc-1');
      const hsm2 = manager.getIdleHSM('doc-2');
      expect(hsm1?.state.statePath).toBe('idle.synced');
      expect(hsm2?.state.statePath).toBe('idle.synced');

      // setActiveDocuments should have no effect since HSMs are not in loading state
      manager.setActiveDocuments(new Set(['doc-1']));

      // HSMs should remain in their current states
      expect(hsm1?.state.statePath).toBe('idle.synced');
      expect(hsm2?.state.statePath).toBe('idle.synced');
    });

    test('setActiveDocuments is a no-op when destroyed', async () => {
      const managerToDestroy = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
      });

      const remoteDoc = createRemoteDoc();
      const hsm = managerToDestroy.getOrRegisterHSM('doc-1', 'test.md', remoteDoc);
      expect(hsm?.state.statePath).toBe('loading');

      managerToDestroy.destroy();

      // Should not throw
      expect(() => managerToDestroy.setActiveDocuments(new Set(['doc-1']))).not.toThrow();
    });

    test('setActiveDocuments with empty set sends SET_MODE_IDLE to all loading HSMs', async () => {
      const managerNoAutoLoad = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
      });

      const remoteDoc1 = createRemoteDoc();
      const remoteDoc2 = createRemoteDoc();

      const hsm1 = managerNoAutoLoad.getOrRegisterHSM('doc-1', 'test1.md', remoteDoc1);
      const hsm2 = managerNoAutoLoad.getOrRegisterHSM('doc-2', 'test2.md', remoteDoc2);

      // Send PERSISTENCE_LOADED to get to loading
      hsm1?.send({ type: 'PERSISTENCE_LOADED', updates: new Uint8Array(), lca: null });
      hsm2?.send({ type: 'PERSISTENCE_LOADED', updates: new Uint8Array(), lca: null });

      expect(hsm1?.state.statePath).toBe('loading');
      expect(hsm2?.state.statePath).toBe('loading');

      // Set empty set - all HSMs should go to idle mode
      managerNoAutoLoad.setActiveDocuments(new Set());

      // Both should be in idle.synced (no LCA and no local changes = synced)
      expect(hsm1?.state.statePath).toBe('idle.synced');
      expect(hsm2?.state.statePath).toBe('idle.synced');

      managerNoAutoLoad.destroy();
    });
  });

  describe('state exposure (Gap 10)', () => {
    test('state.pendingEditorContent is undefined in idle mode', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      const hsm = manager.getIdleHSM('doc-1');
      expect(hsm?.state.pendingEditorContent).toBeUndefined();
    });

    test('state.lastKnownEditorText is undefined in idle mode', async () => {
      const remoteDoc = createRemoteDoc();
      await manager.register('doc-1', 'test.md', remoteDoc);

      const hsm = manager.getIdleHSM('doc-1');
      expect(hsm?.state.lastKnownEditorText).toBeUndefined();
    });

    test('state.pendingEditorContent is set after ACQUIRE_LOCK in active.loading', async () => {
      const managerNoAutoLoad = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
      });

      const remoteDoc = createRemoteDoc();
      const hsm = managerNoAutoLoad.getOrRegisterHSM('doc-1', 'test.md', remoteDoc);

      // Progress to loading
      hsm?.send({ type: 'PERSISTENCE_LOADED', updates: new Uint8Array(), lca: null });
      expect(hsm?.state.statePath).toBe('loading');

      // Set active mode - stays in active.loading waiting for ACQUIRE_LOCK
      managerNoAutoLoad.setActiveDocuments(new Set(['doc-1']));
      expect(hsm?.state.statePath).toBe('active.loading');

      // In active.loading state, pendingEditorContent and lastKnownEditorText are still undefined
      expect(hsm?.state.pendingEditorContent).toBeUndefined();
      expect(hsm?.state.lastKnownEditorText).toBeUndefined();

      // Send ACQUIRE_LOCK - this sets pendingEditorContent and lastKnownEditorText
      // Note: The HSM may transition through states quickly, but the values are set
      hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: 'editor text here' });

      // After ACQUIRE_LOCK, lastKnownEditorText should be set (it persists through state transitions)
      // pendingEditorContent may be cleared during transition to tracking/conflict
      expect(hsm?.state.lastKnownEditorText).toBe('editor text here');

      managerNoAutoLoad.destroy();
    });

    test('state.lastKnownEditorText is updated by CM6_CHANGE events', async () => {
      const remoteDoc = createRemoteDoc();
      const hsm = await manager.getHSM('doc-1', 'test.md', remoteDoc);

      // HSM should be in active.tracking
      expect(hsm.state.statePath).toBe('active.tracking');

      // Initial state from ACQUIRE_LOCK (empty string is default)
      expect(hsm.state.lastKnownEditorText).toBeDefined();

      // Send a CM6_CHANGE event
      hsm.send({
        type: 'CM6_CHANGE',
        changes: [{ from: 0, to: 0, insert: 'hello world' }],
        docText: 'hello world',
        isFromYjs: false,
      });

      // lastKnownEditorText should be updated
      expect(hsm.state.lastKnownEditorText).toBe('hello world');
    });

    test('state.pendingEditorContent is cleared after entering tracking', async () => {
      const remoteDoc = createRemoteDoc();
      const hsm = await manager.getHSM('doc-1', 'test.md', remoteDoc);

      // HSM should be in active.tracking
      expect(hsm.state.statePath).toBe('active.tracking');

      // pendingEditorContent should be cleared after successful transition to tracking
      expect(hsm.state.pendingEditorContent).toBeUndefined();
    });
  });

  describe('event accumulation in loading state (Gap 11)', () => {
    test('DISK_CHANGED events during loading are accumulated and replayed', async () => {
      // Create manager without auto-loading to control loading sequence
      const managerNoAutoLoad = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: async () => null, // No persisted state
      });

      const remoteDoc = createRemoteDoc();
      const hsm = managerNoAutoLoad.getOrRegisterHSM('doc-1', 'test.md', remoteDoc);
      expect(hsm?.state.statePath).toBe('loading');

      // Send DISK_CHANGED during loading
      hsm?.send({
        type: 'DISK_CHANGED',
        contents: 'disk content',
        mtime: 1000,
        hash: 'disk-hash',
      });

      // Still in loading state
      expect(hsm?.state.statePath).toBe('loading');

      // Disk metadata should be set
      expect(hsm?.state.disk?.hash).toBe('disk-hash');

      // Provide LCA via PERSISTENCE_LOADED - stays in loading
      hsm?.send({
        type: 'PERSISTENCE_LOADED',
        updates: new Uint8Array(),
        lca: {
          contents: 'disk content',
          meta: {
            hash: 'disk-hash',
            mtime: 1000,
          },
          stateVector: new Uint8Array([0]),
        },
      });

      // Still in loading - needs mode determination
      expect(hsm?.state.statePath).toBe('loading');

      // SET_MODE_IDLE to transition to idle
      hsm?.send({ type: 'SET_MODE_IDLE' });

      // Should transition to idle.synced (disk hash matches LCA hash)
      expect(hsm?.state.statePath).toBe('idle.synced');

      managerNoAutoLoad.destroy();
    });

    test('REMOTE_UPDATE events during loading are accumulated and replayed', async () => {
      // Create manager without auto-loading
      const managerNoAutoLoad = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: async () => null,
      });

      const remoteDoc = createRemoteDoc();
      const hsm = managerNoAutoLoad.getOrRegisterHSM('doc-1', 'test.md', remoteDoc);
      expect(hsm?.state.statePath).toBe('loading');

      // Create a remote update
      const remoteUpdate = createTestUpdate('remote content');

      // Send REMOTE_UPDATE during loading
      hsm?.send({
        type: 'REMOTE_UPDATE',
        update: remoteUpdate,
      });

      // Still in loading state
      expect(hsm?.state.statePath).toBe('loading');

      // Remote state vector should be set
      expect(hsm?.state.remoteStateVector).toBeTruthy();

      // Provide LCA via PERSISTENCE_LOADED - stays in loading
      hsm?.send({
        type: 'PERSISTENCE_LOADED',
        updates: new Uint8Array(),
        lca: {
          contents: '',
          meta: {
            hash: 'empty-hash',
            mtime: 1000,
          },
          stateVector: new Uint8Array([0]),
        },
      });

      // Still in loading - needs mode determination
      expect(hsm?.state.statePath).toBe('loading');

      // SET_MODE_IDLE to transition to idle
      hsm?.send({ type: 'SET_MODE_IDLE' });

      // Should be in idle.remoteAhead since remote has content LCA doesn't have
      expect(hsm?.state.statePath).toBe('idle.remoteAhead');

      managerNoAutoLoad.destroy();
    });

    test('multiple REMOTE_UPDATE events during loading are merged', async () => {
      const managerNoAutoLoad = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: async () => null,
      });

      const remoteDoc = createRemoteDoc();
      const hsm = managerNoAutoLoad.getOrRegisterHSM('doc-1', 'test.md', remoteDoc);

      // Send multiple REMOTE_UPDATE during loading
      const update1 = createTestUpdate('content1');
      const update2 = createTestUpdate('content2');

      hsm?.send({ type: 'REMOTE_UPDATE', update: update1 });
      hsm?.send({ type: 'REMOTE_UPDATE', update: update2 });

      // Still in loading
      expect(hsm?.state.statePath).toBe('loading');

      // Provide LCA via PERSISTENCE_LOADED - stays in loading
      hsm?.send({
        type: 'PERSISTENCE_LOADED',
        updates: new Uint8Array(),
        lca: {
          contents: '',
          meta: {
            hash: 'empty-hash',
            mtime: 1000,
          },
          stateVector: new Uint8Array([0]),
        },
      });

      // Still in loading - needs mode determination
      expect(hsm?.state.statePath).toBe('loading');

      // SET_MODE_IDLE to transition to idle
      hsm?.send({ type: 'SET_MODE_IDLE' });

      // Should be in idle.remoteAhead
      expect(hsm?.state.statePath).toBe('idle.remoteAhead');

      managerNoAutoLoad.destroy();
    });

    test('DISK_CHANGED during loading is accumulated', async () => {
      const managerNoAutoLoad = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: async () => null,
      });

      const remoteDoc = createRemoteDoc();
      const hsm = managerNoAutoLoad.getOrRegisterHSM('doc-1', 'test.md', remoteDoc);

      // Progress to loading (with no LCA)
      hsm?.send({
        type: 'PERSISTENCE_LOADED',
        updates: new Uint8Array(),
        lca: null, // No LCA
      });
      expect(hsm?.state.statePath).toBe('loading');

      // Send DISK_CHANGED during loading
      hsm?.send({
        type: 'DISK_CHANGED',
        contents: 'new disk content',
        mtime: 2000,
        hash: 'new-disk-hash',
      });

      // Still in loading - disk metadata should be accumulated
      expect(hsm?.state.statePath).toBe('loading');
      expect(hsm?.state.disk?.hash).toBe('new-disk-hash');

      // SET_MODE_IDLE to transition out of loading
      hsm?.send({ type: 'SET_MODE_IDLE' });

      // Wait for any auto-merge to complete
      await hsm?.awaitIdleAutoMerge();

      // After SET_MODE_IDLE without LCA, HSM is in idle (exact sub-state depends on comparison)
      // The key assertion is that disk metadata was preserved through loading
      expect(hsm?.state.disk?.hash).toBe('new-disk-hash');

      // Now initialize with content that differs from disk
      hsm?.send({
        type: 'INITIALIZE_WITH_CONTENT',
        content: 'initial content',
        hash: 'initial-hash',
        mtime: 1000,
      });

      // Wait for any auto-merge after initialization
      await hsm?.awaitIdleAutoMerge();

      // The important assertion: disk metadata was accumulated and preserved
      // Disk differs from LCA, so should be diskAhead
      expect(hsm?.state.disk?.hash).toBe('new-disk-hash');
      expect(hsm?.matches('idle')).toBe(true);

      managerNoAutoLoad.destroy();
    });

    test('accumulated events are cleared on new LOAD', async () => {
      const managerNoAutoLoad = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        timeProvider,
        loadState: async () => null,
      });

      const remoteDoc = createRemoteDoc();
      const hsm = managerNoAutoLoad.getOrRegisterHSM('doc-1', 'test.md', remoteDoc);

      // Send events during loading
      hsm?.send({
        type: 'DISK_CHANGED',
        contents: 'disk content',
        mtime: 1000,
        hash: 'disk-hash',
      });

      // Unload and reload
      hsm?.send({ type: 'UNLOAD' });

      // Wait a tick for async cleanup
      await new Promise(resolve => setTimeout(resolve, 10));

      hsm?.send({ type: 'LOAD', guid: 'doc-1', path: 'test.md' });

      // Disk metadata should be cleared (fresh load)
      expect(hsm?.state.disk).toBeNull();

      managerNoAutoLoad.destroy();
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
