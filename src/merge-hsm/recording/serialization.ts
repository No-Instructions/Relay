/**
 * HSM Recording Serialization Utilities
 *
 * Functions for converting between runtime types (with Uint8Array)
 * and serializable types (with base64 strings).
 */

import type {
  MergeEvent,
  MergeEffect,
  LCAState,
  PersistedMergeState,
  SyncStatus,
} from '../types';
import type {
  SerializableEvent,
  SerializableEffect,
  SerializableLCA,
  SerializablePersistedState,
  SerializableSyncStatus,
} from './types';

// =============================================================================
// Base64 Encoding/Decoding
// =============================================================================

/**
 * Encode a Uint8Array to base64 string.
 * Works in both Node.js and browser environments.
 */
export function uint8ArrayToBase64(arr: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(arr).toString('base64');
  }
  // Browser fallback
  let binary = '';
  const len = arr.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string to Uint8Array.
 * Works in both Node.js and browser environments.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  // Browser fallback
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// =============================================================================
// Event Serialization
// =============================================================================

/**
 * Serialize a MergeEvent to a JSON-safe object.
 * Converts Uint8Array fields to base64 strings.
 */
export function serializeEvent(event: MergeEvent): SerializableEvent {
  switch (event.type) {
    case 'REMOTE_UPDATE':
      return {
        type: 'REMOTE_UPDATE',
        update: uint8ArrayToBase64(event.update),
      };

    case 'PERSISTENCE_LOADED':
      return {
        type: 'PERSISTENCE_LOADED',
        updates: uint8ArrayToBase64(event.updates),
        lca: event.lca ? serializeLCA(event.lca) : null,
      };

    case 'MERGE_SUCCESS':
      return {
        type: 'MERGE_SUCCESS',
        newLCA: serializeLCA(event.newLCA),
      };

    case 'ERROR':
      return {
        type: 'ERROR',
        error: event.error.message,
      };

    case 'IDLE_MERGE_COMPLETE':
      if (event.success) {
        return {
          type: 'IDLE_MERGE_COMPLETE' as const,
          success: true as const,
          source: event.source,
          newLCA: serializeLCA(event.newLCA),
        };
      }
      return {
        type: 'IDLE_MERGE_COMPLETE' as const,
        success: false as const,
        source: event.source,
        ...(event.error ? { error: event.error.message } : {}),
      };

    case 'ACQUIRE_LOCK':
      return {
        type: 'ACQUIRE_LOCK',
        editorContent: event.editorContent,
      } as unknown as SerializableEvent;

    // Events without binary data pass through
    case 'LOAD':
    case 'UNLOAD':
    case 'RELEASE_LOCK':
    case 'DISK_CHANGED':
    case 'SAVE_COMPLETE':
    case 'CM6_CHANGE':
    case 'PROVIDER_SYNCED':
    case 'CONNECTED':
    case 'DISCONNECTED':
    case 'RESOLVE':
    case 'DISMISS_CONFLICT':
    case 'OPEN_DIFF_VIEW':
    case 'CANCEL':
    case 'PERSISTENCE_SYNCED':
    case 'MERGE_CONFLICT':
    case 'REMOTE_DOC_UPDATED':
      return event as unknown as SerializableEvent;

    default:
      return event as unknown as SerializableEvent;
  }
}

/**
 * Deserialize a SerializableEvent back to a MergeEvent.
 * Converts base64 strings back to Uint8Array.
 */
export function deserializeEvent(event: SerializableEvent): MergeEvent {
  switch (event.type) {
    case 'REMOTE_UPDATE':
      return {
        type: 'REMOTE_UPDATE',
        update: base64ToUint8Array(event.update),
      };

    case 'PERSISTENCE_LOADED':
      return {
        type: 'PERSISTENCE_LOADED',
        updates: base64ToUint8Array(event.updates),
        lca: event.lca ? deserializeLCA(event.lca) : null,
      };

    case 'MERGE_SUCCESS':
      return {
        type: 'MERGE_SUCCESS',
        newLCA: deserializeLCA(event.newLCA),
      };

    case 'ERROR':
      return {
        type: 'ERROR',
        error: new Error(event.error),
      };

    case 'IDLE_MERGE_COMPLETE':
      if (event.success) {
        return {
          type: 'IDLE_MERGE_COMPLETE',
          success: true,
          source: event.source,
          newLCA: deserializeLCA(event.newLCA),
        } as MergeEvent;
      }
      return {
        type: 'IDLE_MERGE_COMPLETE',
        success: false,
        source: event.source,
        ...(event.error ? { error: new Error(event.error) } : {}),
      } as MergeEvent;

    // Events without binary data pass through
    default:
      return event as MergeEvent;
  }
}

