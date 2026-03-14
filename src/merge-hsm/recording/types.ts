/**
 * HSM Recording Types
 *
 * Types for recording and replaying MergeHSM event/effect traces.
 * Used for:
 * - Harvesting integration test scenarios into unit tests
 * - Shadow mode comparison
 * - Debugging and visualization
 */

import type * as Y from 'yjs';
import type {
  MergeState,
  MergeEvent,
  MergeEffect,
  StatePath,
  SyncStatus,
  SerializableSnapshot,
  LCAState,
  MergeMetadata,
} from '../types';

// =============================================================================
// HSM Interface for Replay
// =============================================================================

/**
 * Interface for an HSM that can be used in replay.
 * MergeHSM implements this interface.
 */
export interface RecordableHSM {
  readonly state: MergeState;
  send(event: MergeEvent): void;
  matches(statePath: string): boolean;
  getLocalDoc(): Y.Doc | null;
  getLocalDocLength(): Promise<number>;
  getRemoteDoc(): Y.Doc | null;
  getSyncStatus(): SyncStatus;
  checkAndCorrectDrift(actualEditorText?: string): boolean;
  subscribe(listener: (effect: MergeEffect) => void): () => void;
  onStateChange(listener: (from: StatePath, to: StatePath, event: MergeEvent) => void): () => void;
}

// =============================================================================
// Recording Types
// =============================================================================

/**
 * A single entry in the HSM recording timeline.
 * Captures an event sent to the HSM, the resulting state transition,
 * and any effects emitted.
 */
export interface HSMTimelineEntry {
  /** Sequence number (0-indexed) */
  seq: number;

  /** Timestamp when event was sent (ms since epoch or mock time) */
  timestamp: number;

  /** The event that was sent */
  event: SerializableEvent;

  /** State path before the event */
  statePathBefore: StatePath;

  /** State path after the event */
  statePathAfter: StatePath;

  /** Effects emitted as a result of this event */
  effects: SerializableEffect[];

  /** Snapshot after the event (optional, can be expensive) */
  snapshotAfter?: SerializableSnapshot;
}

/**
 * Complete recording of an HSM session.
 * Contains all events, state transitions, and effects.
 */
export interface HSMRecording {
  /** Recording format version */
  version: 1;

  /** Unique recording ID */
  id: string;

  /** Human-readable name/description */
  name: string;

  /** When recording started (ISO string) */
  startedAt: string;

  /** When recording ended (ISO string) */
  endedAt: string;

  /** Document info */
  document: {
    guid: string;
    path: string;
  };

  /** Initial state when recording started */
  initialState: {
    statePath: StatePath;
    snapshot: SerializableSnapshot;
  };

  /** Timeline of events and effects */
  timeline: HSMTimelineEntry[];

  /** Metadata about the recording */
  metadata: RecordingMetadata;
}

/**
 * Metadata about the recording context.
 */
export interface RecordingMetadata {
  /** Source of recording (e.g., 'e2e-test', 'manual', 'shadow-mode') */
  source: 'e2e-test' | 'integration-test' | 'unit-test' | 'manual' | 'shadow-mode';

  /** Test name if from a test */
  testName?: string;

  /** Test file path if from a test */
  testFile?: string;

  /** Additional tags for filtering/categorization */
  tags?: string[];

  /** Any custom data */
  custom?: Record<string, unknown>;
}

// =============================================================================
// Serializable Event/Effect Types
// =============================================================================

/**
 * Serializable event with all Uint8Array fields encoded as base64.
 * Extends the basic SerializableEvent from types.ts with full typing.
 */
export type SerializableEvent =
  | { type: 'LOAD'; guid: string }
  | { type: 'UNLOAD' }
  | { type: 'ACQUIRE_LOCK'; editorContent: string }
  | { type: 'RELEASE_LOCK' }
  | { type: 'DISK_CHANGED'; contents: string; mtime: number; hash: string }
  | { type: 'REMOTE_UPDATE'; update: string } // base64
  | { type: 'SAVE_COMPLETE'; mtime: number; hash: string }
  | { type: 'CM6_CHANGE'; changes: Array<{ from: number; to: number; insert: string }>; docText: string; isFromYjs: boolean }
  | { type: 'PROVIDER_SYNCED' }
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'RESOLVE'; contents: string }
  | { type: 'DISMISS_CONFLICT' }
  | { type: 'OPEN_DIFF_VIEW' }
  | { type: 'CANCEL' }
  | { type: 'PERSISTENCE_LOADED'; updates: string; lca: SerializableLCA | null } // updates is base64
  | { type: 'PERSISTENCE_SYNCED'; hasContent: boolean }
  | { type: 'MERGE_SUCCESS'; newLCA: SerializableLCA }
  | { type: 'MERGE_CONFLICT'; base: string; ours: string; theirs: string }
  | { type: 'REMOTE_DOC_UPDATED' }
  | { type: 'ERROR'; error: string } // error message
  | { type: 'IDLE_MERGE_COMPLETE'; success: true; source: string; newLCA: SerializableLCA }
  | { type: 'IDLE_MERGE_COMPLETE'; success: false; source: string; error?: string };

