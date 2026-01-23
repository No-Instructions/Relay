/**
 * Shadow Mode Module
 *
 * Provides infrastructure for running MergeHSM in shadow mode
 * alongside the existing system to detect behavioral divergences.
 *
 * Usage:
 *   import { ShadowManager, ShadowMergeHSM } from './shadow';
 *
 *   // Per-folder shadow manager
 *   const manager = new ShadowManager({ logToConsole: true });
 *   manager.register(guid, path, remoteDoc);
 *
 *   // Mirror events from old system
 *   manager.send(guid, event);
 *   manager.reportAction(guid, action);
 *
 *   // Get report
 *   const report = manager.getReport();
 */

// Types
export type {
  OldSystemAction,
  ShadowDivergence,
  ShadowModeConfig,
  ShadowDocumentState,
  ShadowSessionStats,
  DivergenceType,
  DivergenceSeverity,
  ComparisonResult,
  EffectActionMapping,
} from './types';

// ShadowMergeHSM
export {
  ShadowMergeHSM,
  createLoggingShadow,
  createCallbackShadow,
} from './ShadowMergeHSM';

// ShadowManager
export {
  ShadowManager,
  createLoggingShadowManager,
} from './ShadowManager';
export type {
  ShadowManagerConfig,
  ShadowReport,
  DocumentShadowSummary,
} from './ShadowManager';
