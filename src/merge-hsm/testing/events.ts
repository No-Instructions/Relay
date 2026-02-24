/**
 * Event Factory Functions
 *
 * These factory functions create plain, serializable event objects
 * for use in tests. Keeping them as plain objects makes future
 * recording/replay support straightforward.
 */

import * as Y from 'yjs';
import type {
  LoadEvent,
  UnloadEvent,
  AcquireLockEvent,
  ReleaseLockEvent,
  DiskChangedEvent,
  RemoteUpdateEvent,
  SaveCompleteEvent,
  CM6ChangeEvent,
  ProviderSyncedEvent,
  ConnectedEvent,
  DisconnectedEvent,
  ResolveEvent,
  DismissConflictEvent,
  OpenDiffViewEvent,
  CancelEvent,
  PersistenceLoadedEvent,
  PersistenceSyncedEvent,
  MergeSuccessEvent,
  MergeConflictEvent,
  RemoteDocUpdatedEvent,
  ErrorEvent,
  PositionedChange,
  LCAState,
  MergeEvent,
  EditorViewRef,
} from '../types';

// =============================================================================
// External Events
// =============================================================================

export function load(guid: string): LoadEvent {
  return { type: 'LOAD', guid };
}

export function unload(): UnloadEvent {
  return { type: 'UNLOAD' };
}

/**
 * Create an ACQUIRE_LOCK event.
 * @param editorContent - The current editor/disk content. Required in v6 to fix BUG-022.
 */
export function acquireLock(editorContent: string = '', editorViewRef?: EditorViewRef): AcquireLockEvent {
  return { type: 'ACQUIRE_LOCK', editorContent, editorViewRef };
}

/**
 * Send ACQUIRE_LOCK and wait for persistence to sync.
 * After this, state will be in active.tracking or active.entering.awaitingRemote
 * (or active.conflict.* if there's a deferred conflict).
 */
export async function sendAcquireLock(hsm: HSMHandle, editorContent: string = ''): Promise<void> {
  hsm.send(acquireLock(editorContent));
  // Wait for state to leave awaitingPersistence (persistence has synced)
  await hsm.hsm?.awaitState?.((s) => !s.includes('awaitingPersistence'));
}

/**
 * Send ACQUIRE_LOCK and wait all the way to active.tracking.
 * Sends PROVIDER_SYNCED if needed to unblock awaitingRemote.
 */
export async function sendAcquireLockToTracking(hsm: HSMHandle, editorContent: string = ''): Promise<void> {
  hsm.send(acquireLock(editorContent));
  // Wait for state to leave awaitingPersistence
  await hsm.hsm?.awaitState?.((s) => !s.includes('awaitingPersistence'));
  // If we're in awaitingRemote, send PROVIDER_SYNCED to unblock
  if (hsm.matches('active.entering.awaitingRemote')) {
    hsm.send(providerSynced());
  }
  // Wait for tracking (or conflict)
  await hsm.hsm?.awaitState?.((s) => s === 'active.tracking' || s.includes('conflict'));
}

export function releaseLock(): ReleaseLockEvent {
  return { type: 'RELEASE_LOCK' };
}

export async function diskChanged(
  contents: string,
  mtime: number,
  hash?: string
): Promise<DiskChangedEvent> {
  return {
    type: 'DISK_CHANGED',
    contents,
    mtime,
    hash: hash ?? await sha256(contents),
  };
}

export function remoteUpdate(update: Uint8Array): RemoteUpdateEvent {
  return { type: 'REMOTE_UPDATE', update };
}

export function saveComplete(mtime: number, hash: string = 'test-hash'): SaveCompleteEvent {
  return { type: 'SAVE_COMPLETE', mtime, hash };
}

export function cm6Change(
  changes: PositionedChange[],
  docText: string,
  isFromYjs: boolean = false
): CM6ChangeEvent {
  return { type: 'CM6_CHANGE', changes, docText, isFromYjs };
}

/**
 * Convenience: create a cm6Change for a simple insert at position
 */
export function cm6Insert(
  from: number,
  insert: string,
  docText: string
): CM6ChangeEvent {
  return cm6Change([{ from, to: from, insert }], docText, false);
}

/**
 * Convenience: create a cm6Change for a simple delete
 */
export function cm6Delete(
  from: number,
  to: number,
  docText: string
): CM6ChangeEvent {
  return cm6Change([{ from, to, insert: '' }], docText, false);
}

/**
 * Convenience: create a cm6Change for a replacement
 */
