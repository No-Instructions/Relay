/**
 * ShadowManager - Coordinates shadow mode across multiple documents
 *
 * Manages ShadowMergeHSM instances for all documents in a shared folder.
 * Aggregates divergences and provides reporting capabilities.
 *
 * Usage:
 *   const manager = new ShadowManager(config);
 *
 *   // Register documents
 *   manager.register(guid, path, remoteDoc);
 *
 *   // Mirror events
 *   manager.send(guid, event);
 *
 *   // Report old system actions
 *   manager.reportAction(guid, action);
 *
 *   // Get reports
 *   const report = manager.getReport();
 */

import * as Y from 'yjs';
import type { MergeEvent, MergeHSMConfig } from '../types';
import type { TimeProvider } from '../../TimeProvider';
import { ShadowMergeHSM } from './ShadowMergeHSM';
import type {
  OldSystemAction,
  ShadowDivergence,
  ShadowModeConfig,
  ShadowSessionStats,
  DivergenceType,
  DivergenceSeverity,
} from './types';

// =============================================================================
// Types
// =============================================================================

export interface ShadowManagerConfig extends Partial<ShadowModeConfig> {
  /** Time provider for testing */
  timeProvider?: TimeProvider;

  /** App ID for creating HSM configs */
  appId?: string;
}

export interface ShadowReport {
  /** Session stats */
  stats: ShadowSessionStats;

  /** All divergences (up to limit) */
  divergences: ShadowDivergence[];

  /** Summary by document */
  byDocument: Map<string, DocumentShadowSummary>;

  /** Top issues (most frequent divergence types) */
  topIssues: { type: DivergenceType; count: number }[];
}

export interface DocumentShadowSummary {
  guid: string;
  path: string;
  eventsProcessed: number;
  divergenceCount: number;
  lastDivergence?: ShadowDivergence;
}

// =============================================================================
// ShadowManager Class
// =============================================================================

export class ShadowManager {
  private readonly config: ShadowManagerConfig;
  private readonly shadows: Map<string, ShadowMergeHSM> = new Map();
  private readonly timeProvider: TimeProvider;

  // Aggregated stats
  private sessionId: string;
  private startedAt: string;
  private totalEventsProcessed = 0;
  private allDivergences: ShadowDivergence[] = [];

  constructor(config: ShadowManagerConfig = {}) {
    this.config = {
      enabled: true,
      logToConsole: false,
      persistDivergences: false,
      maxDivergences: 10000,
      minSeverity: 'info',
      ...config,
    };

    this.timeProvider = config.timeProvider ?? { now: () => Date.now() };
    this.sessionId = this.generateSessionId();
    this.startedAt = new Date().toISOString();
  }

  // ===========================================================================
  // Document Registration
  // ===========================================================================

  /**
   * Register a document for shadow tracking.
   */
  register(guid: string, path: string, remoteDoc: Y.Doc): void {
    if (this.shadows.has(guid)) {
      return; // Already registered
    }

    const hsmConfig: MergeHSMConfig = {
      guid,
      path,
      remoteDoc,
      timeProvider: this.timeProvider,
    };

    const shadow = new ShadowMergeHSM(
      hsmConfig,
      {
        ...this.config,
        onDivergence: (div) => this.handleDivergence(div),
      },
      this.timeProvider
    );

    this.shadows.set(guid, shadow);
  }

  /**
   * Unregister a document.
   */
  unregister(guid: string): void {
    const shadow = this.shadows.get(guid);
    if (shadow) {
      shadow.dispose();
      this.shadows.delete(guid);
    }
  }

  /**
   * Check if a document is registered.
   */
  isRegistered(guid: string): boolean {
    return this.shadows.has(guid);
  }

  // ===========================================================================
  // Event/Action API
  // ===========================================================================

  /**
   * Send an event to a document's shadow HSM.
   */
  send(guid: string, event: MergeEvent): void {
    const shadow = this.shadows.get(guid);
    if (!shadow) {
      return;
    }

    shadow.send(event);
    this.totalEventsProcessed++;
  }

  /**
   * Report an old system action for a document.
   */
  reportAction(guid: string, action: OldSystemAction): void {
    const shadow = this.shadows.get(guid);
    if (!shadow) {
      return;
    }

    shadow.reportOldSystemAction(action);
  }

