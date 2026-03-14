/**
 * Tests for the new state transition helpers.
 * These helpers drive HSMs through real transitions instead of bypassing with forTesting().
 */

import {
  createTestHSM,
  loadAndActivate,
  loadToIdle,
  loadToLoading,
  createYjsUpdate,
} from '../testing';

describe('State Transition Helpers', () => {
  describe('loadAndActivate', () => {
    test('drives HSM from unloaded to active.tracking', async () => {
      const t = await createTestHSM();

      await loadAndActivate(t, 'hello world');

      expect(t.matches('active.tracking')).toBe(true);
    });

    test('populates localDoc with content', async () => {
      const t = await createTestHSM();

      await loadAndActivate(t, 'test content');

      expect(t.getLocalDocText()).toBe('test content');
    });

    test('establishes LCA matching content', async () => {
      const t = await createTestHSM();

      await loadAndActivate(t, 'hello');

      expect(t.state.lca).not.toBeNull();
      expect(t.state.lca?.contents).toBe('hello');
    });

    test('accepts custom guid', async () => {
      const t = await createTestHSM({ path: 'custom/path.md' });

      await loadAndActivate(t, 'content', {
        guid: 'custom-guid',
      });

      expect(t.hsm.guid).toBe('custom-guid');
      expect(t.hsm.path).toBe('custom/path.md');
    });
  });

  describe('loadToIdle', () => {
    test('drives HSM from unloaded to idle state', async () => {
      const t = await createTestHSM();

      await loadToIdle(t);

      expect(t.matches('idle')).toBe(true);
    });

    test('with content establishes LCA', async () => {
      const t = await createTestHSM();

      await loadToIdle(t, { content: 'test content' });

      expect(t.state.lca).not.toBeNull();
      expect(t.state.lca?.contents).toBe('test content');
    });

    test('goes to idle.synced when disk matches LCA', async () => {
      const t = await createTestHSM();

      await loadToIdle(t, { content: '' });

      expect(t.matches('idle.synced')).toBe(true);
    });
  });

  describe('loadToLoading', () => {
    test('drives HSM to loading state', async () => {
      const t = await createTestHSM();

      await loadToLoading(t);

      expect(t.matches('loading')).toBe(true);
    });

    test('has no LCA by default', async () => {
      const t = await createTestHSM();

      await loadToLoading(t);

      expect(t.state.lca).toBeNull();
    });
  });

  describe('createYjsUpdate', () => {
    test('returns Uint8Array', () => {
      const update = createYjsUpdate('test');

      expect(update).toBeInstanceOf(Uint8Array);
      expect(update.length).toBeGreaterThan(0);
    });

    test('update can be applied to Y.Doc', () => {
      const Y = require('yjs');
      const update = createYjsUpdate('hello world');

      const doc = new Y.Doc();
      Y.applyUpdate(doc, update);

      expect(doc.getText('contents').toString()).toBe('hello world');
      doc.destroy();
    });
  });
});