export function cm6Replace(
  from: number,
  to: number,
  insert: string,
  docText: string
): CM6ChangeEvent {
  return cm6Change([{ from, to, insert }], docText, false);
}

export function providerSynced(): ProviderSyncedEvent {
  return { type: 'PROVIDER_SYNCED' };
}

export function connected(): ConnectedEvent {
  return { type: 'CONNECTED' };
}

export function disconnected(): DisconnectedEvent {
  return { type: 'DISCONNECTED' };
}

// =============================================================================
// User Events
// =============================================================================

export function resolve(contents: string): ResolveEvent {
  return { type: 'RESOLVE', contents };
}

export function dismissConflict(): DismissConflictEvent {
  return { type: 'DISMISS_CONFLICT' };
}

export function openDiffView(): OpenDiffViewEvent {
  return { type: 'OPEN_DIFF_VIEW' };
}

export function cancel(): CancelEvent {
  return { type: 'CANCEL' };
}

// =============================================================================
// Internal Events
// =============================================================================

export function persistenceLoaded(
  updates: Uint8Array,
  lca: LCAState | null
): PersistenceLoadedEvent {
  return { type: 'PERSISTENCE_LOADED', updates, lca };
}

export function persistenceSynced(hasContent: boolean): PersistenceSyncedEvent {
  return { type: 'PERSISTENCE_SYNCED', hasContent };
}

export function mergeSuccess(newLCA: LCAState): MergeSuccessEvent {
  return { type: 'MERGE_SUCCESS', newLCA };
}

export function mergeConflict(
  base: string,
  ours: string,
  theirs: string
): MergeConflictEvent {
  return { type: 'MERGE_CONFLICT', base, ours, theirs };
}

export function remoteDocUpdated(): RemoteDocUpdatedEvent {
  return { type: 'REMOTE_DOC_UPDATED' };
}

