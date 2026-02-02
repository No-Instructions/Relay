/**
 * Event Factory Functions
 *
 * These factory functions create plain, serializable event objects
 * for use in tests. Keeping them as plain objects makes future
 * recording/replay support straightforward.
 */

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
  MergeSuccessEvent,
  MergeConflictEvent,
  RemoteDocUpdatedEvent,
  ErrorEvent,
  PositionedChange,
  LCAState,
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
 * Create an LCAState for testing
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
