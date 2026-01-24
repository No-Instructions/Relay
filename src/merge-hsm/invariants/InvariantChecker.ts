/**
 * InvariantChecker - Runtime invariant checking for MergeHSM
 *
 * Validates that HSM state matches reality and reports violations.
 *
 * Usage:
 *   const checker = new InvariantChecker(hsm, {
 *     onViolation: (v) => console.warn('Invariant violated:', v),
 *   });
 *
 *   // Check manually
 *   checker.checkAll();
 *
 *   // Or enable automatic checking
 *   checker.startPeriodicChecks();
 */

import type * as Y from 'yjs';
import type { MergeState, StatePath, MergeEvent, SyncStatus } from '../types';
import type { TimeProvider } from '../../TimeProvider';
import type {
  InvariantDefinition,
  InvariantViolation,
  InvariantCheckContext,
  InvariantConfig,
} from './types';
import { DEFAULT_INVARIANT_CONFIG } from './types';
import { STANDARD_INVARIANTS, getInvariantsForState, getInvariantsByTrigger } from './definitions';

// =============================================================================
// Types
// =============================================================================

/**
 * Interface for the HSM to check.
 */
export interface CheckableHSM {
  readonly state: MergeState;
  getLocalDoc(): Y.Doc | null;
  getRemoteDoc(): Y.Doc | null;
  getSyncStatus(): SyncStatus;
  onStateChange(listener: (from: StatePath, to: StatePath, event: MergeEvent) => void): () => void;
}

// =============================================================================
// InvariantChecker Class
// =============================================================================

export class InvariantChecker {
  private readonly hsm: CheckableHSM;
  private readonly config: InvariantConfig;
  private readonly invariants: InvariantDefinition[];
  private readonly timeProvider: TimeProvider;

  // Violations history
  private violations: InvariantViolation[] = [];

  // Last known editor text (updated via external calls)
  private lastEditorText: string | null = null;

  // Last known disk state (updated via external calls)
  private lastDiskContents: string | null = null;

  // Periodic check interval
  private periodicInterval: ReturnType<typeof setInterval> | null = null;

  // State change unsubscribe
  private unsubscribeStateChange: (() => void) | null = null;

  constructor(
    hsm: CheckableHSM,
    config: Partial<InvariantConfig> = {},
    invariants: InvariantDefinition[] = STANDARD_INVARIANTS,
    timeProvider?: TimeProvider
  ) {
    this.hsm = hsm;
    this.config = { ...DEFAULT_INVARIANT_CONFIG, ...config };
    this.invariants = invariants;
    this.timeProvider = timeProvider ?? { now: () => Date.now() };

    // Set up automatic state change checks
    if (this.config.enabled) {
      this.setupStateChangeListener();
    }
  }

  // ===========================================================================
  // External State Updates
  // ===========================================================================

  /**
   * Update the last known editor text.
   * Called by integration layer when editor content changes.
   */
  updateEditorText(text: string): void {
    this.lastEditorText = text;
  }

  /**
   * Update the last known disk contents.
   * Called by integration layer when disk content is read.
   */
  updateDiskContents(contents: string): void {
    this.lastDiskContents = contents;
  }

  // ===========================================================================
  // Checking API
  // ===========================================================================

  /**
   * Check all applicable invariants for current state.
   */
  checkAll(): InvariantViolation[] {
    if (!this.config.enabled) {
      return [];
    }

    const context = this.buildContext();
    const applicableInvariants = getInvariantsForState(
      this.hsm.state.statePath,
      this.invariants
    );

    const newViolations: InvariantViolation[] = [];

    for (const invariant of applicableInvariants) {
      const violation = invariant.check(context);
      if (violation) {
        newViolations.push(violation);
        this.handleViolation(violation);
      }
    }

    return newViolations;
  }

  /**
   * Check a specific invariant by ID.
   */
  checkOne(invariantId: string): InvariantViolation | null {
    if (!this.config.enabled) {
      return null;
    }

    const invariant = this.invariants.find((inv) => inv.id === invariantId);
    if (!invariant) {
      return null;
    }

    const context = this.buildContext();
    const violation = invariant.check(context);

    if (violation) {
      this.handleViolation(violation);
    }

    return violation;
  }

  /**
   * Check invariants triggered by a specific event.
   */
  checkForEvent(eventType: string): InvariantViolation[] {
    if (!this.config.enabled) {
      return [];
    }

    const context = this.buildContext();
    const eventInvariants = getInvariantsByTrigger('on-event', this.invariants).filter(
      (inv) => inv.triggerEvents?.includes(eventType)
    );

    const newViolations: InvariantViolation[] = [];

    for (const invariant of eventInvariants) {
      const violation = invariant.check(context);
      if (violation) {
        newViolations.push(violation);
        this.handleViolation(violation);
      }
    }

    return newViolations;
  }

  // ===========================================================================
  // Periodic Checking
  // ===========================================================================

  /**
   * Start periodic invariant checks.
   */
  startPeriodicChecks(): void {
    if (this.periodicInterval) {
      return; // Already running
    }

    const interval = this.config.periodicInterval ?? 5000;
    this.periodicInterval = setInterval(() => {
      this.checkPeriodic();
    }, interval);
  }

  /**
   * Stop periodic checks.
   */
  stopPeriodicChecks(): void {
    if (this.periodicInterval) {
      clearInterval(this.periodicInterval);
      this.periodicInterval = null;
    }
  }

  private checkPeriodic(): void {
    if (!this.config.enabled) {
      return;
    }

    const context = this.buildContext();
    const periodicInvariants = getInvariantsByTrigger('periodic', this.invariants);

    for (const invariant of periodicInvariants) {
      // Also check if applicable to current state
      if (
        invariant.applicableStates &&
        invariant.applicableStates.length > 0 &&
        !invariant.applicableStates.some((s) => context.statePath.startsWith(s))
      ) {
        continue;
      }

      const violation = invariant.check(context);
      if (violation) {
        this.handleViolation(violation);
      }
    }
  }

