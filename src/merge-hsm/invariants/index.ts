/**
 * Invariants Module
 *
 * Runtime invariant checking for MergeHSM.
 *
 * Usage:
 *   import { InvariantChecker, createLoggingChecker } from './invariants';
 *
 *   const checker = createLoggingChecker(hsm);
 *   checker.updateEditorText(editorText);
 *   checker.checkAll();
 */

// Types
export type {
  InvariantDefinition,
  InvariantCheckContext,
  InvariantCheckFn,
  InvariantViolation,
  InvariantConfig,
  InvariantSeverity,
  InvariantTrigger,
} from './types';
export { DEFAULT_INVARIANT_CONFIG } from './types';

// Definitions
export {
  EDITOR_MATCHES_LOCAL_DOC,
  LOCAL_NOT_BEHIND_REMOTE,
  SYNCED_MEANS_DISK_MATCHES_LCA,
  DISK_NOT_OLDER_THAN_LCA,
  ACTIVE_HAS_LOCAL_DOC,
  IDLE_NO_LOCAL_DOC,
  CONFLICT_HAS_DIVERGENCE,
  STANDARD_INVARIANTS,
  getInvariantsForState,
  getInvariantsByTrigger,
} from './definitions';

// Checker
export {
  InvariantChecker,
  createLoggingChecker,
  createStrictChecker,
  createTestChecker,
} from './InvariantChecker';
export type { CheckableHSM } from './InvariantChecker';
