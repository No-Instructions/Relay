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
  ResolveAcceptDiskEvent,
  ResolveAcceptLocalEvent,
  ResolveAcceptMergedEvent,
  DismissConflictEvent,
  OpenDiffViewEvent,
  CancelEvent,
  PersistenceLoadedEvent,
  YDocsReadyEvent,
  InitializeWithContentEvent,
  InitializeLCAEvent,
  MergeSuccessEvent,
  MergeConflictEvent,
  RemoteDocUpdatedEvent,
  ErrorEvent,
  PositionedChange,
  LCAState,
  MergeEvent,
} from '../types';

// =============================================================================
// External Events
// =============================================================================

export function load(guid: string, path: string): LoadEvent {
  return { type: 'LOAD', guid, path };
}

export function unload(): UnloadEvent {
  return { type: 'UNLOAD' };
}

/**
 * Create an ACQUIRE_LOCK event.
 * @param editorContent - The current editor/disk content. Required in v6 to fix BUG-022.
 */
export function acquireLock(editorContent: string = ''): AcquireLockEvent {
  return { type: 'ACQUIRE_LOCK', editorContent };
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

export function resolveAcceptDisk(): ResolveAcceptDiskEvent {
  return { type: 'RESOLVE_ACCEPT_DISK' };
}

export function resolveAcceptLocal(): ResolveAcceptLocalEvent {
  return { type: 'RESOLVE_ACCEPT_LOCAL' };
}

export function resolveAcceptMerged(contents: string): ResolveAcceptMergedEvent {
  return { type: 'RESOLVE_ACCEPT_MERGED', contents };
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

export function yDocsReady(): YDocsReadyEvent {
  return { type: 'YDOCS_READY' };
}

/**
 * Create an INITIALIZE_WITH_CONTENT event.
 * Used when there's no LCA to initialize a document with content.
 */
export function initializeWithContent(content: string, hash: string, mtime: number): InitializeWithContentEvent {
  return { type: 'INITIALIZE_WITH_CONTENT', content, hash, mtime };
}

/**
 * Create an INITIALIZE_LCA event.
 * Used when the content is already in the CRDT and we just need to set the LCA.
 */
export function initializeLCA(content: string, hash: string, mtime: number): InitializeLCAEvent {
  return { type: 'INITIALIZE_LCA', content, hash, mtime };
}

export function mergeSuccess(newLCA: LCAState): MergeSuccessEvent {
  return { type: 'MERGE_SUCCESS', newLCA };
}

export function mergeConflict(
  base: string,
  local: string,
  remote: string
): MergeConflictEvent {
  return { type: 'MERGE_CONFLICT', base, local, remote };
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
}

export interface LoadAndActivateOptions {
  /** Document GUID (default: 'test-guid') */
  guid?: string;
  /** Document path (default: 'test.md') */
  path?: string;
  /** LCA mtime (default: Date.now()) */
  mtime?: number;
}

/**
 * Drive HSM from unloaded to active.tracking with the given content.
 *
 * Sends events: LOAD → PERSISTENCE_LOADED → ACQUIRE_LOCK → INITIALIZE_WITH_CONTENT
 * The INITIALIZE_WITH_CONTENT event creates YDocs, inserts content, and since
 * a lock was requested, transitions to active.entering then active.tracking.
 *
 * @example
 * ```ts
 * const t = await createTestHSM();
 * await loadAndActivate(t, 'hello world');
 * // t is now in active.tracking with localDoc containing 'hello world'
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
  const hash = await sha256(content);

  // Drive through transitions:
  // 1. LOAD → loading.loadingPersistence
  hsm.send(load(guid, path));

  // 2. PERSISTENCE_LOADED (no LCA) → loading.awaitingLCA
  hsm.send(persistenceLoaded(new Uint8Array(), null));

  // 3. ACQUIRE_LOCK → sets pendingLockAcquisition flag, stays in awaitingLCA
  hsm.send(acquireLock(content));

  // 4. INITIALIZE_WITH_CONTENT → creates YDocs, inserts content, sets LCA,
  //    then since lock was pending, transitions to active.entering.
  //    YDOCS_READY is sent via Promise microtask when persistence syncs.
  hsm.send(initializeWithContent(content, hash, mtime));

  // Wait for YDOCS_READY to fire (via microtask from whenSynced Promise)
  await Promise.resolve();

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
 * Drive HSM from unloaded to idle.clean.
 *
 * Sends events: LOAD → PERSISTENCE_LOADED (with LCA)
 * Ends in idle.clean (or idle.diskAhead if disk differs from LCA).
 *
 * @example
 * ```ts
 * const t = await createTestHSM();
 * await loadToIdle(t, { content: 'hello' });
 * // t is now in idle.clean
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

  // Drive through transitions
  hsm.send(load(guid, path));
  hsm.send(persistenceLoaded(updates, lca));

  // Verify we reached an idle state
  if (!hsm.matches('idle')) {
    const state = hsm.statePath ?? 'unknown';
    throw new Error(
      `loadToIdle: expected idle.* but got ${state}. ` +
      `This may indicate a bug in the state machine or test setup.`
    );
  }
}

export interface LoadToAwaitingLCAOptions {
  /** Document GUID (default: 'test-guid') */
  guid?: string;
  /** Document path (default: 'test.md') */
  path?: string;
  /** Pre-existing IndexedDB updates (default: none) */
  updates?: Uint8Array;
}

/**
 * Drive HSM from unloaded to loading.awaitingLCA.
 *
 * Sends events: LOAD → PERSISTENCE_LOADED (without LCA)
 * Useful for testing initialization flows.
 *
 * @example
 * ```ts
 * const t = await createTestHSM();
 * await loadToAwaitingLCA(t);
 * // t is now in loading.awaitingLCA, waiting for INITIALIZE_WITH_CONTENT
 * ```
 */
export async function loadToAwaitingLCA(
  hsm: HSMHandle,
  opts?: LoadToAwaitingLCAOptions
): Promise<void> {
  const guid = opts?.guid ?? 'test-guid';
  const path = opts?.path ?? 'test.md';
  const updates = opts?.updates ?? new Uint8Array();

  // Drive through transitions (no LCA → stays in awaitingLCA)
  hsm.send(load(guid, path));
  hsm.send(persistenceLoaded(updates, null));

  // Verify we reached the expected state
  if (!hsm.matches('loading.awaitingLCA')) {
    const state = hsm.statePath ?? 'unknown';
    throw new Error(
      `loadToAwaitingLCA: expected loading.awaitingLCA but got ${state}. ` +
      `This may indicate a bug in the state machine or test setup.`
    );
  }
}