  // ===========================================================================
  // Violations API
  // ===========================================================================

  /**
   * Get all recorded violations.
   */
  getViolations(): InvariantViolation[] {
    return [...this.violations];
  }

  /**
   * Get violations by severity.
   */
  getViolationsBySeverity(severity: InvariantViolation['severity']): InvariantViolation[] {
    return this.violations.filter((v) => v.severity === severity);
  }

  /**
   * Get violations by invariant ID.
   */
  getViolationsByInvariant(invariantId: string): InvariantViolation[] {
    return this.violations.filter((v) => v.invariantId === invariantId);
  }

  /**
   * Clear all recorded violations.
   */
  clearViolations(): void {
    this.violations = [];
  }

  /**
   * Check if any violations have occurred.
   */
  hasViolations(): boolean {
    return this.violations.length > 0;
  }

  /**
   * Get violation count.
   */
  getViolationCount(): number {
    return this.violations.length;
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Enable or disable checking.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;

    if (enabled && !this.unsubscribeStateChange) {
      this.setupStateChangeListener();
    } else if (!enabled && this.unsubscribeStateChange) {
      this.unsubscribeStateChange();
      this.unsubscribeStateChange = null;
    }
  }

  /**
   * Check if enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.stopPeriodicChecks();
    this.unsubscribeStateChange?.();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private buildContext(): InvariantCheckContext {
    const state = this.hsm.state;
    const localDoc = this.hsm.getLocalDoc();
    const remoteDoc = this.hsm.getRemoteDoc();
    const syncStatus = this.hsm.getSyncStatus();

    return {
      statePath: state.statePath,
      localDocText: localDoc?.getText('content').toString() ?? null,
      remoteDocText: remoteDoc?.getText('content').toString() ?? null,
      editorText: this.lastEditorText,
      disk: {
        hash: state.disk?.hash ?? null,
        mtime: state.disk?.mtime ?? null,
        contents: this.lastDiskContents ?? undefined,
      },
      lca: {
        hash: state.lca?.meta.hash ?? null,
        mtime: state.lca?.meta.mtime ?? null,
        contents: state.lca?.contents ?? null,
      },
      syncStatus: syncStatus.status,
      now: () => this.timeProvider.now(),
    };
  }

  private setupStateChangeListener(): void {
    this.unsubscribeStateChange = this.hsm.onStateChange((from, to, event) => {
      this.checkOnStateChange(from, to, event);
    });
  }

  private checkOnStateChange(from: StatePath, to: StatePath, event: MergeEvent): void {
    if (!this.config.enabled) {
      return;
    }

    const context = this.buildContext();

    // Check 'always' invariants
    const alwaysInvariants = getInvariantsByTrigger('always', this.invariants);
    for (const invariant of alwaysInvariants) {
      const violation = invariant.check(context);
      if (violation) {
        this.handleViolation(violation);
      }
    }

    // Check 'on-state' invariants for the new state
    const stateInvariants = getInvariantsByTrigger('on-state', this.invariants).filter(
      (inv) =>
        !inv.applicableStates ||
        inv.applicableStates.length === 0 ||
        inv.applicableStates.some((s) => to === s || to.startsWith(s + '.'))
    );

    for (const invariant of stateInvariants) {
      const violation = invariant.check(context);
      if (violation) {
        this.handleViolation(violation);
      }
    }
  }

  private handleViolation(violation: InvariantViolation): void {
    // Store violation
    this.violations.push(violation);

    // Enforce max violations
    if (this.violations.length > (this.config.maxViolations ?? 100)) {
      this.violations.shift();
    }

    // Log to console if enabled
    if (this.config.logToConsole) {
      const prefix = `[Invariant] [${violation.severity.toUpperCase()}]`;
      console.warn(`${prefix} ${violation.invariantId}: ${violation.message}`);
    }

    // Call callback if provided
    this.config.onViolation?.(violation);

    // Throw if configured
    if (this.config.throwOnViolation) {
      const severityOrder = ['warning', 'error', 'critical'];
      const throwIndex = severityOrder.indexOf(this.config.throwSeverity);
      const violationIndex = severityOrder.indexOf(violation.severity);

      if (violationIndex >= throwIndex) {
        throw new Error(
          `Invariant violation [${violation.severity}]: ${violation.message}`
        );
      }
    }
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an InvariantChecker that logs warnings to console.
 */
export function createLoggingChecker(
  hsm: CheckableHSM,
  timeProvider?: TimeProvider
): InvariantChecker {
  return new InvariantChecker(
    hsm,
    { logToConsole: true, throwOnViolation: false },
    STANDARD_INVARIANTS,
    timeProvider
  );
}

/**
 * Create an InvariantChecker that throws on critical violations.
 */
export function createStrictChecker(
  hsm: CheckableHSM,
  timeProvider?: TimeProvider
): InvariantChecker {
  return new InvariantChecker(
    hsm,
    { logToConsole: true, throwOnViolation: true, throwSeverity: 'critical' },
    STANDARD_INVARIANTS,
    timeProvider
  );
}

/**
 * Create an InvariantChecker for testing (throws on any violation).
 */
export function createTestChecker(
  hsm: CheckableHSM,
  timeProvider?: TimeProvider
): InvariantChecker {
  return new InvariantChecker(
    hsm,
    { logToConsole: false, throwOnViolation: true, throwSeverity: 'warning' },
    STANDARD_INVARIANTS,
    timeProvider
  );
}
