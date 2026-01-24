/**
 * ShadowMergeHSM - HSM running in shadow mode
 *
 * Wraps a MergeHSM instance and captures all effects without executing them.
 * Effects are collected for comparison with old system actions.
 *
 * Usage:
 *   const shadowHSM = new ShadowMergeHSM(hsmConfig, { logToConsole: true });
 *
 *   // Mirror events from old system
 *   oldSystem.onEvent((event) => {
 *     shadowHSM.send(event);
 *   });
 *
 *   // Report old system actions for comparison
 *   oldSystem.onAction((action) => {
 *     shadowHSM.reportOldSystemAction(action);
 *   });
 */

import * as Y from 'yjs';
import type {
  MergeState,
  MergeEvent,
  MergeEffect,
  StatePath,
  SyncStatus,
  MergeHSMConfig,
} from '../types';
import type { TimeProvider } from '../../TimeProvider';
import { MergeHSM } from '../MergeHSM';
import type { RecordableHSM } from '../recording';
import { serializeEffect } from '../recording';
import type { SerializableEffect } from '../recording';
import type {
  OldSystemAction,
  ShadowDivergence,
  ShadowModeConfig,
  ShadowDocumentState,
  DivergenceType,
  DivergenceSeverity,
  ComparisonResult,
} from './types';

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: ShadowModeConfig = {
  enabled: true,
  logToConsole: false,
  persistDivergences: false,
  maxDivergences: 1000,
  minSeverity: 'info',
};

// =============================================================================
// ShadowMergeHSM Class
// =============================================================================

export class ShadowMergeHSM implements RecordableHSM {
  private readonly hsm: MergeHSM;
  private readonly config: ShadowModeConfig;
  private readonly timeProvider: TimeProvider;

  // Collected effects (not executed)
  private pendingEffects: MergeEffect[] = [];

  // Old system actions for comparison
  private pendingOldActions: OldSystemAction[] = [];

  // Divergences detected
  private divergences: ShadowDivergence[] = [];

  // Statistics
  private eventsProcessed = 0;
  private divergenceCount = 0;

  // Subscriptions
  private unsubscribeEffects: (() => void) | null = null;

  constructor(
    hsmConfig: MergeHSMConfig,
    shadowConfig: Partial<ShadowModeConfig> = {},
    timeProvider?: TimeProvider
  ) {
    this.config = { ...DEFAULT_CONFIG, ...shadowConfig };
    this.timeProvider = timeProvider ?? { now: () => Date.now() };

    // Create the underlying HSM
    this.hsm = new MergeHSM(hsmConfig);

    // Capture effects without executing them
    this.unsubscribeEffects = this.hsm.subscribe((effect) => {
      this.pendingEffects.push(effect);
    });
  }

  // ===========================================================================
  // HSM Delegation (implements RecordableHSM)
  // ===========================================================================

  get state(): MergeState {
    return this.hsm.state;
  }

  /**
   * Send an event to the shadow HSM.
   * Effects are captured but not executed.
   */
  send(event: MergeEvent): void {
    if (!this.config.enabled) {
      return;
    }

    // Clear pending effects for this event
    this.pendingEffects = [];

    // Send to underlying HSM
    this.hsm.send(event);

    this.eventsProcessed++;

    // If we have pending old actions, try to compare
    this.tryCompare();
  }

  matches(statePath: string): boolean {
    return this.hsm.matches(statePath);
  }

  getLocalDoc(): Y.Doc | null {
    return this.hsm.getLocalDoc();
  }

  getRemoteDoc(): Y.Doc | null {
    return this.hsm.getRemoteDoc();
  }

  getSyncStatus(): SyncStatus {
    return this.hsm.getSyncStatus();
  }

  checkAndCorrectDrift(): boolean {
    return this.hsm.checkAndCorrectDrift();
  }

  subscribe(listener: (effect: MergeEffect) => void): () => void {
    // Shadow mode doesn't propagate effects to external listeners
    // (effects are captured internally, not executed)
    return () => {};
  }

  onStateChange(
    listener: (from: StatePath, to: StatePath, event: MergeEvent) => void
  ): () => void {
    return this.hsm.onStateChange(listener);
  }

  // ===========================================================================
  // Shadow Mode API
  // ===========================================================================

  /**
   * Report an action taken by the old system.
   * Used for comparison with HSM effects.
   */
  reportOldSystemAction(action: OldSystemAction): void {
    if (!this.config.enabled) {
      return;
    }

    this.pendingOldActions.push(action);
    this.tryCompare();
  }

  /**
   * Report multiple actions from old system.
   */
  reportOldSystemActions(actions: OldSystemAction[]): void {
    for (const action of actions) {
      this.reportOldSystemAction(action);
    }
  }

  /**
   * Get all divergences detected.
   */
  getDivergences(): ShadowDivergence[] {
    return [...this.divergences];
  }

