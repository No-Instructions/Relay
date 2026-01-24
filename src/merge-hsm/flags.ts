/**
 * MergeHSM Feature Flags
 *
 * Convenient helpers for checking MergeHSM feature flags.
 *
 * Usage:
 *   import { hsmFlags, isHSMEnabled, withHSM } from './merge-hsm/flags';
 *
 *   if (isHSMEnabled()) {
 *     // Use HSM
 *   }
 *
 *   withHSM(() => {
 *     // HSM-specific code
 *   }, () => {
 *     // Fallback to old system
 *   });
 */

import { flags, withFlag } from '../flagManager';
import { flag } from '../flags';

// =============================================================================
// Flag Checks
// =============================================================================

/**
 * Check if MergeHSM is enabled (master flag).
 */
export function isHSMEnabled(): boolean {
  return flags().enableMergeHSM;
}

/**
 * Check if HSM idle mode is enabled.
 * Requires master flag.
 */
export function isHSMIdleModeEnabled(): boolean {
  return flags().enableMergeHSM && flags().enableMergeHSMIdleMode;
}

/**
 * Check if HSM conflict detection is enabled.
 * Requires master flag.
 */
export function isHSMConflictDetectionEnabled(): boolean {
  return flags().enableMergeHSM && flags().enableMergeHSMConflictDetection;
}

/**
 * Check if HSM active mode is enabled.
 * Requires master flag.
 */
export function isHSMActiveModeEnabled(): boolean {
  return flags().enableMergeHSM && flags().enableMergeHSMActiveMode;
}

/**
 * Check if HSM shadow mode is enabled.
 * Shadow mode can run independently of HSM being fully enabled.
 */
export function isHSMShadowModeEnabled(): boolean {
  return flags().enableMergeHSMShadowMode;
}

/**
 * Check if HSM invariant checking is enabled.
 */
export function isHSMInvariantChecksEnabled(): boolean {
  return flags().enableMergeHSMInvariantChecks;
}

/**
 * Check if HSM recording is enabled.
 */
export function isHSMRecordingEnabled(): boolean {
  return flags().enableMergeHSMRecording;
}

/**
 * Check if HSM debugger is enabled.
 */
export function isHSMDebuggerEnabled(): boolean {
  return flags().enableMergeHSMDebugger;
}

// =============================================================================
// Conditional Execution
// =============================================================================

/**
 * Execute code if HSM is enabled, otherwise run fallback.
 */
export function withHSM(fn: () => void, fallback: () => void = () => {}): void {
  withFlag(flag.enableMergeHSM, fn, fallback);
}

/**
 * Execute code if HSM idle mode is enabled.
 */
export function withHSMIdleMode(fn: () => void, fallback: () => void = () => {}): void {
  if (isHSMIdleModeEnabled()) {
    fn();
  } else {
    fallback();
  }
}

/**
 * Execute code if HSM active mode is enabled.
 */
export function withHSMActiveMode(fn: () => void, fallback: () => void = () => {}): void {
  if (isHSMActiveModeEnabled()) {
    fn();
  } else {
    fallback();
  }
}

/**
 * Execute code if HSM shadow mode is enabled.
 */
export function withHSMShadowMode(fn: () => void): void {
  if (isHSMShadowModeEnabled()) {
    fn();
  }
}

// =============================================================================
// Flag Object (for type-safe flag access)
// =============================================================================

/**
 * MergeHSM-specific flags.
 */
export const hsmFlags = {
  master: flag.enableMergeHSM,
  idleMode: flag.enableMergeHSMIdleMode,
  conflictDetection: flag.enableMergeHSMConflictDetection,
  activeMode: flag.enableMergeHSMActiveMode,
  shadowMode: flag.enableMergeHSMShadowMode,
  invariantChecks: flag.enableMergeHSMInvariantChecks,
  recording: flag.enableMergeHSMRecording,
  debugger: flag.enableMergeHSMDebugger,
} as const;

// =============================================================================
// Feature Matrix
// =============================================================================

/**
 * Current feature enablement status.
 */
export interface HSMFeatureStatus {
  master: boolean;
  idleMode: boolean;
  conflictDetection: boolean;
  activeMode: boolean;
  shadowMode: boolean;
  invariantChecks: boolean;
  recording: boolean;
  debugger: boolean;
}

/**
 * Get current HSM feature status.
 */
export function getHSMFeatureStatus(): HSMFeatureStatus {
  const f = flags();
  return {
    master: f.enableMergeHSM,
    idleMode: f.enableMergeHSM && f.enableMergeHSMIdleMode,
    conflictDetection: f.enableMergeHSM && f.enableMergeHSMConflictDetection,
    activeMode: f.enableMergeHSM && f.enableMergeHSMActiveMode,
    shadowMode: f.enableMergeHSMShadowMode,
    invariantChecks: f.enableMergeHSMInvariantChecks,
    recording: f.enableMergeHSMRecording,
    debugger: f.enableMergeHSMDebugger,
  };
}

/**
 * Log current HSM feature status (for debugging).
 */
export function logHSMFeatureStatus(): void {
  const status = getHSMFeatureStatus();
  console.log('[MergeHSM] Feature Status:', status);
}