  /**
   * Report multiple actions for a document.
   */
  reportActions(guid: string, actions: OldSystemAction[]): void {
    const shadow = this.shadows.get(guid);
    if (!shadow) {
      return;
    }

    shadow.reportOldSystemActions(actions);
  }

  /**
   * Force comparison for a document.
   */
  forceCompare(guid: string): void {
    const shadow = this.shadows.get(guid);
    if (shadow) {
      shadow.forceCompare();
    }
  }

  /**
   * Force comparison for all documents.
   */
  forceCompareAll(): void {
    for (const shadow of this.shadows.values()) {
      shadow.forceCompare();
    }
  }

  // ===========================================================================
  // Reporting
  // ===========================================================================

  /**
   * Get comprehensive shadow report.
   */
  getReport(): ShadowReport {
    const byDocument = new Map<string, DocumentShadowSummary>();
    const divergencesByType = new Map<DivergenceType, number>();

    // Aggregate by document
    for (const [guid, shadow] of this.shadows) {
      const state = shadow.getDocumentState();
      const stats = shadow.getStats();
      const divergences = shadow.getDivergences();

      byDocument.set(guid, {
        guid,
        path: state.path,
        eventsProcessed: stats.eventsProcessed,
        divergenceCount: stats.divergenceCount,
        lastDivergence: divergences[divergences.length - 1],
      });

      // Count by type
      for (const div of divergences) {
        divergencesByType.set(
          div.type,
          (divergencesByType.get(div.type) ?? 0) + 1
        );
      }
    }

    // Sort top issues by count
    const topIssues = Array.from(divergencesByType.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    return {
      stats: this.getSessionStats(),
      divergences: this.allDivergences.slice(-this.config.maxDivergences!),
      byDocument,
      topIssues,
    };
  }

  /**
   * Get session statistics.
   */
  getSessionStats(): ShadowSessionStats {
    const divergencesByType: Record<DivergenceType, number> = {
      'conflict-detection': 0,
      'disk-write': 0,
      'editor-dispatch': 0,
      'sync-timing': 0,
      'banner-visibility': 0,
      'state-transition': 0,
      'merge-result': 0,
      'unknown': 0,
    };

    const divergencesBySeverity: Record<DivergenceSeverity, number> = {
      'info': 0,
      'warning': 0,
      'error': 0,
      'critical': 0,
    };

    for (const div of this.allDivergences) {
      divergencesByType[div.type]++;
      divergencesBySeverity[div.severity]++;
    }

    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      eventsProcessed: this.totalEventsProcessed,
      divergencesByType,
      divergencesBySeverity,
      documentsTracked: this.shadows.size,
      agreementRate:
        this.totalEventsProcessed > 0
          ? (this.totalEventsProcessed - this.allDivergences.length) /
            this.totalEventsProcessed
          : 1,
    };
  }

  /**
   * Get all divergences.
   */
  getAllDivergences(): ShadowDivergence[] {
    return [...this.allDivergences];
  }

  /**
   * Get divergences for a specific document.
   */
  getDivergences(guid: string): ShadowDivergence[] {
    const shadow = this.shadows.get(guid);
    return shadow?.getDivergences() ?? [];
  }

  /**
   * Clear all divergences.
   */
  clearDivergences(): void {
    this.allDivergences = [];
    for (const shadow of this.shadows.values()) {
      shadow.clearDivergences();
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Check if shadow mode is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled ?? false;
  }

  /**
   * Enable/disable shadow mode.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Clean up all resources.
   */
  dispose(): void {
    for (const shadow of this.shadows.values()) {
      shadow.dispose();
    }
    this.shadows.clear();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private handleDivergence(divergence: ShadowDivergence): void {
    this.allDivergences.push(divergence);

    // Enforce global max
    if (this.allDivergences.length > this.config.maxDivergences!) {
      this.allDivergences.shift();
    }

    // Forward to config callback if present
    this.config.onDivergence?.(divergence);
  }

  private generateSessionId(): string {
    return `shadow_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
  }
}

// =============================================================================
// Export for easy creation
// =============================================================================

/**
 * Create a ShadowManager with console logging.
 */
export function createLoggingShadowManager(
  timeProvider?: TimeProvider
): ShadowManager {
  return new ShadowManager({
    logToConsole: true,
    minSeverity: 'warning',
    timeProvider,
  });
}