/**
 * Serializable effect with all Uint8Array fields encoded as base64.
 */
export type SerializableEffect =
  | { type: 'DISPATCH_CM6'; changes: Array<{ from: number; to: number; insert: string }> }
  | { type: 'WRITE_DISK'; guid: string; contents: string }
  | { type: 'PERSIST_STATE'; guid: string; state: SerializablePersistedState }
  | { type: 'SYNC_TO_REMOTE'; update: string } // base64
  | { type: 'STATUS_CHANGED'; guid: string; status: SerializableSyncStatus };

/**
 * Serializable LCA state.
 */
export interface SerializableLCA {
  contents: string;
  hash: string;
  mtime: number;
  stateVector: string; // base64
}

/**
 * Serializable persisted state.
 */
export interface SerializablePersistedState {
  guid: string;
  path: string;
  lca: SerializableLCA | null;
  disk: MergeMetadata | null;
  localStateVector: string | null; // base64
  lastStatePath: StatePath;
  deferredConflict?: { diskHash: string; localHash: string };
  persistedAt: number;
}

/**
 * Serializable sync status.
 */
export interface SerializableSyncStatus {
  guid: string;
  status: 'synced' | 'pending' | 'conflict' | 'error';
  diskMtime: number;
  localStateVector: string; // base64
  remoteStateVector: string; // base64
}

// =============================================================================
// Recording Options
// =============================================================================

/**
 * Options for controlling recording behavior.
 */
export interface RecordingOptions {
  /** Whether to capture full snapshots after each event (expensive) */
  captureSnapshots?: boolean;

  /** Maximum number of timeline entries to keep (for memory limits) */
  maxEntries?: number;

  /** Filter function to selectively record events */
  eventFilter?: (event: MergeEvent) => boolean;

  /** Recording metadata */
  metadata?: Partial<RecordingMetadata>;
}

// =============================================================================
// Log Entry (unified format for disk JSONL + replay)
// =============================================================================

/**
 * A single HSM log entry — the unified format used for disk recording (JSONL)
 * and for replay-based testing. Replaces both StreamingEntry and HSMTimelineEntry.
 */
export interface HSMLogEntry {
  ns: 'mergeHSM';
  ts: string;              // ISO timestamp
  boot?: string;           // Boot ID (added by recordHSMEntry)
  guid: string;
  path: string;
  seq: number;             // Per-document sequence number
  event: SerializableEvent;
  from: string;            // StatePath before
  to: string;              // StatePath after
  effects: SerializableEffect[];
}

// =============================================================================
// Recording Summary (returned by stopRecording v2)
// =============================================================================

/**
 * Lightweight summary returned by stopRecording().
 * The full event data lives in the JSONL log; this is just stats.
 */
export interface RecordingSummary {
  version: 2;
  id: string;
  name: string;
  startedAt: string;
  endedAt: string;
  documents: Array<{
    guid: string;
    path: string;
    eventCount: number;
    eventCounts: Record<string, number>;
    initialStatePath: string;
    finalStatePath: string;
  }>;
}

// =============================================================================
// Replay Types
// =============================================================================

/**
 * Result of replaying a recording.
 */
export interface ReplayResult {
  /** Whether replay completed successfully */
  success: boolean;

  /** Number of events replayed */
  eventsReplayed: number;

  /** Divergences found (if any) */
  divergences: ReplayDivergence[];

  /** Final state path */
  finalStatePath: StatePath;

  /** All effects emitted during replay */
  allEffects: SerializableEffect[];
}

/**
 * A divergence between recorded and replayed behavior.
 */
export interface ReplayDivergence {
  /** Sequence number where divergence occurred */
  seq: number;

  /** Type of divergence */
  type: 'state-mismatch' | 'effect-mismatch' | 'effect-count-mismatch';

  /** Expected value (from recording) */
  expected: unknown;

  /** Actual value (from replay) */
  actual: unknown;

  /** Human-readable description */
  message: string;
}
