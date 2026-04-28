import { RelayDebugAPI } from 'src/RelayDebugAPI';

describe('RelayDebugAPI conflict resolution', () => {
  afterEach(() => {
    delete (globalThis as any).__relayDebug;
  });

  it('resolves hunks by hunk id', async () => {
    const hsm: any = {
      _statePath: 'idle.diverged',
      path: '/note.md',
    };
    const doc = {
      _hsm: hsm,
    };
    const mergeManager = {
      _getDocument: jest.fn(() => doc),
      resolveConflictHunk: jest.fn(async () => 'idle.synced'),
    };
    const folder: any = {
      path: 'shared',
      getVirtualPath: jest.fn(() => '/note.md'),
      syncStore: new Map([['/note.md', 'guid-1']]),
      mergeManager,
    };
    const plugin = {
      sharedFolders: {
        _set: new Set([folder]),
        lookup: jest.fn(() => folder),
      },
    };

    const debug = new RelayDebugAPI(plugin);
    try {
      const hunkId = '53';
      const statePath = await (globalThis as any).__relayDebug.resolveHunk(
        '/shared/note.md',
        hunkId,
        'theirs',
      );

      expect(statePath).toBe('idle.synced');
      expect(mergeManager.resolveConflictHunk).toHaveBeenCalledWith(
        'guid-1',
        hunkId,
        'theirs',
      );
    } finally {
      debug.destroy();
    }
  });
});
