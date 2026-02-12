/**
 * Test HSM Factory
 *
 * Creates a MergeHSM instance configured for testing with:
 * - Mocked time provider
 * - Effect capture for assertions
 * - State inspection helpers
 * - Snapshot support for future recording
 */

import * as Y from 'yjs';
import { diff_match_patch } from 'diff-match-patch';
import type {
  MergeState,
  MergeEvent,
  MergeEffect,
  StatePath,
  SerializableSnapshot,
  SyncStatus,
  IYDocPersistence,
  DiskLoader,
} from '../types';
import type { TimeProvider } from '../../TimeProvider';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';
import { MergeHSM } from '../MergeHSM';
import { nextDelay, delaysEnabled } from './random';

// =============================================================================
// Test HSM Interface
// =============================================================================

export interface TestHSMOptions {
  /** Document GUID (default: 'test-guid') */
  guid?: string;

  /** Document path (default: 'test.md') */
  path?: string;

  /** Vault ID (default: 'test-${guid}') */
  vaultId?: string;

  /** Custom time provider (default: MockTimeProvider) */
  timeProvider?: TimeProvider;

  /** Starting time for mock (default: Date.now()) */
  startTime?: number;

  /** Log state transitions for debugging */
  logTransitions?: boolean;

  /**
   * Mock IndexedDB content. When set, the mock persistence will use these
   * updates, simulating IndexedDB state.
   */
  indexedDBUpdates?: Uint8Array;

  /**
   * Custom disk loader for testing enrollment.
   * Default: returns empty content.
   */
  diskLoader?: DiskLoader;
}

export interface TestHSM {
  /** The underlying HSM instance */
  hsm: TestableHSM;

  /** Send an event to the HSM */
  send(event: MergeEvent): void;

  /** Current HSM state */
  readonly state: MergeState;

  /** Current state path (convenience) */
  readonly statePath: StatePath;

  /** Check if HSM matches a state path */
  matches(path: string): boolean;

  /** All effects emitted since creation or last clearEffects() */
  readonly effects: MergeEffect[];

  /** Clear captured effects */
  clearEffects(): void;

  /** Mock time provider for time control */
  readonly time: MockTimeProvider;

  /** Get localDoc text content (null if not in active mode) */
  getLocalDocText(): string | null;

  /** Get localDoc text length (loads from IDB if in idle mode) */
  getLocalDocLength(): Promise<number>;

  /** Get remoteDoc text content (always available - managed externally per spec) */
  getRemoteDocText(): string | null;

  /** Create a serializable snapshot (for future recording) */
  snapshot(): SerializableSnapshot;

  /** State transition history */
  readonly stateHistory: Array<{ from: StatePath; to: StatePath; event: MergeEvent['type'] }>;

  /** Wait for any pending idle auto-merge to complete */
  awaitIdleAutoMerge(): Promise<void>;

  /**
   * Seed the mock IndexedDB with updates.
   * Call this before ACQUIRE_LOCK to simulate content that was persisted
   * in a previous session. This simulates real y-indexeddb behavior where
   * content is loaded from IndexedDB on file open.
   */
  seedIndexedDB(updates: Uint8Array): void;

  /**
   * Apply a remote change using diff-match-patch and send the REMOTE_UPDATE event.
   *
   * This is the proper way to simulate remote changes:
   * 1. Applies the change to remoteDoc using diffMatchPatch (no delete-all/insert-all)
   * 2. Captures the delta update relative to the previous state
   * 3. Sends the REMOTE_UPDATE event to the HSM
   *
   * INVARIANT: Uses diff-based updates to preserve CRDT history.
   */
  applyRemoteChange(newContent: string): void;

  /**
   * Get a delta update from remoteDoc that can be sent as REMOTE_UPDATE.
   * Captures changes since the last call to getRemoteUpdate() or initialization.
   *
   * Use this when you need fine-grained control over when updates are sent.
   */
  getRemoteUpdate(): Uint8Array;

  /**
   * Sync remoteDoc to match the given content using diffMatchPatch.
   * Does NOT send REMOTE_UPDATE - use getRemoteUpdate() after this if needed.
   */
  setRemoteContent(content: string): void;

  /**
   * Sync remoteDoc with the given Yjs update (shares CRDT history).
   * Use this to make remoteDoc a "fork" of localDoc by applying the same updates.
   * This ensures subsequent changes can be properly merged.
   */
  syncRemoteWithUpdate(update: Uint8Array): void;
}

/**
 * Interface for the HSM that tests interact with.
 * MergeHSM implements this interface.
 */