  /**
   * Get divergences filtered by type.
   */
  getDivergencesByType(type: DivergenceType): ShadowDivergence[] {
    return this.divergences.filter((d) => d.type === type);
  }

  /**
   * Get divergences filtered by severity.
   */
  getDivergencesBySeverity(severity: DivergenceSeverity): ShadowDivergence[] {
    return this.divergences.filter((d) => d.severity === severity);
  }

  /**
   * Clear collected divergences.
   */
  clearDivergences(): void {
    this.divergences = [];
    this.divergenceCount = 0;
  }

  /**
   * Get current shadow state.
   */
  getDocumentState(): ShadowDocumentState {
    const state = this.hsm.state;
    const syncStatus = this.hsm.getSyncStatus();

    return {
      guid: state.guid,
      path: state.path,
      hsmStatePath: state.statePath,
      hsmSyncStatus: syncStatus.status,
      oldSystemState: {
        userLock: false, // Set by caller
        tracking: false,
        hasDiskBuffer: false,
        hasPendingOps: false,
        synced: true,
        connected: true,
      },
      pendingEffects: this.pendingEffects.map(serializeEffect),
      pendingActions: [...this.pendingOldActions],
      recentDivergences: this.divergences.slice(-10),
    };
  }

  /**
   * Get statistics.
   */
  getStats(): {
    eventsProcessed: number;
    divergenceCount: number;
    agreementRate: number;
  } {
    const agreementRate =
      this.eventsProcessed > 0
        ? (this.eventsProcessed - this.divergenceCount) / this.eventsProcessed
        : 1;

    return {
      eventsProcessed: this.eventsProcessed,
      divergenceCount: this.divergenceCount,
      agreementRate,
    };
  }

