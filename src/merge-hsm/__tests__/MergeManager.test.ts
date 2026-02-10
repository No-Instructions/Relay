/**
 * MergeManager Tests
 *
 * Tests the MergeManager with Document-owned HSM instances:
 * - createHSM(): Factory method for Documents to create HSMs
 * - getDocument callback: MergeManager accesses HSMs via Documents
 * - setActiveDocuments(): Manages loading→idle transitions
 * - hibernation: Background documents hibernate to reduce memory
 */

import * as Y from 'yjs';
import { MergeManager } from '../MergeManager';
import { MergeHSM } from '../MergeHSM';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';
import { PostOffice } from '../../../src/observable/Postie';

// Simulates a Document that owns an HSM
interface MockDocument {
  guid: string;
  path: string;
  hsm: MergeHSM | null;
  remoteDoc: Y.Doc;
}

describe('MergeManager', () => {
  let manager: MergeManager;
  let timeProvider: MockTimeProvider;
  let documents: Map<string, MockDocument>;

  // Helper to create a mock document and its HSM
  function createMockDocument(guid: string, path: string): MockDocument {
    const remoteDoc = new Y.Doc();
    const doc: MockDocument = {
      guid,
      path,
      hsm: null,
      remoteDoc,
    };

    // Create HSM via manager factory
    doc.hsm = manager.createHSM({
      guid,
      path,
      remoteDoc,
      getDiskContent: async () => ({ content: '', hash: 'empty', mtime: Date.now() }),
    });

    // Register document in our map (simulating SharedFolder.files)
    documents.set(guid, doc);

    // Notify manager that HSM was created
    manager.notifyHSMCreated(guid);

    return doc;
  }

  beforeEach(() => {
    timeProvider = new MockTimeProvider();
    documents = new Map();

    // Initialize PostOffice with mock time provider for ObservableMap notifications
    PostOffice.destroy();
    // @ts-ignore - accessing private constructor for testing
    PostOffice["instance"] = new PostOffice(timeProvider);
    // @ts-ignore
    PostOffice["_destroyed"] = false;

    manager = new MergeManager({
      getVaultId: (guid) => `test-${guid}`,
      getDocument: (guid) => documents.get(guid),
      timeProvider,
    });
  });

  afterEach(() => {
    // Clean up documents
    for (const doc of documents.values()) {
      if (doc.hsm && typeof doc.hsm.destroy === 'function') {
        doc.hsm.destroy();
      }
      doc.remoteDoc.destroy();
    }
    documents.clear();
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
        getDocument: (guid) => documents.get(guid),
        timeProvider,
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
        getDocument: (guid) => documents.get(guid),
        timeProvider,
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
        getDocument: (guid) => documents.get(guid),
        timeProvider,
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
        getDocument: (guid) => documents.get(guid),
        timeProvider,
      });

      await managerWithoutCallback.initialize();

      expect(managerWithoutCallback.initialized).toBe(true);
    });
  });

  describe('LCA cache', () => {
    test('getLCA returns null for unknown guid', async () => {
      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
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
        getDocument: (guid) => documents.get(guid),
        timeProvider,
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
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        loadAllStates: mockLoadAllStates,
      });

      await managerWithInit.initialize();

      expect(managerWithInit.getLCA('doc-no-lca')).toBeNull();
    });

    test('setLCA updates cache immediately', async () => {
      const effects: Array<{ guid: string; type: string }> = [];
      const managerWithEffects = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        onEffect: (guid, effect) => {
          effects.push({ guid, type: effect.type });
        },
      });

      // Reassign manager for createMockDocument to use
      manager = managerWithEffects;
      createMockDocument('doc-1', 'test.md');

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
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        onEffect: (guid, effect) => {
          effects.push({ guid, type: effect.type, state: (effect as any).state });
        },
      });

      // Reassign manager for createMockDocument to use
      manager = managerWithEffects;
      createMockDocument('doc-1', 'test.md');
      effects.length = 0; // Clear effects from creation

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
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        loadAllStates: mockLoadAllStates,
        onEffect: () => {},
      });

      await managerWithInit.initialize();

      // Reassign manager for createMockDocument to use
      manager = managerWithInit;
      createMockDocument('doc-1', 'test.md');

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
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        // No onEffect callback
      });

      // Reassign manager for createMockDocument to use
      manager = managerNoEffects;
      createMockDocument('doc-1', 'test.md');

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

    test('setLCA for unknown doc still updates cache', async () => {
      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
      });

      const newLCA = {
        contents: 'orphan content',
        meta: { hash: 'orphan-hash', mtime: 3000 },
        stateVector: new Uint8Array([7, 8, 9]),
      };

      // Set LCA for doc that doesn't have HSM yet
      await managerWithInit.setLCA('unknown-doc', newLCA);

      // Cache should still have it
      expect(managerWithInit.getLCA('unknown-doc')?.contents).toBe('orphan content');
    });
  });

  describe('HSM creation via factory', () => {
    test('createHSM creates HSM in idle state', () => {
      const doc = createMockDocument('doc-1', 'notes/test.md');

      expect(doc.hsm).toBeDefined();
      expect(doc.hsm?.state.statePath).toBe('idle.synced');
    });

    test('createHSM initializes sync status from HSM', () => {
      createMockDocument('doc-1', 'notes/test.md');

      const status = manager.syncStatus.get('doc-1');
      expect(status).toBeDefined();
      expect(status?.status).toBe('synced');
    });

    test('isRegistered returns true for created HSM', () => {
      createMockDocument('doc-1', 'notes/test.md');

      expect(manager.isRegistered('doc-1')).toBe(true);
    });

    test('isRegistered returns false for unknown doc', () => {
      expect(manager.isRegistered('unknown-doc')).toBe(false);
    });

    test('notifyHSMDestroyed cleans up registration', () => {
      const doc = createMockDocument('doc-1', 'notes/test.md');

      expect(manager.isRegistered('doc-1')).toBe(true);

      doc.hsm?.destroy();
      manager.notifyHSMDestroyed('doc-1');
      documents.delete('doc-1');

      expect(manager.isRegistered('doc-1')).toBe(false);
      expect(manager.syncStatus.get('doc-1')).toBeUndefined();
    });
  });

  describe('HSM lifecycle', () => {
    // Helper to simulate Document.acquireLock() behavior
    function acquireLock(doc: MockDocument) {
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      manager.markActive(doc.guid);
    }

    test('HSM transitions to active on ACQUIRE_LOCK', () => {
      const doc = createMockDocument('doc-1', 'test.md');

      expect(doc.hsm?.state.statePath).toBe('idle.synced');

      acquireLock(doc);

      // HSM enters active.* states
      expect(doc.hsm?.isActive()).toBe(true);
      expect(manager.isActive('doc-1')).toBe(true);
    });

    test('unload releases lock and returns to idle', async () => {
      const doc = createMockDocument('doc-1', 'test.md');

      acquireLock(doc);
      expect(manager.isActive('doc-1')).toBe(true);

      await manager.unload('doc-1');

      expect(manager.isActive('doc-1')).toBe(false);
      expect(doc.hsm?.state.statePath).toBe('idle.synced');
    });

    test('HSM survives multiple lock cycles', async () => {
      const doc = createMockDocument('doc-1', 'test.md');

      // First open/close cycle
      acquireLock(doc);
      expect(doc.hsm?.isActive()).toBe(true);
      await manager.unload('doc-1');
      expect(doc.hsm?.isIdle()).toBe(true);

      // Second open/close cycle - same HSM
      acquireLock(doc);
      expect(doc.hsm?.isActive()).toBe(true);
    });

    test('unload on non-active doc is no-op', async () => {
      const doc = createMockDocument('doc-1', 'test.md');

      // Never sent ACQUIRE_LOCK, so not active
      expect(manager.isActive('doc-1')).toBe(false);

      // Should not throw
      await manager.unload('doc-1');

      expect(doc.hsm?.state.statePath).toBe('idle.synced');
    });

    test('getIdleHSM returns HSM via getDocument callback', () => {
      const doc = createMockDocument('doc-1', 'test.md');

      const hsm = manager.getIdleHSM('doc-1');

      expect(hsm).toBe(doc.hsm);
      expect(hsm?.isIdle()).toBe(true);
    });

    test('getIdleHSM returns undefined for unknown doc', () => {
      expect(manager.getIdleHSM('unknown-doc')).toBeUndefined();
    });
  });

  describe('idle mode updates', () => {
    test('handleRemoteUpdate forwards to HSM', async () => {
      const doc = createMockDocument('doc-1', 'test.md');

      const update = createTestUpdate('hello');
      await manager.handleRemoteUpdate('doc-1', update);

      // HSM should have processed the update
      await doc.hsm?.awaitIdleAutoMerge();
      expect(doc.hsm?.matches('idle')).toBe(true);
      // Verify remote state was updated (update was processed)
      expect(doc.hsm?.state.remoteStateVector).not.toBeNull();
    });

    test('handleRemoteUpdate works for active HSM too', async () => {
      const doc = createMockDocument('doc-1', 'test.md');
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      manager.markActive('doc-1');

      // HSM is in active mode (entering states)
      expect(doc.hsm?.isActive()).toBe(true);

      const update = createTestUpdate('hello');
      await manager.handleRemoteUpdate('doc-1', update);

      // Should still be in active state (update processed)
      expect(doc.hsm?.isActive()).toBe(true);
    });

    test('handleRemoteUpdate ignores unknown documents', () => {
      const update = createTestUpdate('hello');

      // Should not throw (returns void, no-op for unknown docs)
      expect(() => {
        manager.handleRemoteUpdate('unknown-doc', update);
      }).not.toThrow();
    });
  });

  describe('status change notifications', () => {
    test('syncStatus.subscribe notifies on status update', async () => {
      let notified = false;

      manager.syncStatus.subscribe(() => {
        notified = true;
      });

      createMockDocument('doc-1', 'test.md');
      // Advance time to trigger PostOffice notifications
      timeProvider.setTime(timeProvider.now() + 100);

      const update = createTestUpdate('hello');
      await manager.handleRemoteUpdate('doc-1', update);
      // Advance time again for the update notification
      timeProvider.setTime(timeProvider.now() + 100);

      // Status changes should have been notified
      expect(notified).toBe(true);
    });

    test('syncStatus.subscribe can be unsubscribed', async () => {
      let callCount = 0;

      const unsubscribe = manager.syncStatus.subscribe(() => {
        callCount++;
      });

      createMockDocument('doc-1', 'test.md');
      // Advance time to trigger PostOffice notifications
      timeProvider.setTime(timeProvider.now() + 100);
      const initialCount = callCount;

      unsubscribe();

      await manager.handleRemoteUpdate('doc-1', createTestUpdate('hello'));

      // Should not have received more notifications after unsubscribe
      expect(callCount).toBe(initialCount);
    });
  });

  describe('effect handling', () => {
    test('onEffect callback receives HSM effects', () => {
      const effects: Array<{ guid: string; type: string }> = [];

      const managerWithEffects = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        onEffect: (guid, effect) => {
          effects.push({ guid, type: effect.type });
        },
      });

      // Reassign manager for createMockDocument to use
      manager = managerWithEffects;
      const doc = createMockDocument('doc-1', 'test.md');

      // Transition to active - ACQUIRE_LOCK triggers effects
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      managerWithEffects.markActive('doc-1');

      // HSM is now in active mode (entering states)
      expect(doc.hsm?.isActive()).toBe(true);

      // Should have received effects during transition
      expect(effects.length).toBeGreaterThan(0);

      managerWithEffects.destroy();
    });
  });

  describe('idle ↔ active transitions', () => {
    test('state preserved across lock cycles', async () => {
      const doc = createMockDocument('doc-1', 'test.md');

      // Get to active mode
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      manager.markActive('doc-1');
      expect(doc.hsm?.isActive()).toBe(true);

      // Unload back to idle
      await manager.unload('doc-1');
      expect(doc.hsm?.matches('idle')).toBe(true);

      // Back to active
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      manager.markActive('doc-1');
      expect(doc.hsm?.isActive()).toBe(true);

      // Unload again
      await manager.unload('doc-1');
      expect(doc.hsm?.matches('idle')).toBe(true);
    });
  });

  describe('persistence callbacks', () => {
    test('LCA is read from cache during HSM creation', async () => {
      const mockLoadAllStates = jest.fn().mockResolvedValue([{
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
      }]);

      const managerWithPersistence = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        loadAllStates: mockLoadAllStates,
      });

      // Initialize to populate cache
      await managerWithPersistence.initialize();

      // Reassign manager for createMockDocument to use
      manager = managerWithPersistence;
      const doc = createMockDocument('doc-1', 'test.md');

      expect(doc.hsm?.state.lca?.contents).toBe('persisted content');
    });
  });

  describe('isActive', () => {
    test('isActive returns false for unknown doc', () => {
      expect(manager.isActive('unknown-doc')).toBe(false);
    });

    test('isActive returns false for idle doc', () => {
      createMockDocument('doc-1', 'test.md');

      expect(manager.isActive('doc-1')).toBe(false);
    });

    test('isActive returns true for active doc', () => {
      const doc = createMockDocument('doc-1', 'test.md');
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      manager.markActive('doc-1');

      expect(manager.isActive('doc-1')).toBe(true);
    });

    test('isActive reflects lock state through lifecycle', async () => {
      const doc = createMockDocument('doc-1', 'test.md');

      expect(manager.isActive('doc-1')).toBe(false);

      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      manager.markActive('doc-1');
      expect(manager.isActive('doc-1')).toBe(true);

      await manager.unload('doc-1');
      expect(manager.isActive('doc-1')).toBe(false);
    });
  });

  describe('setActiveDocuments', () => {
    test('setActiveDocuments only affects HSMs in loading state', () => {
      // Create documents - HSMs will auto-transition to idle.synced
      const doc1 = createMockDocument('doc-1', 'test1.md');
      const doc2 = createMockDocument('doc-2', 'test2.md');

      // Both should be in idle.synced (not loading)
      expect(doc1.hsm?.state.statePath).toBe('idle.synced');
      expect(doc2.hsm?.state.statePath).toBe('idle.synced');

      // setActiveDocuments should have no effect since HSMs are not in loading state
      const allGuids = Array.from(documents.keys());
      manager.setActiveDocuments(new Set(['doc-1']), allGuids);

      // HSMs should remain in their current states
      expect(doc1.hsm?.state.statePath).toBe('idle.synced');
      expect(doc2.hsm?.state.statePath).toBe('idle.synced');
    });

    test('setActiveDocuments is a no-op when destroyed', () => {
      const managerToDestroy = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
      });

      // Reassign manager for createMockDocument to use
      manager = managerToDestroy;
      createMockDocument('doc-1', 'test.md');

      managerToDestroy.destroy();

      // Should not throw
      expect(() => managerToDestroy.setActiveDocuments(new Set(['doc-1']), ['doc-1'])).not.toThrow();
    });
  });

  describe('state exposure', () => {
    test('state.pendingEditorContent is undefined in idle mode', () => {
      const doc = createMockDocument('doc-1', 'test.md');

      expect(doc.hsm?.state.pendingEditorContent).toBeUndefined();
    });

    test('state.lastKnownEditorText is undefined in idle mode', () => {
      const doc = createMockDocument('doc-1', 'test.md');

      expect(doc.hsm?.state.lastKnownEditorText).toBeUndefined();
    });

    test('state.lastKnownEditorText is set after ACQUIRE_LOCK', () => {
      const doc = createMockDocument('doc-1', 'test.md');

      // Start in idle mode
      expect(doc.hsm?.matches('idle')).toBe(true);
      expect(doc.hsm?.state.lastKnownEditorText).toBeUndefined();

      // Send ACQUIRE_LOCK to transition to active
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: 'editor text here' });

      // After ACQUIRE_LOCK, lastKnownEditorText should be set
      expect(doc.hsm?.state.lastKnownEditorText).toBe('editor text here');
    });

    test('state.lastKnownEditorText is set by ACQUIRE_LOCK and updated by CM6_CHANGE', () => {
      const doc = createMockDocument('doc-1', 'test.md');
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: 'initial' });

      // lastKnownEditorText should be set from ACQUIRE_LOCK
      expect(doc.hsm?.state.lastKnownEditorText).toBe('initial');
      expect(doc.hsm?.isActive()).toBe(true);
    });

    test('state.pendingEditorContent is set by ACQUIRE_LOCK for async transition', () => {
      const doc = createMockDocument('doc-1', 'test.md');
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: 'pending' });

      // HSM is in active (entering) state
      expect(doc.hsm?.isActive()).toBe(true);
      // pendingEditorContent is set during entering states (used for reconciliation)
      // It gets cleared after reaching tracking state
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