export interface TestableHSM {
  readonly path: string;
  readonly guid: string;
  readonly state: MergeState;
  send(event: MergeEvent): void;
  matches(statePath: string): boolean;
  isActive(): boolean;
  isIdle(): boolean;
  getLocalDoc(): Y.Doc | null;
  getLocalDocLength(): Promise<number>;
  getRemoteDoc(): Y.Doc | null;
  getSyncStatus(): SyncStatus;
  checkAndCorrectDrift(actualEditorText?: string): boolean;
  subscribe(listener: (effect: MergeEffect) => void): () => void;
  onStateChange(listener: (from: StatePath, to: StatePath, event: MergeEvent) => void): () => void;
  awaitCleanup(): Promise<void>;
  awaitIdleAutoMerge(): Promise<void>;
}

// =============================================================================
// Factory Function
// =============================================================================

export async function createTestHSM(options: TestHSMOptions = {}): Promise<TestHSM> {
  const startTime = options.startTime ?? Date.now();
  const time = (options.timeProvider as MockTimeProvider) ?? new MockTimeProvider();

  if (!options.timeProvider) {
    time.setTime(startTime);
  }

  const effects: MergeEffect[] = [];
  const stateHistory: Array<{ from: StatePath; to: StatePath; event: MergeEvent['type'] }> = [];

  // Stateful mock IndexedDB - persists across lock cycles within the same test.
  // This simulates the real y-indexeddb behavior where:
  // 1. On destroy(), the current doc state is persisted
  // 2. On next createPersistence(), that state is loaded into the new doc
  //
  // IMPORTANT: Per docs/how-we-bootstrap-collaboration.md, disk content should only
  // be inserted into the CRDT exactly ONCE during initial enrollment. This stateful
  // mock ensures that reopening a file loads persisted content rather than relying
  // on any LCA fallback mechanisms.
  let storedUpdates: Uint8Array | null = options.indexedDBUpdates ?? null;

  const createPersistence = (_vaultId: string, doc: Y.Doc, _userId?: string): IYDocPersistence => {
    // Subscribe to doc updates to track changes
    const updateHandler = (update: Uint8Array) => {
      // Merge with stored updates (like y-indexeddb does)
      if (storedUpdates) {
        storedUpdates = Y.mergeUpdates([storedUpdates, update]);
      } else {
        storedUpdates = update;
      }
    };
    doc.on('update', updateHandler);

    // Track if IDB had content at sync time (before any new updates)
    const hadContentAtSync = storedUpdates !== null;

    // Random delay for IndexedDB sync simulation (only when TEST_ASYNC_DELAYS=1)
    const syncDelay = delaysEnabled() ? nextDelay(0, 10) : null;

    const doSync = () => {
      if (storedUpdates) {
        Y.applyUpdate(doc, storedUpdates);
      }
    };

    return {
      synced: false,
      once(_event: 'synced', cb: () => void) {
        if (syncDelay) {
          // Async path when delays enabled
          syncDelay.then(() => { doSync(); cb(); });
        } else {
          // Sync path for normal tests
          doSync();
          cb();
        }
      },
      async destroy() {
        if (delaysEnabled()) {
          await nextDelay(0, 5);
        }
        const finalUpdate = Y.encodeStateAsUpdate(doc);
        if (finalUpdate.length > 1) {
          storedUpdates = finalUpdate;
        }
        doc.off('update', updateHandler);
      },
      whenSynced: syncDelay ?? Promise.resolve(),
      hasUserData() {
        // Return whether IDB had content when persistence synced
        return hadContentAtSync;
      },
    };
  };

  // Create the HSM using the normal constructor (no forTesting bypass)
  const guid = options.guid ?? 'test-guid';
  const remoteDoc = new Y.Doc();

  // Default diskLoader for tests - returns empty content
  const baseDiskLoader = options.diskLoader ?? (async () => ({
    content: '',
    hash: 'empty-hash',
    mtime: Date.now(),
  }));

  // Wrap diskLoader with random delay for timing variability
  const diskLoader: DiskLoader = async () => {
    await nextDelay(0, 10);
    return baseDiskLoader();
  };

  // Use production hashFn (defaultHashFn uses SubtleCrypto, already async)
  const hsm = new MergeHSM({
    guid,
    path: options.path ?? 'test.md',
    vaultId: options.vaultId ?? `test-${guid}`,
    remoteDoc,
    timeProvider: time,
    createPersistence,
    diskLoader,
  });

  // Capture effects for test assertions
  hsm.subscribe(effect => {
    effects.push(effect);
  });

  // Track state changes
  hsm.onStateChange((from, to, event) => {
    stateHistory.push({ from, to, event: event.type });
    if (options.logTransitions) {
      console.log(`[HSM] ${from} -> ${to} (${event.type})`);
    }
  });

  const wrappedSend = (event: MergeEvent) => {
    hsm.send(event);
  };

  // Function to seed mock IndexedDB - exposed via TestHSM interface
  const seedIndexedDB = (updates: Uint8Array) => {
    if (storedUpdates) {
      storedUpdates = Y.mergeUpdates([storedUpdates, updates]);
    } else {
      storedUpdates = updates;
    }
  };

  // Track remoteDoc state vector for delta encoding
  let lastRemoteStateVector = Y.encodeStateVector(remoteDoc);

  /**
   * Apply diff-based changes to remoteDoc using diff-match-patch.
   * INVARIANT: Never uses delete-all/insert-all pattern.
   */
  const setRemoteContent = (newContent: string): void => {
    const ytext = remoteDoc.getText('contents');
    const currentContent = ytext.toString();

    if (currentContent === newContent) return;

    const dmp = new diff_match_patch();
    const diffs = dmp.diff_main(currentContent, newContent);
    dmp.diff_cleanupSemantic(diffs);

    remoteDoc.transact(() => {
      let cursor = 0;
      for (const [operation, text] of diffs) {
        switch (operation) {
          case 1: ytext.insert(cursor, text); cursor += text.length; break;
          case 0: cursor += text.length; break;
          case -1: ytext.delete(cursor, text.length); break;
        }
      }
    }, remoteDoc);
  };

  /**
   * Get delta update from remoteDoc since last call.
   */
  const getRemoteUpdate = (): Uint8Array => {
    const update = Y.encodeStateAsUpdate(remoteDoc, lastRemoteStateVector);
    lastRemoteStateVector = Y.encodeStateVector(remoteDoc);
    return update;
  };

  /**
   * Apply remote change and send REMOTE_UPDATE event.
   */
  const applyRemoteChange = (newContent: string): void => {
    setRemoteContent(newContent);
    const update = getRemoteUpdate();
    hsm.send({ type: 'REMOTE_UPDATE', update });
  };

  /**
   * Sync remoteDoc by applying the given Yjs update.
   * This makes remoteDoc share CRDT history with the source of the update.
   */
  const syncRemoteWithUpdate = (update: Uint8Array): void => {
    Y.applyUpdate(remoteDoc, update, remoteDoc);
    // Update tracker to reflect the new state
    lastRemoteStateVector = Y.encodeStateVector(remoteDoc);
  };

  return {
    hsm,
    send: wrappedSend,
    get state() { return hsm.state; },
    get statePath() { return hsm.state.statePath; },
    matches: (path: string) => hsm.matches(path),
    effects,
    clearEffects: () => { effects.length = 0; },
    time,
    getLocalDocText: () => hsm.getLocalDoc()?.getText('contents').toString() ?? null,
    getLocalDocLength: () => hsm.getLocalDocLength(),
    getRemoteDocText: () => hsm.getRemoteDoc()?.getText('contents').toString() ?? null,
    snapshot: () => createSnapshot(hsm, effects, time),
    stateHistory,
    awaitIdleAutoMerge: () => hsm.awaitIdleAutoMerge(),
    seedIndexedDB,
    applyRemoteChange,
    getRemoteUpdate,
    setRemoteContent,
    syncRemoteWithUpdate,
  };
}