export function error(err: Error): ErrorEvent {
  return { type: 'ERROR', error: err };
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

/**
 * SHA-256 hash using Web Crypto API.
 * Works in both browser and Node.js (18+) environments.
 */
export async function sha256(contents: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(contents);
  const hashBuffer = await getCryptoSubtle().digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create an LCAState for testing.
 */
export async function createLCA(
  contents: string,
  mtime: number,
  stateVector?: Uint8Array
): Promise<LCAState> {
  return {
    contents,
    meta: {
      hash: await sha256(contents),
      mtime,
    },
    stateVector: stateVector ?? new Uint8Array([0]),
  };
}

/**
 * Create a Yjs update representing content.
 * Returns an update that can be applied to any Y.Doc to get the content.
 */
export function createYjsUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, content);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

// =============================================================================
// State Transition Helpers
// =============================================================================
//
// These helpers drive the HSM through real state transitions instead of
// bypassing the state machine. Use these instead of forTesting() to ensure
// tests validate actual transition paths.
//
// Minimal interface for HSM test handles (avoids circular imports)
// =============================================================================

/**
 * Minimal interface for driving state transitions.
 * Both TestHSM and MergeHSM satisfy this interface.
 */
export interface HSMHandle {
  send(event: MergeEvent): void;
  matches(path: string): boolean;
  readonly statePath?: string;
  /** Wait for pending idle auto-merge to complete (optional, used by loadToConflict) */
  awaitIdleAutoMerge?(): Promise<void>;
  /** Access to underlying HSM for getting remoteDoc (optional, used by loadAndActivate) */
  hsm?: {
    getRemoteDoc(): Y.Doc | null;
    getLocalDoc?(): Y.Doc | null;
    awaitState?(predicate: (statePath: string) => boolean): Promise<void>;
  };
  /** Seed mock IndexedDB with updates (optional, used by loadAndActivate for proper persistence simulation) */
  seedIndexedDB?(updates: Uint8Array): void;
  /** Sync remoteDoc with updates to share CRDT history (optional, used by loadToIdle) */
  syncRemoteWithUpdate?(update: Uint8Array): void;
}

export interface LoadAndActivateOptions {
  /** Document GUID (default: 'test-guid') */
  guid?: string;
  /** Document path (default: 'test.md') */
  path?: string;
  /** LCA mtime (default: Date.now()) */
  mtime?: number;
  /** Editor view ref for LCA advancement during active.tracking */
  editorViewRef?: EditorViewRef;
}

/**
 * Drive HSM from unloaded to active.tracking with the given content.
 *
 * Sends events: LOAD → PERSISTENCE_LOADED → SET_MODE_ACTIVE → ACQUIRE_LOCK
 * With mock persistence that syncs immediately, transitions through
 * active.loading → active.entering → active.tracking.
 *
 * Also populates the external remoteDoc with the same content (simulating
 * initial provider sync in production).
 *
 * @example
 * ```ts
 * const t = await createTestHSM();
 * await loadAndActivate(t, 'hello world');
 * // t is now in active.tracking with localDoc and remoteDoc containing 'hello world'
 * ```
 */
export async function loadAndActivate(
  hsm: HSMHandle,
  content: string,
  opts?: LoadAndActivateOptions
): Promise<void> {
  const guid = opts?.guid ?? 'test-guid';
  const path = opts?.path ?? 'test.md';
  const mtime = opts?.mtime ?? Date.now();

  // Create LCA and updates for the content
  const updates = content ? createYjsUpdate(content) : new Uint8Array();
  const stateVector = content ? Y.encodeStateVectorFromUpdate(updates) : new Uint8Array([0]);
  const lca = await createLCA(content, mtime, stateVector);

  // Seed the mock IndexedDB with the content BEFORE any transitions.
  // This simulates content that was persisted in a previous session.
  // Per docs/how-we-bootstrap-collaboration.md, content should only be inserted
  // into the CRDT once during enrollment, and loaded from persistence thereafter.
  if (content && hsm.seedIndexedDB) {
    hsm.seedIndexedDB(updates);
  }

  // Drive through transitions:
  // 1. LOAD → loading (flat state)
  hsm.send(load(guid));

  // 2. PERSISTENCE_LOADED → stays in loading, stores LCA and updates
  hsm.send(persistenceLoaded(updates, lca));

  // 3. SET_MODE_ACTIVE → active.loading (mode determination)
  hsm.send({ type: 'SET_MODE_ACTIVE' });

  // 4. ACQUIRE_LOCK → active.entering.awaitingPersistence (creates YDocs)
  //    Persistence syncs asynchronously (may have random delay in tests).
  //    If IDB had content (hasContent=true) → reconciling → tracking.
  //    If IDB was empty (hasContent=false) → awaitingRemote (needs PROVIDER_SYNCED).
  hsm.send(acquireLock(content, opts?.editorViewRef));

  // Wait for persistence to sync and state to settle
  await hsm.hsm?.awaitState?.((s) =>
    s === 'active.tracking' ||
    s === 'active.entering.awaitingRemote' ||
    s === 'active.entering.reconciling'
  );

  // When IDB was empty, HSM waits in awaitingRemote for server state.
  // Send PROVIDER_SYNCED to unblock it.
  if (hsm.matches('active.entering')) {
    hsm.send(providerSynced());
    // Wait for transition to tracking
    await hsm.hsm?.awaitState?.((s) => s === 'active.tracking');
  }

  // Sync localDoc content to remoteDoc (simulating initial provider sync)
  // In production, remoteDoc would be synced via WebSocket/WebRTC provider.
  // We use applyUpdate to avoid triggering the observer twice.
  if (hsm.hsm && content) {
    const remoteDoc = hsm.hsm.getRemoteDoc();
    if (remoteDoc && remoteDoc.getText('contents').toString() === '') {
      // Apply the same updates to remoteDoc to sync them without creating new changes
      Y.applyUpdate(remoteDoc, updates);
    }
  }

  // Verify we reached the expected state
  if (!hsm.matches('active.tracking')) {
    const state = hsm.statePath ?? 'unknown';
    throw new Error(
      `loadAndActivate: expected active.tracking but got ${state}. ` +
      `This may indicate a bug in the state machine or test setup.`
    );
  }
}

export interface LoadToIdleOptions {
  /** Document GUID (default: 'test-guid') */
  guid?: string;
  /** Document path (default: 'test.md') */
  path?: string;
  /** LCA content (default: '') */
  content?: string;
  /** LCA mtime (default: Date.now()) */
  mtime?: number;
}

/**
 * Drive HSM from unloaded to idle.synced.
 *
 * Sends events: LOAD → PERSISTENCE_LOADED (with LCA) → SET_MODE_IDLE
 * Ends in idle.synced (or idle.diskAhead if disk differs from LCA).
 *
 * @example
 * ```ts
 * const t = await createTestHSM();
 * await loadToIdle(t, { content: 'hello' });
 * // t is now in idle.synced
 * ```
 */
export async function loadToIdle(
  hsm: HSMHandle,
  opts?: LoadToIdleOptions
): Promise<void> {
  const guid = opts?.guid ?? 'test-guid';
  const path = opts?.path ?? 'test.md';
  const content = opts?.content ?? '';
  const mtime = opts?.mtime ?? Date.now();

  // Create LCA
  const updates = content ? createYjsUpdate(content) : new Uint8Array();
  const stateVector = content ? Y.encodeStateVectorFromUpdate(updates) : new Uint8Array([0]);
  const lca = await createLCA(content, mtime, stateVector);

  // Seed the mock IndexedDB with the content BEFORE any transitions.
  // This simulates content that was persisted in a previous session.
  if (content && hsm.seedIndexedDB) {
    hsm.seedIndexedDB(updates);
  }

  // Sync remoteDoc with the same updates so it shares CRDT history with local.
  // This ensures subsequent applyRemoteChange() calls create proper delta updates.
  if (content && hsm.syncRemoteWithUpdate) {
    hsm.syncRemoteWithUpdate(updates);
  }

  // Drive through transitions:
  // 1. LOAD → loading
  hsm.send(load(guid));
  // 2. PERSISTENCE_LOADED → stays in loading, stores LCA
  hsm.send(persistenceLoaded(updates, lca));
  // 3. SET_MODE_IDLE → idle.loading → idle.synced (or other idle substate)
  hsm.send({ type: 'SET_MODE_IDLE' });

  // Wait for persistence to sync (localDoc to have expected content).
  // With async delays enabled, the persistence callback fires asynchronously.
  if (content) {
    const maxWaitMs = 100;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const localDocText = hsm.hsm?.getLocalDoc?.()?.getText('contents').toString();
      if (localDocText === content) break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  // Wait for any idle auto-merge to complete
  await hsm.awaitIdleAutoMerge?.();

  // Verify we reached an idle state
  if (!hsm.matches('idle')) {
    const state = hsm.statePath ?? 'unknown';
    throw new Error(
      `loadToIdle: expected idle.* but got ${state}. ` +
      `This may indicate a bug in the state machine or test setup.`
    );
  }
}

export interface LoadToLoadingOptions {
  /** Document GUID (default: 'test-guid') */
  guid?: string;
  /** Document path (default: 'test.md') */
  path?: string;
  /** Pre-existing IndexedDB updates (default: none) */
  updates?: Uint8Array;
  /** LCA state (default: null - no LCA) */
  lca?: LCAState | null;
}

/**
 * Drive HSM from unloaded to loading state.
 *
 * Sends events: LOAD → PERSISTENCE_LOADED
 * The HSM stays in loading until mode determination (SET_MODE_ACTIVE/IDLE).
 * Useful for testing initialization flows.
 *
 * @example
 * ```ts
 * const t = await createTestHSM();
 * await loadToLoading(t);
 * // t is now in loading, waiting for SET_MODE_ACTIVE or SET_MODE_IDLE
 * ```
 */
export async function loadToLoading(
  hsm: HSMHandle,
  opts?: LoadToLoadingOptions
): Promise<void> {
  const guid = opts?.guid ?? 'test-guid';
  const path = opts?.path ?? 'test.md';
  const updates = opts?.updates ?? new Uint8Array();
  const lca = opts?.lca ?? null;

  // Drive through transitions
  // LOAD → loading, PERSISTENCE_LOADED → stays in loading
  hsm.send(load(guid));
  hsm.send(persistenceLoaded(updates, lca));

  // Verify we reached the expected state
  if (!hsm.matches('loading')) {
    const state = hsm.statePath ?? 'unknown';
    throw new Error(
      `loadToLoading: expected loading but got ${state}. ` +
      `This may indicate a bug in the state machine or test setup.`
    );
  }
}

export interface LoadToConflictOptions {
  /** Base content (LCA) */
  base: string;
  /** Remote/CRDT content (different from base) */
  remote: string;
  /** Disk content (different from both base and remote) */
  disk: string;
  /** Document GUID (default: 'test-guid') */
  guid?: string;
  /** Document path (default: 'test.md') */
  path?: string;
}

/**
 * Drive HSM from unloaded to active.conflict.bannerShown through real transitions.
 *
 * Creates a real 3-way conflict by:
 * 1. Loading to idle with base content
 * 2. Receiving remote update with different content
 * 3. Receiving disk change with yet another content
 * 4. Acquiring lock from diverged state → triggers conflict
 *
 * @example
 * ```ts
 * const t = await createTestHSM();
 * await loadToConflict(t, {
 *   base: 'original',
 *   remote: 'remote changed this',
 *   disk: 'disk changed this',
 * });
 * // t is now in active.conflict.bannerShown with real conflict data
 * ```
 */
export async function loadToConflict(
  hsm: HSMHandle,
  opts: LoadToConflictOptions
): Promise<void> {
  const guid = opts.guid ?? 'test-guid';
  const path = opts.path ?? 'test.md';

  // INVARIANT: Per docs/how-we-bootstrap-collaboration.md, content is inserted
  // into the CRDT exactly ONCE during initial enrollment. We NEVER do:
  //   - delete(0, length) + insert(0, newContent) — destroys CRDT history
  //   - Create fresh Y.Doc and merge with existing — creates parallel histories
  //
  // For conflict testing, we simulate a scenario where:
  // - IndexedDB/CRDT has the "remote" content (what was synced from server)
  // - LCA has the "base" content (last common ancestor from before remote edits)
  // - Disk has the "disk" content (external edit while offline)
  // - This creates a real 3-way conflict
  //
  // The key insight: LCA represents the point where local and remote diverged.
  // When remote edits happened, CRDT got remote content but LCA stayed at base.
  // Then disk was edited externally, creating a 3-way divergence.

  // Step 1: Seed IndexedDB with REMOTE content (this is what CRDT will have)
  const remoteUpdates = createYjsUpdate(opts.remote);
  if (hsm.seedIndexedDB) {
    hsm.seedIndexedDB(remoteUpdates);
  }

  // Step 2: Create LCA with BASE content (the last common ancestor)
  // Note: LCA state vector should reflect the base content, not remote
  const baseUpdates = opts.base ? createYjsUpdate(opts.base) : new Uint8Array();
  const baseStateVector = opts.base ? Y.encodeStateVectorFromUpdate(baseUpdates) : new Uint8Array([0]);
  const baseLca = await createLCA(opts.base, 500, baseStateVector);

  // Step 3: Load through state machine
  // - LOAD starts loading
  // - PERSISTENCE_LOADED sets LCA to base (with base state vector)
  // - REMOTE_UPDATE sets _remoteStateVector (to remote state vector, different from LCA)
  // - SET_MODE_IDLE transitions to idle
  hsm.send(load(guid));
  // Pass base updates for local state vector to match LCA
  hsm.send(persistenceLoaded(baseUpdates, baseLca));
  // Send REMOTE_UPDATE to set _remoteStateVector (different from LCA)
  // This simulates remote edits that happened while we were offline
  hsm.send({ type: 'REMOTE_UPDATE', update: remoteUpdates });

  // Pre-compute hash to avoid microtask boundary between SET_MODE_IDLE
  // and DISK_CHANGED (idle merge callbacks must not run between them).
  const diskHash = await sha256(opts.disk);

  hsm.send({ type: 'SET_MODE_IDLE' });

  // Step 4: Send DISK_CHANGED with different content
  // This triggers diverged state (disk differs from both LCA and CRDT)
  hsm.send({
    type: 'DISK_CHANGED',
    contents: opts.disk,
    mtime: 2000,
    hash: diskHash,
  });

  // Wait for any auto-merge attempts to complete
  await hsm.awaitIdleAutoMerge?.();

  // Should be in idle.diverged now (3-way conflict detected)
  if (!hsm.matches('idle.diverged')) {
    const state = hsm.statePath ?? 'unknown';
    throw new Error(
      `loadToConflict: expected idle.diverged after disk change but got ${state}. ` +
      `The base/remote/disk content may not create a real conflict.`
    );
  }

  // Step 4: Acquire lock - this triggers conflict detection
  hsm.send(acquireLock(opts.disk));
  // Wait for persistence to sync and state to settle
  await hsm.hsm?.awaitState?.((s) => !s.includes('awaitingPersistence') && !s.includes('entering'));

  // Verify we reached conflict state
  if (!hsm.matches('active.conflict.bannerShown')) {
    const state = hsm.statePath ?? 'unknown';
    throw new Error(
      `loadToConflict: expected active.conflict.bannerShown but got ${state}. ` +
      `This may indicate a bug in the state machine.`
    );
  }
}

/**
 * Drive HSM to active.conflict.resolving (diff view open).
 *
 * Same as loadToConflict but also opens the diff view.
 */
export async function loadToResolving(
  hsm: HSMHandle,
  opts: LoadToConflictOptions
): Promise<void> {
  await loadToConflict(hsm, opts);
  hsm.send(openDiffView());

  if (!hsm.matches('active.conflict.resolving')) {
    const state = hsm.statePath ?? 'unknown';
    throw new Error(
      `loadToResolving: expected active.conflict.resolving but got ${state}.`
    );
  }
}
