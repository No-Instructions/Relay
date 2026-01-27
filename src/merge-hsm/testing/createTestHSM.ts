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
import type {
  MergeState,
  MergeEvent,
  MergeEffect,
  StatePath,
  LCAState,
  MergeMetadata,
  SerializableSnapshot,
  SyncStatus,
} from '../types';
import type { TimeProvider } from '../../TimeProvider';
import { MockTimeProvider } from '../../../__tests__/mocks/MockTimeProvider';
import { MergeHSM } from '../MergeHSM';

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

  /** Initial state path to bootstrap to */
  initialState?: StatePath;

  /** Initial content for localDoc */
  localDoc?: string;

  /** Initial disk state */
  disk?: { contents: string; mtime: number };

  /** Initial LCA state */
  lca?: LCAState;

  /** Custom time provider (default: MockTimeProvider) */
  timeProvider?: TimeProvider;

  /** Starting time for mock (default: Date.now()) */
  startTime?: number;

  /** Log state transitions for debugging */
  logTransitions?: boolean;
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

  /** Get remoteDoc text content (null if not in active mode) */
  getRemoteDocText(): string | null;

  /** Create a serializable snapshot (for future recording) */
  snapshot(): SerializableSnapshot;

  /** State transition history */
  readonly stateHistory: Array<{ from: StatePath; to: StatePath; event: MergeEvent['type'] }>;
}

/**
 * Interface for the HSM that tests interact with.
 * MergeHSM implements this interface.
 */
export interface TestableHSM {
  readonly state: MergeState;
  send(event: MergeEvent): void;
  matches(statePath: string): boolean;
  isActive(): boolean;
  isIdle(): boolean;
  getLocalDoc(): Y.Doc | null;
  getRemoteDoc(): Y.Doc | null;
  getSyncStatus(): SyncStatus;
  checkAndCorrectDrift(): boolean;
  subscribe(listener: (effect: MergeEffect) => void): () => void;
  onStateChange(listener: (from: StatePath, to: StatePath, event: MergeEvent) => void): () => void;
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

  // Build disk metadata if provided
  let diskMeta: MergeMetadata | undefined;
  if (options.disk) {
    diskMeta = {
      hash: await sha256(options.disk.contents),
      mtime: options.disk.mtime,
    };
  }

  // Use the real MergeHSM with test configuration
  const guid = options.guid ?? 'test-guid';
  const hsm = MergeHSM.forTesting({
    guid,
    path: options.path ?? 'test.md',
    vaultId: options.vaultId ?? `test-${guid}`,
    timeProvider: time,
    initialState: options.initialState,
    localDocContent: options.localDoc,
    lca: options.lca,
    disk: diskMeta,
    diskContents: options.disk?.contents,
  });

  // Capture effects
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

  return {
    hsm,
    send: wrappedSend,
    get state() { return hsm.state; },
    get statePath() { return hsm.state.statePath; },
    matches: (path: string) => hsm.matches(path),
    effects,
    clearEffects: () => { effects.length = 0; },
    time,
    getLocalDocText: () => hsm.getLocalDoc()?.getText('content').toString() ?? null,
    getRemoteDocText: () => hsm.getRemoteDoc()?.getText('content').toString() ?? null,
    snapshot: () => createSnapshot(hsm, effects, time),
    stateHistory,
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
    localDocText: hsm.getLocalDoc()?.getText('content').toString() ?? null,
    remoteDocText: hsm.getRemoteDoc()?.getText('content').toString() ?? null,
  };
}