// =============================================================================
// Effect Serialization
// =============================================================================

/**
 * Serialize a MergeEffect to a JSON-safe object.
 */
export function serializeEffect(effect: MergeEffect): SerializableEffect {
  switch (effect.type) {
    case 'SYNC_TO_REMOTE':
      return {
        type: 'SYNC_TO_REMOTE',
        update: uint8ArrayToBase64(effect.update),
      };

    case 'PERSIST_STATE':
      return {
        type: 'PERSIST_STATE',
        guid: effect.guid,
        state: _serializePersistedState(effect.state),
      };

    case 'STATUS_CHANGED':
      return {
        type: 'STATUS_CHANGED',
        guid: effect.guid,
        status: _serializeSyncStatus(effect.status),
      };

    // Effects without binary data pass through
    case 'DISPATCH_CM6':
    case 'WRITE_DISK':
      return effect as unknown as SerializableEffect;

    default:
      return effect as unknown as SerializableEffect;
  }
}

/**
 * Deserialize a SerializableEffect back to a MergeEffect.
 */
export function deserializeEffect(effect: SerializableEffect): MergeEffect {
  switch (effect.type) {
    case 'SYNC_TO_REMOTE':
      return {
        type: 'SYNC_TO_REMOTE',
        update: base64ToUint8Array(effect.update),
      };

    case 'PERSIST_STATE':
      return {
        type: 'PERSIST_STATE',
        guid: effect.guid,
        state: _deserializePersistedState(effect.state),
      };

    case 'STATUS_CHANGED':
      return {
        type: 'STATUS_CHANGED',
        guid: effect.guid,
        status: _deserializeSyncStatus(effect.status),
      };

    default:
      return effect as MergeEffect;
  }
}

// Internal helpers for effect serialization (not exported)

function _serializePersistedState(state: PersistedMergeState): SerializablePersistedState {
  return {
    guid: state.guid,
    path: state.path,
    lca: state.lca ? {
      contents: state.lca.contents,
      hash: state.lca.hash,
      mtime: state.lca.mtime,
      stateVector: uint8ArrayToBase64(state.lca.stateVector),
    } : null,
    disk: state.disk,
    localStateVector: state.localStateVector
      ? uint8ArrayToBase64(state.localStateVector)
      : null,
    lastStatePath: state.lastStatePath,
    deferredConflict: state.deferredConflict,
    persistedAt: state.persistedAt,
  };
}

function _deserializePersistedState(state: SerializablePersistedState): PersistedMergeState {
  return {
    guid: state.guid,
    path: state.path,
    lca: state.lca ? {
      contents: state.lca.contents,
      hash: state.lca.hash,
      mtime: state.lca.mtime,
      stateVector: base64ToUint8Array(state.lca.stateVector),
    } : null,
    disk: state.disk,
    localStateVector: state.localStateVector
      ? base64ToUint8Array(state.localStateVector)
      : null,
    lastStatePath: state.lastStatePath,
    deferredConflict: state.deferredConflict,
    persistedAt: state.persistedAt,
  };
}

function _serializeSyncStatus(status: SyncStatus): SerializableSyncStatus {
  return {
    guid: status.guid,
    status: status.status,
    diskMtime: status.diskMtime,
    localStateVector: uint8ArrayToBase64(status.localStateVector),
    remoteStateVector: uint8ArrayToBase64(status.remoteStateVector),
  };
}

function _deserializeSyncStatus(status: SerializableSyncStatus): SyncStatus {
  return {
    guid: status.guid,
    status: status.status,
    diskMtime: status.diskMtime,
    localStateVector: base64ToUint8Array(status.localStateVector),
    remoteStateVector: base64ToUint8Array(status.remoteStateVector),
  };
}

// =============================================================================
// LCA Serialization
// =============================================================================

/**
 * Serialize an LCAState to a JSON-safe object.
 */
export function serializeLCA(lca: LCAState): SerializableLCA {
  return {
    contents: lca.contents,
    hash: lca.meta.hash,
    mtime: lca.meta.mtime,
    stateVector: uint8ArrayToBase64(lca.stateVector),
  };
}

/**
 * Deserialize a SerializableLCA back to an LCAState.
 */
export function deserializeLCA(lca: SerializableLCA): LCAState {
  return {
    contents: lca.contents,
    meta: {
      hash: lca.hash,
      mtime: lca.mtime,
    },
    stateVector: base64ToUint8Array(lca.stateVector),
  };
}

/**
 * Generate a unique recording ID.
 */
export function generateRecordingId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `rec_${timestamp}_${random}`;
}
