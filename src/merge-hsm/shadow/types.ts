/**
 * Shadow Mode Types
 *
 * Types for running MergeHSM in shadow mode alongside the existing system.
 * Shadow mode allows us to compare HSM decisions with the old system
 * without affecting user experience.
 */

import type {
  MergeEvent,
  MergeEffect,
  StatePath,
  SyncStatusType,
} from '../types';
import type { SerializableEffect } from '../recording';

// =============================================================================
// Old System Action Types
// =============================================================================

/**
 * Actions that the old system takes.
 * These are captured and compared against HSM effects.
 */
export type OldSystemAction =
  | { type: 'WRITE_DISK'; path: string; contents: string }
  | { type: 'DISPATCH_EDITOR'; changes: Array<{ from: number; to: number; insert: string }> }
  | { type: 'SYNC_TO_REMOTE' }
  | { type: 'SHOW_CONFLICT_BANNER' }
  | { type: 'HIDE_CONFLICT_BANNER' }
  | { type: 'SET_TRACKING'; tracking: boolean }
  | { type: 'SET_USER_LOCK'; userLock: boolean }
  | { type: 'CHECK_STALE_TRIGGERED' }
  | { type: 'PENDING_OPS_APPLIED' }
  | { type: 'DISK_BUFFER_SET'; contents: string }
  | { type: 'DISK_BUFFER_CLEARED' };

/**
 * Serializable old system action (for logging).
 */
export type SerializableOldAction = OldSystemAction;

// =============================================================================
// Divergence Types
// =============================================================================

/**
 * Types of divergences between HSM and old system.
 */
export type DivergenceType =
  | 'conflict-detection' // HSM detected conflict, old system didn't (or vice versa)
  | 'disk-write' // Different disk write behavior
  | 'editor-dispatch' // Different editor dispatch behavior
  | 'sync-timing' // Different timing for remote sync
  | 'banner-visibility' // Different conflict banner visibility
  | 'state-transition' // HSM state doesn't match old system state
  | 'merge-result' // Different merge results
  | 'unknown';

/**
 * Severity of a divergence.
 */
export type DivergenceSeverity =
  | 'info' // Interesting but not concerning
  | 'warning' // Might indicate a problem
  | 'error' // Definite problem, needs investigation
  | 'critical'; // Would cause data loss or corruption

/**
 * A single divergence between HSM and old system behavior.
 */
export interface ShadowDivergence {
  /** Unique ID for this divergence */
  id: string;

  /** When the divergence was detected */
  timestamp: number;

  /** Document this divergence relates to */
  document: {
    guid: string;
    path: string;
  };

  /** Type of divergence */
  type: DivergenceType;

  /** Severity */
  severity: DivergenceSeverity;

  /** Human-readable description */
  message: string;

  /** What the HSM would have done */
  hsmBehavior: {
    statePath: StatePath;
    effects: SerializableEffect[];
    wouldShowConflict: boolean;
  };

  /** What the old system actually did */
  oldSystemBehavior: {
    actions: SerializableOldAction[];
    showedConflict: boolean;
    tracking: boolean;
    userLock: boolean;
  };

  /** The event that triggered this divergence (if any) */
  triggeringEvent?: MergeEvent;

  /** Additional context */
  context?: Record<string, unknown>;
}

// =============================================================================
// Shadow Session Types
// =============================================================================

/**
 * Statistics for a shadow mode session.
 */
export interface ShadowSessionStats {
  /** Session ID */
  sessionId: string;

  /** When session started */
  startedAt: string;

  /** When session ended (if ended) */
  endedAt?: string;

  /** Total events processed */
  eventsProcessed: number;

  /** Divergences by type */
  divergencesByType: Record<DivergenceType, number>;

  /** Divergences by severity */
  divergencesBySeverity: Record<DivergenceSeverity, number>;

  /** Documents tracked */
  documentsTracked: number;

  /** Agreement rate (events without divergence / total events) */
  agreementRate: number;
}

/**
 * Configuration for shadow mode.
 */
export interface ShadowModeConfig {
  /** Whether shadow mode is enabled */
  enabled: boolean;

  /** Log divergences to console */
  logToConsole: boolean;

  /** Store divergences in IndexedDB */
  persistDivergences: boolean;

  /** Maximum divergences to store (per session) */
  maxDivergences: number;

  /** Minimum severity to log/store */
  minSeverity: DivergenceSeverity;

  /** Callback when divergence is detected */
  onDivergence?: (divergence: ShadowDivergence) => void;

  /** Documents to include (empty = all) */
  includeDocuments?: string[];

  /** Documents to exclude */
  excludeDocuments?: string[];
}

// =============================================================================
// Comparison Types
// =============================================================================

/**
 * Result of comparing HSM effects with old system actions.
 */
export interface ComparisonResult {
  /** Whether the behaviors matched */
  match: boolean;

  /** Divergences found (if any) */
  divergences: ShadowDivergence[];

  /** Matched behaviors */
  matched: {
    hsmEffect: SerializableEffect;
    oldAction: SerializableOldAction;
  }[];

  /** HSM effects with no matching old action */
  unmatchedHsmEffects: SerializableEffect[];

  /** Old actions with no matching HSM effect */
  unmatchedOldActions: SerializableOldAction[];
}

/**
 * Mapping between HSM effects and old system actions.
 */
export interface EffectActionMapping {
  /** HSM effect type */
  effectType: MergeEffect['type'];

  /** Corresponding old system action types */
  actionTypes: OldSystemAction['type'][];

  /** Whether this is a required mapping (divergence if missing) */
  required: boolean;

  /** Custom comparator */
  comparator?: (effect: MergeEffect, action: OldSystemAction) => boolean;
}

// =============================================================================
// Shadow Document State
// =============================================================================

/**
 * Per-document shadow state.
 */
export interface ShadowDocumentState {
  /** Document GUID */
  guid: string;

  /** Document path */
  path: string;

  /** HSM instance (shadow) */
  hsmStatePath: StatePath;

  /** Last HSM sync status */
  hsmSyncStatus: SyncStatusType;

  /** Old system state snapshot */
  oldSystemState: {
    userLock: boolean;
    tracking: boolean;
    hasDiskBuffer: boolean;
    hasPendingOps: boolean;
    synced: boolean;
    connected: boolean;
  };

  /** Pending effects from HSM (not yet compared) */
  pendingEffects: SerializableEffect[];

  /** Pending actions from old system (not yet compared) */
  pendingActions: SerializableOldAction[];

  /** Recent divergences for this document */
  recentDivergences: ShadowDivergence[];
}
