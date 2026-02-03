/**
 * Debug test: Investigate state vector mismatch after lock cycles
 */
import * as Y from 'yjs';
import { MergeManager } from '../MergeManager';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';
import { createTestHSM, loadToIdle, acquireLock, releaseLock } from '../testing';

function createRemoteDoc(): Y.Doc {
  return new Y.Doc();
}

function createTestUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, content);
  return Y.encodeStateAsUpdate(doc);
}

const createDefaultLCA = () => ({
  contents: '',
  hash: 'empty-hash',
  mtime: 1000,
  stateVector: new Uint8Array([0]),
});

describe('state vector debug', () => {
  test('MergeManager lock cycle after remote update', async () => {
    const timeProvider = new MockTimeProvider();
    const manager = new MergeManager({
      getVaultId: (guid) => `test-${guid}`,
      timeProvider,
      loadState: async (guid) => ({
        guid,
        path: 'test.md',
        lca: createDefaultLCA(),
        disk: null,
        localStateVector: null,
        lastStatePath: 'idle.clean' as const,
        persistedAt: Date.now(),
      }),
    });

    const remoteDoc = createRemoteDoc();
    await manager.register('doc-1', 'test.md', remoteDoc);

    let hsm = manager.getIdleHSM('doc-1');
    console.log('After register:', hsm?.state.statePath);

    // Send remote update
    const update = createTestUpdate('hello world');
    await manager.handleIdleRemoteUpdate('doc-1', update);
    await hsm?.awaitIdleAutoMerge();

    console.log('After remote update + auto-merge:', hsm?.state.statePath);
    console.log('LCA:', hsm?.state.lca?.contents);
    console.log('pendingIdleUpdates exists:', !!(hsm as any)?.pendingIdleUpdates);
    console.log('initialPersistenceUpdates exists:', !!(hsm as any)?.initialPersistenceUpdates);

    // Acquire lock
    hsm = await manager.getHSM('doc-1', 'test.md', remoteDoc);
    console.log('After getHSM:', hsm?.state.statePath);
    console.log('localDoc text:', hsm?.getLocalDoc()?.getText('contents').toString());

    // Release
    await manager.unload('doc-1');

    hsm = manager.getIdleHSM('doc-1');
    console.log('After unload:', hsm?.state.statePath);
    console.log('localStateVector:', hsm?.state.localStateVector);
    console.log('LCA stateVector:', hsm?.state.lca?.stateVector);
  });

  test('investigate vectors after lock cycle', async () => {
    const t = await createTestHSM();
    await loadToIdle(t, { content: 'hello', mtime: 1000 });

    console.log('=== AFTER loadToIdle ===');
    console.log('State:', t.statePath);
    console.log('LCA stateVector:', t.state.lca?.stateVector);
    console.log('localStateVector:', t.state.localStateVector);
    console.log('remoteStateVector:', t.state.remoteStateVector);

    // Acquire lock
    t.send(acquireLock('hello'));

    console.log('\n=== AFTER acquireLock ===');
    console.log('State:', t.statePath);
    console.log('LCA stateVector:', t.state.lca?.stateVector);
    console.log('localStateVector:', t.state.localStateVector);
    console.log('remoteStateVector:', t.state.remoteStateVector);

    // Get the actual YDoc state vectors
    const localDoc = t.hsm.getLocalDoc();
    const remoteDoc = t.hsm.getRemoteDoc();
    if (localDoc) {
      console.log('localDoc actual stateVector:', Y.encodeStateVector(localDoc));
      console.log('localDoc text:', localDoc.getText('contents').toString());
    }
    if (remoteDoc) {
      console.log('remoteDoc actual stateVector:', Y.encodeStateVector(remoteDoc));
      console.log('remoteDoc text:', remoteDoc.getText('contents').toString());
    }

    // Release lock
    t.send(releaseLock());
    await t.hsm.awaitCleanup();

    console.log('\n=== AFTER releaseLock ===');
    console.log('State:', t.statePath);
    console.log('LCA stateVector:', t.state.lca?.stateVector);
    console.log('localStateVector:', t.state.localStateVector);
    console.log('remoteStateVector:', t.state.remoteStateVector);

    // Compare vectors
    const lcaVec = t.state.lca?.stateVector;
    const localVec = t.state.localStateVector;
    if (lcaVec && localVec) {
      console.log('\nVector comparison:');
      console.log('LCA vec length:', lcaVec.length, 'bytes:', Array.from(lcaVec));
      console.log('Local vec length:', localVec.length, 'bytes:', Array.from(localVec));
      console.log('Are equal:', arraysEqual(lcaVec, localVec));
    }
  });
});

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