// =============================================================================
// Helpers
// =============================================================================

// Get crypto.subtle - works in both browser and Node.js
const getCryptoSubtle = (): SubtleCrypto => {
  if (globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle;
  }
  // Node.js fallback
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require('crypto').webcrypto.subtle;
};

async function sha256(contents: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(contents);
  const hashBuffer = await getCryptoSubtle().digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function uint8ArrayToBase64(arr: Uint8Array): string {
  // Simple base64 encoding for Node.js/browser compatibility
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(arr).toString('base64');
  }
  return btoa(String.fromCharCode(...arr));
}

function createSnapshot(
  hsm: TestableHSM,
  effects: MergeEffect[],
  time: TimeProvider
): SerializableSnapshot {
  const state = hsm.state;
  return {
    timestamp: time.now(),
    state: {
      guid: state.guid,
      path: state.path,
      statePath: state.statePath,
      lca: state.lca ? {
        contents: state.lca.contents,
        hash: state.lca.meta.hash,
        mtime: state.lca.meta.mtime,
        stateVector: uint8ArrayToBase64(state.lca.stateVector),
      } : null,
      disk: state.disk,
      localStateVector: state.localStateVector
        ? uint8ArrayToBase64(state.localStateVector)
        : null,
      remoteStateVector: state.remoteStateVector
        ? uint8ArrayToBase64(state.remoteStateVector)
        : null,
      error: state.error?.message,
      deferredConflict: state.deferredConflict,
    },
    localDocText: hsm.getLocalDoc()?.getText('contents').toString() ?? null,
    remoteDocText: hsm.getRemoteDoc()?.getText('contents').toString() ?? null,
  };
}