  /**
   * Force comparison of pending effects and actions.
   */
  forceCompare(): ComparisonResult {
    return this.compareEffectsAndActions();
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.unsubscribeEffects?.();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private tryCompare(): void {
    // Only compare when we have both effects and actions
    if (this.pendingEffects.length === 0 && this.pendingOldActions.length === 0) {
      return;
    }

    // For now, compare immediately
    // In production, might want to debounce or batch
    this.compareEffectsAndActions();
  }

  private compareEffectsAndActions(): ComparisonResult {
    const serializedEffects = this.pendingEffects.map(serializeEffect);
    const result = this.performComparison(serializedEffects, this.pendingOldActions);

    // Record divergences
    for (const divergence of result.divergences) {
      this.recordDivergence(divergence);
    }

    // Clear pending
    this.pendingEffects = [];
    this.pendingOldActions = [];

    return result;
  }

  private performComparison(
    hsmEffects: SerializableEffect[],
    oldActions: OldSystemAction[]
  ): ComparisonResult {
    const divergences: ShadowDivergence[] = [];
    const matched: { hsmEffect: SerializableEffect; oldAction: OldSystemAction }[] = [];
    const unmatchedEffects: SerializableEffect[] = [];
    const unmatchedActions: OldSystemAction[] = [...oldActions];

    // Try to match HSM effects with old system actions
    for (const effect of hsmEffects) {
      const matchIndex = this.findMatchingAction(effect, unmatchedActions);

      if (matchIndex !== -1) {
        matched.push({
          hsmEffect: effect,
          oldAction: unmatchedActions[matchIndex],
        });
        unmatchedActions.splice(matchIndex, 1);
      } else {
        unmatchedEffects.push(effect);
      }
    }

    // Create divergences for unmatched effects
    for (const effect of unmatchedEffects) {
      divergences.push(this.createDivergenceForEffect(effect));
    }

    // Create divergences for unmatched actions
    for (const action of unmatchedActions) {
      divergences.push(this.createDivergenceForAction(action));
    }

    return {
      match: divergences.length === 0,
      divergences,
      matched,
      unmatchedHsmEffects: unmatchedEffects,
      unmatchedOldActions: unmatchedActions,
    };
  }

  private findMatchingAction(
    effect: SerializableEffect,
    actions: OldSystemAction[]
  ): number {
    // Map HSM effects to old system action types
    const mapping: Record<string, string[]> = {
      WRITE_DISK: ['WRITE_DISK'],
      DISPATCH_CM6: ['DISPATCH_EDITOR'],
      SYNC_TO_REMOTE: ['SYNC_TO_REMOTE'],
      STATUS_CHANGED: [], // No direct mapping
      PERSIST_STATE: [], // No direct mapping
      PERSIST_UPDATES: [], // No direct mapping
    };

    const expectedActionTypes = mapping[effect.type] ?? [];

    return actions.findIndex((action) => {
      if (!expectedActionTypes.includes(action.type)) {
        return false;
      }

      // Additional matching logic based on type
      if (effect.type === 'WRITE_DISK' && action.type === 'WRITE_DISK') {
        return effect.path === action.path;
      }

      return true;
    });
  }

  private createDivergenceForEffect(effect: SerializableEffect): ShadowDivergence {
    const state = this.hsm.state;

    return {
      id: this.generateDivergenceId(),
      timestamp: this.timeProvider.now(),
      document: { guid: state.guid, path: state.path },
      type: this.classifyEffectDivergence(effect),
      severity: this.classifyEffectSeverity(effect),
      message: `HSM would emit ${effect.type} but old system did not`,
      hsmBehavior: {
        statePath: state.statePath,
        effects: [effect],
        wouldShowConflict: state.statePath.includes('conflict'),
      },
      oldSystemBehavior: {
        actions: [],
        showedConflict: false,
        tracking: false,
        userLock: false,
      },
    };
  }

  private createDivergenceForAction(action: OldSystemAction): ShadowDivergence {
    const state = this.hsm.state;

    return {
      id: this.generateDivergenceId(),
      timestamp: this.timeProvider.now(),
      document: { guid: state.guid, path: state.path },
      type: this.classifyActionDivergence(action),
      severity: this.classifyActionSeverity(action),
      message: `Old system performed ${action.type} but HSM did not emit corresponding effect`,
      hsmBehavior: {
        statePath: state.statePath,
        effects: [],
        wouldShowConflict: state.statePath.includes('conflict'),
      },
      oldSystemBehavior: {
        actions: [action],
        showedConflict: action.type === 'SHOW_CONFLICT_BANNER',
        tracking: action.type === 'SET_TRACKING' ? (action as any).tracking : false,
        userLock: action.type === 'SET_USER_LOCK' ? (action as any).userLock : false,
      },
    };
  }

  private classifyEffectDivergence(effect: SerializableEffect): DivergenceType {
    switch (effect.type) {
      case 'WRITE_DISK':
        return 'disk-write';
      case 'DISPATCH_CM6':
        return 'editor-dispatch';
      case 'SYNC_TO_REMOTE':
        return 'sync-timing';
      default:
        return 'unknown';
    }
  }

  private classifyActionDivergence(action: OldSystemAction): DivergenceType {
    switch (action.type) {
      case 'WRITE_DISK':
        return 'disk-write';
      case 'DISPATCH_EDITOR':
        return 'editor-dispatch';
      case 'SYNC_TO_REMOTE':
        return 'sync-timing';
      case 'SHOW_CONFLICT_BANNER':
      case 'HIDE_CONFLICT_BANNER':
        return 'banner-visibility';
      case 'CHECK_STALE_TRIGGERED':
        return 'conflict-detection';
      default:
        return 'unknown';
    }
  }

  private classifyEffectSeverity(effect: SerializableEffect): DivergenceSeverity {
    switch (effect.type) {
      case 'WRITE_DISK':
        return 'error'; // Disk writes are important
      case 'DISPATCH_CM6':
        return 'warning'; // Editor changes matter
      case 'SYNC_TO_REMOTE':
        return 'info'; // Timing differences are less critical
      default:
        return 'info';
    }
  }

  private classifyActionSeverity(action: OldSystemAction): DivergenceSeverity {
    switch (action.type) {
      case 'WRITE_DISK':
        return 'error';
      case 'DISPATCH_EDITOR':
        return 'warning';
      case 'SHOW_CONFLICT_BANNER':
        return 'warning'; // User-facing
      default:
        return 'info';
    }
  }

  private recordDivergence(divergence: ShadowDivergence): void {
    // Check minimum severity
    const severityOrder: DivergenceSeverity[] = ['info', 'warning', 'error', 'critical'];
    const minIndex = severityOrder.indexOf(this.config.minSeverity);
    const divergenceIndex = severityOrder.indexOf(divergence.severity);

    if (divergenceIndex < minIndex) {
      return;
    }

    // Store divergence
    this.divergences.push(divergence);
    this.divergenceCount++;

    // Enforce max divergences
    if (this.divergences.length > this.config.maxDivergences) {
      this.divergences.shift();
    }

    // Log to console if enabled
    if (this.config.logToConsole) {
      const prefix = `[Shadow] [${divergence.severity.toUpperCase()}]`;
      console.log(`${prefix} ${divergence.message}`);
    }

    // Call callback if provided
    this.config.onDivergence?.(divergence);
  }

  private generateDivergenceId(): string {
    return `div_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a ShadowMergeHSM with console logging.
 */
export function createLoggingShadow(
  hsmConfig: MergeHSMConfig,
  timeProvider?: TimeProvider
): ShadowMergeHSM {
  return new ShadowMergeHSM(
    hsmConfig,
    { logToConsole: true, minSeverity: 'warning' },
    timeProvider
  );
}

/**
 * Create a ShadowMergeHSM with callback for divergences.
 */
export function createCallbackShadow(
  hsmConfig: MergeHSMConfig,
  onDivergence: (divergence: ShadowDivergence) => void,
  timeProvider?: TimeProvider
): ShadowMergeHSM {
  return new ShadowMergeHSM(
    hsmConfig,
    { onDivergence },
    timeProvider
  );
}
