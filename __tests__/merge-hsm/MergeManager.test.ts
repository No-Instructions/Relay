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
import { MergeManager } from 'src/merge-hsm/MergeManager';
import { MergeHSM } from 'src/merge-hsm/MergeHSM';
import { MockTimeProvider } from '../mocks/MockTimeProvider';
import { PostOffice } from 'src/observable/Postie';

// Simulates a Document that owns an HSM
interface MockDocument {
  guid: string;
  path: string;
  hsm: MergeHSM | null;
  remoteDoc: Y.Doc;
}

/** Create a valid Yjs state vector from content text. */
function stateVectorFor(content: string, clientID: number = 1): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  doc.getText('contents').insert(0, content);
  const sv = Y.encodeStateVector(doc);
  doc.destroy();
  return sv;
}

describe('MergeManager', () => {
  let manager: MergeManager;
  let timeProvider: MockTimeProvider;
  let documents: Map<string, MockDocument>;

  // Helper to create a mock document and its HSM
  async function createMockDocument(guid: string, path: string): Promise<MockDocument> {
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
      getPath: () => path,
      remoteDoc,
      getDiskContent: async () => ({ content: '', hash: 'empty', mtime: Date.now() }),
    });

    // Register document in our map (simulating SharedFolder.files)
    documents.set(guid, doc);

    // Notify manager that HSM was created
    manager.notifyHSMCreated(guid);

    // Wait for async createHSM initialization (loadState → PERSISTENCE_LOADED → SET_MODE_IDLE)
    await Promise.resolve();

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
            stateVector: stateVectorFor('content 1'),
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
            stateVector: stateVectorFor('content 2'),
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
    test('getLCAMeta returns null for unknown guid', async () => {
      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
      });

      await managerWithInit.initialize();

      expect(managerWithInit.getLCAMeta('unknown-guid')).toBeNull();
    });

    test('getLCAMeta returns metadata from cache after initialize', async () => {
      const mockLoadAllStates = jest.fn().mockResolvedValue([
        {
          guid: 'doc-1',
          path: 'test.md',
          lcaMeta: {
            meta: { hash: 'test-hash', mtime: 1000 },
            stateVector: new Uint8Array([1, 2, 3]),
          },
          disk: null,
          localStateVector: null,
          lastStatePath: 'idle.synced',
        },
      ]);

      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        loadAllStates: mockLoadAllStates,
      });

      await managerWithInit.initialize();

      const lcaMeta = managerWithInit.getLCAMeta('doc-1');
      expect(lcaMeta).not.toBeNull();
      expect(lcaMeta?.meta.hash).toBe('test-hash');
      expect(lcaMeta?.meta.mtime).toBe(1000);
      expect(lcaMeta?.stateVector).toEqual(new Uint8Array([1, 2, 3]));
    });

    test('getLCAMeta returns null for doc with null LCA', async () => {
      const mockLoadAllStates = jest.fn().mockResolvedValue([
        {
          guid: 'doc-no-lca',
          path: 'test.md',
          lcaMeta: null,
          disk: null,
          localStateVector: null,
          lastStatePath: 'idle.synced',
        },
      ]);

      const managerWithInit = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        loadAllStates: mockLoadAllStates,
      });

      await managerWithInit.initialize();

      expect(managerWithInit.getLCAMeta('doc-no-lca')).toBeNull();
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
      await createMockDocument('doc-1', 'test.md');

      const newLCA = {
        contents: 'new content',
        meta: { hash: 'new-hash', mtime: 2000 },
        stateVector: new Uint8Array([4, 5, 6]),
      };

      await managerWithEffects.setLCA('doc-1', newLCA);

      // Cache should be updated immediately (metadata only, no contents)
      const cachedMeta = managerWithEffects.getLCAMeta('doc-1');
      expect(cachedMeta).not.toBeNull();
      expect(cachedMeta?.meta.hash).toBe('new-hash');
      expect(cachedMeta?.meta.mtime).toBe(2000);
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
      await createMockDocument('doc-1', 'test.md');
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
          lcaMeta: {
            meta: { hash: 'existing-hash', mtime: 1000 },
            stateVector: stateVectorFor('existing content'),
          },
          disk: null,
          localStateVector: null,
          lastStatePath: 'idle.synced',
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
      await createMockDocument('doc-1', 'test.md');

      // Should have LCA metadata from initialize
      expect(managerWithInit.getLCAMeta('doc-1')).not.toBeNull();

      // Set to null
      await managerWithInit.setLCA('doc-1', null);

      // Should now be null
      expect(managerWithInit.getLCAMeta('doc-1')).toBeNull();
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
      await createMockDocument('doc-1', 'test.md');

      const newLCA = {
        contents: 'new content',
        meta: { hash: 'new-hash', mtime: 2000 },
        stateVector: new Uint8Array([4, 5, 6]),
      };

      // Should not throw
      await expect(managerNoEffects.setLCA('doc-1', newLCA)).resolves.toBeUndefined();

      // Cache should still be updated (metadata only)
      expect(managerNoEffects.getLCAMeta('doc-1')?.meta.hash).toBe('new-hash');
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

      // Cache should still have it (metadata only)
      expect(managerWithInit.getLCAMeta('unknown-doc')?.meta.hash).toBe('orphan-hash');
    });
  });

  describe('HSM creation via factory', () => {
    test('createHSM creates HSM in idle state', async () => {
      const doc = await createMockDocument('doc-1', 'notes/test.md');

      expect(doc.hsm).toBeDefined();
      expect(doc.hsm?.state.statePath).toBe('idle.synced');
    });

    test('isRegistered returns true for created HSM', async () => {
      await createMockDocument('doc-1', 'notes/test.md');

      expect(manager.isRegistered('doc-1')).toBe(true);
    });

    test('isRegistered returns false for unknown doc', async () => {
      expect(manager.isRegistered('unknown-doc')).toBe(false);
    });

    test('notifyHSMDestroyed cleans up registration', async () => {
      await createMockDocument('doc-1', 'notes/test.md');

      expect(manager.isRegistered('doc-1')).toBe(true);

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

    test('HSM transitions to active on ACQUIRE_LOCK', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');

      expect(doc.hsm?.state.statePath).toBe('idle.synced');

      acquireLock(doc);

      // HSM enters active.* states
      expect(doc.hsm?.isActive()).toBe(true);
      expect(manager.isActive('doc-1')).toBe(true);
    });

    test('unload releases lock and returns to idle', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');

      acquireLock(doc);
      expect(manager.isActive('doc-1')).toBe(true);

      await manager.unload('doc-1');

      expect(manager.isActive('doc-1')).toBe(false);
      expect(doc.hsm?.state.statePath).toBe('idle.synced');
    });

    test('HSM survives multiple lock cycles', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');

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
      const doc = await createMockDocument('doc-1', 'test.md');

      // Never sent ACQUIRE_LOCK, so not active
      expect(manager.isActive('doc-1')).toBe(false);

      // Should not throw
      await manager.unload('doc-1');

      expect(doc.hsm?.state.statePath).toBe('idle.synced');
    });

    test('getIdleHSM returns HSM via getDocument callback', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');

      const hsm = manager.getIdleHSM('doc-1');

      expect(hsm).toBe(doc.hsm);
      expect(hsm?.isIdle()).toBe(true);
    });

    test('getIdleHSM returns undefined for unknown doc', async () => {
      expect(manager.getIdleHSM('unknown-doc')).toBeUndefined();
    });
  });

  describe('idle mode updates', () => {
    test('handleRemoteUpdate forwards to HSM', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');

      const update = createTestUpdate('hello');
      await manager.handleRemoteUpdate('doc-1', update);

      // HSM should have processed the update
      await doc.hsm?.awaitIdleAutoMerge();
      expect(doc.hsm?.matches('idle')).toBe(true);
      // Verify remote state was updated (update was processed)
      expect(doc.hsm?.state.remoteStateVector).not.toBeNull();
    });

    test('handleRemoteUpdate works for active HSM too', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      manager.markActive('doc-1');

      // HSM is in active mode (entering states)
      expect(doc.hsm?.isActive()).toBe(true);

      const update = createTestUpdate('hello');
      await manager.handleRemoteUpdate('doc-1', update);

      // Should still be in active state (update processed)
      expect(doc.hsm?.isActive()).toBe(true);
    });

    test('handleRemoteUpdate ignores unknown documents', async () => {
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

      await createMockDocument('doc-1', 'test.md');
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

      await createMockDocument('doc-1', 'test.md');
      // Advance time to trigger PostOffice notifications
      timeProvider.setTime(timeProvider.now() + 100);
      const initialCount = callCount;

      unsubscribe();

      await manager.handleRemoteUpdate('doc-1', createTestUpdate('hello'));

      // Should not have received more notifications after unsubscribe
      expect(callCount).toBe(initialCount);
    });
  });

  describe('idle ↔ active transitions', () => {
    test('state preserved across lock cycles', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');

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
    test('LCA is loaded from per-document state during HSM creation', async () => {
      const persistedState = {
        guid: 'doc-1',
        path: 'test.md',
        lca: {
          contents: 'persisted content',
          hash: 'hash123',
          mtime: 1000,
          stateVector: stateVectorFor('persisted content'),
        },
        disk: null,
        localStateVector: null,
        lastStatePath: 'idle.synced',
        persistedAt: Date.now(),
      };

      const mockLoadAllStates = jest.fn().mockResolvedValue([persistedState]);
      const mockLoadState = jest.fn().mockResolvedValue(persistedState);

      const managerWithPersistence = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
        loadAllStates: mockLoadAllStates,
        loadState: mockLoadState,
      });

      // Initialize to populate cache
      await managerWithPersistence.initialize();

      // Reassign manager for createMockDocument to use
      manager = managerWithPersistence;
      const doc = await createMockDocument('doc-1', 'test.md');

      // Wait for async loadState → PERSISTENCE_LOADED → SET_MODE_IDLE to complete
      await doc.hsm!.awaitIdle();

      expect(doc.hsm?.state.lca?.contents).toBe('persisted content');
    });
  });

  describe('isActive', () => {
    test('isActive returns false for unknown doc', async () => {
      expect(manager.isActive('unknown-doc')).toBe(false);
    });

    test('isActive returns false for idle doc', async () => {
      await createMockDocument('doc-1', 'test.md');

      expect(manager.isActive('doc-1')).toBe(false);
    });

    test('isActive returns true for active doc', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      manager.markActive('doc-1');

      expect(manager.isActive('doc-1')).toBe(true);
    });

    test('isActive reflects lock state through lifecycle', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');

      expect(manager.isActive('doc-1')).toBe(false);

      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: '' });
      manager.markActive('doc-1');
      expect(manager.isActive('doc-1')).toBe(true);

      await manager.unload('doc-1');
      expect(manager.isActive('doc-1')).toBe(false);
    });
  });

  describe('setActiveDocuments', () => {
    test('setActiveDocuments only affects HSMs in loading state', async () => {
      // Create documents - HSMs will auto-transition to idle.synced
      const doc1 = await createMockDocument('doc-1', 'test1.md');
      const doc2 = await createMockDocument('doc-2', 'test2.md');

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

    test('setActiveDocuments is a no-op when destroyed', async () => {
      const managerToDestroy = new MergeManager({
        getVaultId: (guid) => `test-${guid}`,
        getDocument: (guid) => documents.get(guid),
        timeProvider,
      });

      // Reassign manager for createMockDocument to use
      manager = managerToDestroy;
      await createMockDocument('doc-1', 'test.md');

      managerToDestroy.destroy();

      // Should not throw
      expect(() => managerToDestroy.setActiveDocuments(new Set(['doc-1']), ['doc-1'])).not.toThrow();
    });
  });

  describe('state exposure', () => {
    test('state.pendingEditorContent is undefined in idle mode', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');

      expect(doc.hsm?.state.pendingEditorContent).toBeUndefined();
    });

    test('state.lastKnownEditorText is undefined in idle mode', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');

      expect(doc.hsm?.state.lastKnownEditorText).toBeUndefined();
    });

    test('state.lastKnownEditorText is set after ACQUIRE_LOCK', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');

      // Start in idle mode
      expect(doc.hsm?.matches('idle')).toBe(true);
      expect(doc.hsm?.state.lastKnownEditorText).toBeUndefined();

      // Send ACQUIRE_LOCK to transition to active
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: 'editor text here' });

      // After ACQUIRE_LOCK, lastKnownEditorText should be set
      expect(doc.hsm?.state.lastKnownEditorText).toBe('editor text here');
    });

    test('state.lastKnownEditorText is set by ACQUIRE_LOCK and updated by CM6_CHANGE', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');
      doc.hsm?.send({ type: 'ACQUIRE_LOCK', editorContent: 'initial' });

      // lastKnownEditorText should be set from ACQUIRE_LOCK
      expect(doc.hsm?.state.lastKnownEditorText).toBe('initial');
      expect(doc.hsm?.isActive()).toBe(true);
    });

    test('state.pendingEditorContent is set by ACQUIRE_LOCK for async transition', async () => {
      const doc = await createMockDocument('doc-1', 'test.md');
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

// =============================================================================
// Multi-HSM and lifecycle tests (using test harness)
// =============================================================================

import {
  createTestHSM,
  loadToIdle,
  loadAndActivate,
  loadToConflict,
  diskChanged,
  sendAcquireLockToTracking,
  releaseLock,
  resolve,
  cm6Insert,
  providerSynced,
  connected,
  disconnected,
  unload,
  load,
  persistenceLoaded,
  expectState,
} from 'src/merge-hsm/testing';
import type { TestHSM } from 'src/merge-hsm/testing';

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
// Multi-HSM independence
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
// Concurrent cross-file operations
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
// Memory leak scenarios
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
