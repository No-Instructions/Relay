/**
 * Invariant Types
 *
 * Types for runtime invariant checking in MergeHSM.
 */

import type { StatePath } from '../types';

// =============================================================================
// Invariant Definition Types
// =============================================================================

/**
 * Severity of an invariant violation.
 */
export type InvariantSeverity = 'warning' | 'error' | 'critical';

/**
 * When an invariant should be checked.
 */
export type InvariantTrigger =
  | 'always' // Check on every state change
  | 'periodic' // Check periodically
  | 'on-event' // Check when specific events occur
  | 'on-state' // Check when entering specific states
  | 'manual'; // Only check when explicitly called

/**
 * An invariant definition.
 */
export interface InvariantDefinition {
  /** Unique ID for this invariant */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this invariant checks */
  description: string;

  /** Severity if violated */
  severity: InvariantSeverity;

  /** When to check this invariant */
  trigger: InvariantTrigger;

  /** States in which this invariant applies (empty = all states) */
  applicableStates?: StatePath[];

  /** Events that trigger this check (for 'on-event' trigger) */
  triggerEvents?: string[];

  /** The check function */
  check: InvariantCheckFn;
}

/**
 * Context provided to invariant check functions.
 */
export interface InvariantCheckContext {
  /** Current HSM state path */
  statePath: StatePath;

  /** Local doc text (null if not in active mode) */
  localDocText: string | null;

  /** Remote doc text (null if not in active mode) */
  remoteDocText: string | null;

  /** Last known editor text (from CM6_CHANGE events) */
  editorText: string | null;

  /** Current disk state */
  disk: {
    hash: string | null;
    mtime: number | null;
    contents?: string;
  };

  /** Current LCA state */
  lca: {
    hash: string | null;
    mtime: number | null;
    contents: string | null;
  };

  /** Sync status */
  syncStatus: 'synced' | 'pending' | 'conflict' | 'error';

  /** Time provider */
  now: () => number;
}

/**
 * Function that checks an invariant.
 * Returns null if the invariant holds, or a violation if it doesn't.
 */
export type InvariantCheckFn = (context: InvariantCheckContext) => InvariantViolation | null;

// =============================================================================
// Violation Types
// =============================================================================

/**
 * An invariant violation.
 */
export interface InvariantViolation {
  /** ID of the violated invariant */
  invariantId: string;

  /** Severity */
  severity: InvariantSeverity;

  /** When the violation was detected */
  timestamp: number;

  /** Human-readable message */
  message: string;

  /** Current state path when violation occurred */
  statePath: StatePath;

  /** Expected value (if applicable) */
  expected?: unknown;

  /** Actual value (if applicable) */
  actual?: unknown;

  /** Additional context */
  context?: Record<string, unknown>;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for invariant checking.
 */
export interface InvariantConfig {
  /** Enable invariant checking */
  enabled: boolean;

  /** Throw on violation (vs. just logging) */
  throwOnViolation: boolean;

  /** Minimum severity to throw on */
  throwSeverity: InvariantSeverity;

  /** Log violations to console */
  logToConsole: boolean;

  /** Callback for violations */
  onViolation?: (violation: InvariantViolation) => void;

  /** Interval for periodic checks (ms) */
  periodicInterval?: number;

  /** Maximum violations to store */
  maxViolations?: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_INVARIANT_CONFIG: InvariantConfig = {
  enabled: true,
  throwOnViolation: false,
  throwSeverity: 'critical',
  logToConsole: true,
  periodicInterval: 5000,
  maxViolations: 100,
};
