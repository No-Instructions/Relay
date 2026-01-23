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

export function acquireLock(): AcquireLockEvent {
  return { type: 'ACQUIRE_LOCK' };
}

export function releaseLock(): ReleaseLockEvent {
  return { type: 'RELEASE_LOCK' };
}

export function diskChanged(
  contents: string,
  mtime: number,
  hash?: string
): DiskChangedEvent {
  return {
    type: 'DISK_CHANGED',
    contents,
    mtime,
    hash: hash ?? simpleHash(contents),
  };
}

export function remoteUpdate(update: Uint8Array): RemoteUpdateEvent {
  return { type: 'REMOTE_UPDATE', update };
}

export function saveComplete(mtime: number): SaveCompleteEvent {
  return { type: 'SAVE_COMPLETE', mtime };
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

/**
 * Simple hash for testing (not cryptographic).
 * In production, use SHA-256 via SubtleCrypto.
 */
function simpleHash(contents: string): string {
  let hash = 0;
  for (let i = 0; i < contents.length; i++) {
    const char = contents.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return 'hash:' + Math.abs(hash).toString(16);
}

/**
 * Create an LCAState for testing
 */
export function createLCA(
  contents: string,
  mtime: number,
  stateVector?: Uint8Array
): LCAState {
  return {
    contents,
    meta: {
      hash: simpleHash(contents),
      mtime,
    },
    stateVector: stateVector ?? new Uint8Array([0]),
  };
}
