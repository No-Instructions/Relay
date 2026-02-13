/**
 * E2E Recording Bridge
 *
 * Provides a bridge between the MergeManager and E2E tests running via CDP.
 * Exposes global functions that can be called from the Python E2E test script.
 *
 * Usage in plugin:
 *   import { E2ERecordingBridge } from './merge-hsm/recording/E2ERecordingBridge';
 *
 *   const bridge = new E2ERecordingBridge(mergeManager);
 *   bridge.install(); // Installs global functions
 *
 * Usage from Python E2E test (via CDP eval):
 *   await e2e.eval_js('window.__hsmRecording.startRecording("test-name")')
 *   // ... perform test actions ...
 *   recording = await e2e.eval_js('window.__hsmRecording.stopRecording()')
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from '../../storage/y-indexeddb';
import type { MergeManager } from '../MergeManager';
import type { MergeHSM } from '../MergeHSM';
import type { MergeEvent, MergeEffect, StatePath } from '../types';
import type { TimeProvider } from '../../TimeProvider';
import { DefaultTimeProvider } from '../../TimeProvider';
import type { HSMLogEntry, RecordingSummary } from './types';
import type { HSMTimelineEntry } from './types';
import {
  serializeEvent,
  serializeEffect,
  generateRecordingId,
} from './serialization';
import { getHSMBootId, getHSMBootEntries, getRecentEntries } from '../../debug';

// =============================================================================
// Types
// =============================================================================

export interface E2ERecordingBridgeConfig {
  /** Time provider (for testing) */
  timeProvider?: TimeProvider;

  /** Maximum entries per document recording */
  maxEntriesPerDoc?: number;

  /** Whether to capture snapshots (more expensive but more complete) */
  captureSnapshots?: boolean;

  /** Output directory for recordings (if using file saving) */
  outputDir?: string;

  /** Streaming callback - called for each entry as it's recorded */
  onEntry?: (entry: HSMLogEntry) => void;

  /** Callback to get an HSM by guid */
  getHSM: (guid: string) => MergeHSM | null | undefined;

  /** Callback to get full vault path for a guid (for recording/logging) */
  getFullPath: (guid: string) => string | undefined;

  /** Callback to get all document guids */
  getAllGuids: () => string[];
}

export interface ActiveDocRecording {
  guid: string;
  path: string;
  startedAt: string;
  initialStatePath: StatePath;
  timeline: HSMTimelineEntry[];
  seqCounter: number;
  eventCounts: Record<string, number>;
  eventTotal: number;
  lastStatePath: string;
  unsubscribeEffect: () => void;
  unsubscribeStateChange: () => void;
}

export interface E2ERecordingState {
  recording: boolean;
  name: string | null;
  id: string | null;
  startedAt: string | null;
  documentCount: number;
  totalEntries: number;
}

/**
 * Global interface exposed to E2E tests.
 */
export interface HSMRecordingGlobal {
  /** Start recording all HSM activity */
  startRecording: (name?: string) => E2ERecordingState;

  /** Stop recording and return lightweight summary JSON */
  stopRecording: () => string;

  /** Get current recording state */
  getState: () => E2ERecordingState;

  /** Check if recording is active */
  isRecording: () => boolean;

  /** Get list of active document GUIDs */
  getActiveDocuments: () => string[];

  /** Get the current boot ID (for disk recording) */
  getBootId: () => string | null;

  /** Get entries from current boot (reads disk file, filters by boot ID) */
  getBootEntries: () => Promise<object[]>;

  /** Get last N entries for a specific document (buffer + disk, newest files first) */
  getRecentEntries: (guid: string, limit?: number) => Promise<object[]>;

  /** Read Y.Doc text content from IndexedDB without waking the HSM */
  readIdbContent: (guid: string, appId: string) => Promise<{ content: string; stateVector: Uint8Array } | null>;
}

// =============================================================================
// E2ERecordingBridge
// =============================================================================

export class E2ERecordingBridge {
  private readonly manager: MergeManager;
  private readonly timeProvider: TimeProvider;
  private readonly maxEntriesPerDoc: number;
  private readonly captureSnapshots: boolean;
  private readonly outputDir: string;
  private readonly onEntry?: (entry: HSMLogEntry) => void;
  private readonly _getHSM: (guid: string) => MergeHSM | null | undefined;
  private readonly _getFullPath: (guid: string) => string | undefined;
  private readonly _getAllGuids: () => string[];

  // Recording state
  private recording: boolean = false;
  private recordingId: string | null = null;
  private recordingName: string | null = null;
  private startedAt: string | null = null;

  // Per-document recordings
  private docRecordings: Map<string, ActiveDocRecording> = new Map();

  // HSM subscription cleanup
  private managerUnsubscribe: (() => void) | null = null;

  constructor(manager: MergeManager, config: E2ERecordingBridgeConfig) {
    this.manager = manager;
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.maxEntriesPerDoc = config.maxEntriesPerDoc ?? 5000;
    this.captureSnapshots = config.captureSnapshots ?? false;
    this.outputDir = config.outputDir ?? '/tmp/hsm-recordings';
    this.onEntry = config.onEntry;
    this._getHSM = config.getHSM;
    this._getFullPath = config.getFullPath;
    this._getAllGuids = config.getAllGuids;

    // If onEntry is provided, automatically stream all HSM events to disk
    // (independent of in-memory recording via startRecording())
    if (this.onEntry) {
      this.startStreaming();
    }
  }

  /**
   * Start streaming HSM events via onEntry callback.
   * Called automatically when onEntry is provided in config.
   */
  private startStreaming(): void {
    // Wrap all registered HSMs (not just active ones — idle HSMs also
    // receive events that trigger state transitions we want to capture).
    for (const guid of this._getAllGuids()) {
      if (!this.docRecordings.has(guid)) {
        this.startRecordingDocument(guid);
      }
    }

    // Subscribe to new HSMs being loaded
    this.managerUnsubscribe = this.manager.syncStatus.subscribe(() => {
      for (const guid of this._getAllGuids()) {
        if (!this.docRecordings.has(guid)) {
          this.startRecordingDocument(guid);
        }
      }
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Install global functions for E2E test access.
   * Call this during plugin initialization.
   */
  install(): void {
    const global = typeof window !== 'undefined' ? window : globalThis;

    const api: HSMRecordingGlobal = {
      startRecording: (name) => this.startRecording(name),
      stopRecording: () => this.stopRecording(),
      getState: () => this.getState(),
      isRecording: () => this.isRecording(),
      getActiveDocuments: () => this.getActiveDocuments(),
      getBootId: () => getHSMBootId(),
      getBootEntries: () => getHSMBootEntries(),
      getRecentEntries: (guid, limit) => getRecentEntries(guid, limit),
      readIdbContent: async (guid, appId) => {
        const dbName = `${appId}-relay-doc-${guid}`;
        const tempDoc = new Y.Doc();
        try {
          const persistence = new IndexeddbPersistence(dbName, tempDoc);
          await persistence.whenSynced;
          const content = tempDoc.getText('contents').toString();
          const stateVector = Y.encodeStateVector(tempDoc);
          await persistence.destroy();
          return { content, stateVector };
        } catch {
          tempDoc.destroy();
          return null;
        }
      },
    };

    (global as any).__hsmRecording = api;
  }

  /**
   * Remove global functions.
   */
  uninstall(): void {
    const global = typeof window !== 'undefined' ? window : globalThis;
    delete (global as any).__hsmRecording;
  }

  /**
   * Start recording all HSM activity.
   */
  startRecording(name?: string): E2ERecordingState {
    if (this.recording) {
      throw new Error('Recording already in progress');
    }

    this.recording = true;
    this.recordingId = generateRecordingId();
    this.recordingName = name ?? `E2E Recording ${this.recordingId}`;
    this.startedAt = new Date().toISOString();

    // If streaming is active (onEntry provided), HSMs are already wrapped.
    // Just clear counters for fresh recording without unwrapping.
    if (this.onEntry) {
      for (const docRec of this.docRecordings.values()) {
        docRec.timeline = [];
        docRec.seqCounter = 0;
        docRec.eventCounts = {};
        docRec.eventTotal = 0;
        docRec.startedAt = this.startedAt;
      }
    } else {
      // No streaming - set up fresh
      this.docRecordings.clear();

      // Subscribe to existing loaded HSMs
      for (const guid of this._getAllGuids()) {
        if (this.manager.isActive(guid)) {
          this.startRecordingDocument(guid);
        }
      }
    }

    // Subscribe to new HSMs being loaded (only if not already subscribed via streaming)
    if (!this.managerUnsubscribe) {
      this.managerUnsubscribe = this.manager.syncStatus.subscribe(() => {
        if (!this.recording) return;

        for (const guid of this._getAllGuids()) {
          if (this.manager.isActive(guid) && !this.docRecordings.has(guid)) {
            this.startRecordingDocument(guid);
          }
        }
      });
    }

    return this.getState();
  }

  /**
   * Stop recording and return lightweight summary as JSON.
   * Full event data lives in the JSONL log (via onEntry callback).
   */
  stopRecording(): string {
    if (!this.recording) {
      throw new Error('No recording in progress');
    }

    const summary: RecordingSummary = {
      version: 2,
      id: this.recordingId!,
      name: this.recordingName!,
      startedAt: this.startedAt!,
      endedAt: new Date().toISOString(),
      documents: [],
    };

    for (const docRec of this.docRecordings.values()) {
      summary.documents.push({
        guid: docRec.guid,
        path: docRec.path,
        eventCount: docRec.eventTotal,
        eventCounts: { ...docRec.eventCounts },
        initialStatePath: docRec.initialStatePath,
        finalStatePath: docRec.lastStatePath,
      });
    }

    // If streaming is active (onEntry provided), keep HSMs wrapped for continued streaming.
    // Only clean up fully when not streaming.
    if (this.onEntry) {
      // Reset counters but keep HSM wrappers and subscriptions
      for (const docRec of this.docRecordings.values()) {
        docRec.timeline = [];
        docRec.eventCounts = {};
        docRec.eventTotal = 0;
      }
    } else {
      // Full cleanup - unwrap HSMs and clear everything
      for (const docRec of this.docRecordings.values()) {
        docRec.unsubscribeEffect();
        docRec.unsubscribeStateChange();
      }
      this.managerUnsubscribe?.();
      this.managerUnsubscribe = null;
      this.docRecordings.clear();
    }

    // Reset recording state
    this.recording = false;
    this.recordingId = null;
    this.recordingName = null;
    this.startedAt = null;

    return JSON.stringify(summary, null, 2);
  }

  /**
   * Get current recording state.
   */
  getState(): E2ERecordingState {
    let totalEntries = 0;
    for (const docRec of this.docRecordings.values()) {
      totalEntries += docRec.eventTotal;
    }

    return {
      recording: this.recording,
      name: this.recordingName,
      id: this.recordingId,
      startedAt: this.startedAt,
      documentCount: this.docRecordings.size,
      totalEntries,
    };
  }

  /**
   * Check if recording is active.
   */
  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Get list of active document GUIDs being recorded.
   */
  getActiveDocuments(): string[] {
    return Array.from(this.docRecordings.keys());
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Start recording a specific document's HSM.
   */
  private startRecordingDocument(guid: string): void {
    const hsm = this._getHSM(guid);
    if (!hsm) return;

    const docRecording: ActiveDocRecording = {
      guid,
      path: this._getFullPath(guid) ?? hsm.path,
      startedAt: new Date().toISOString(),
      initialStatePath: hsm.state.statePath,
      timeline: [],
      seqCounter: 0,
      eventCounts: {},
      eventTotal: 0,
      lastStatePath: hsm.state.statePath,
      unsubscribeEffect: () => {},
      unsubscribeStateChange: () => {},
    };

    // Track pending event for effect capture
    let pendingEvent: {
      event: MergeEvent;
      statePathBefore: StatePath;
      timestamp: number;
      effects: MergeEffect[];
    } | null = null;

    // Subscribe to effects
    docRecording.unsubscribeEffect = hsm.subscribe((effect) => {
      if (pendingEvent) {
        pendingEvent.effects.push(effect);
      }
    });

    // Intercept events by wrapping the send method
    const originalSend = hsm.send.bind(hsm);
    (hsm as any).send = (event: MergeEvent) => {
      // Always capture event data for streaming (onEntry callback)
      // Only add to in-memory timeline if this.recording is true
      const shouldStream = !!this.onEntry;
      const shouldRecord = this.recording;

      if (shouldStream || shouldRecord) {
        pendingEvent = {
          event,
          statePathBefore: hsm.state.statePath,
          timestamp: this.timeProvider.now(),
          effects: [],
        };
      }

      originalSend(event);

      if (pendingEvent) {
        // Finalize timeline entry
        const entry: HSMTimelineEntry = {
          seq: docRecording.seqCounter++,
          timestamp: pendingEvent.timestamp,
          event: serializeEvent(pendingEvent.event),
          statePathBefore: pendingEvent.statePathBefore,
          statePathAfter: hsm.state.statePath,
          effects: pendingEvent.effects.map(serializeEffect),
        };

        // Update per-doc counters
        const eventType = entry.event.type;
        docRecording.eventCounts[eventType] = (docRecording.eventCounts[eventType] || 0) + 1;
        docRecording.eventTotal++;
        docRecording.lastStatePath = entry.statePathAfter;

        // Stream enriched entry if callback provided (always, regardless of recording state)
        if (this.onEntry) {
          this.onEntry({
            ns: 'mergeHSM',
            ts: new Date(pendingEvent.timestamp).toISOString(),
            guid: docRecording.guid,
            path: this._getFullPath(docRecording.guid) ?? hsm.path,
            seq: entry.seq,
            event: entry.event,
            from: entry.statePathBefore,
            to: entry.statePathAfter,
            effects: entry.effects,
          });
        }

        // Add to in-memory timeline only if recording is active
        if (shouldRecord) {
          docRecording.timeline.push(entry);
          if (docRecording.timeline.length > this.maxEntriesPerDoc) {
            docRecording.timeline.shift();
          }
        }

        pendingEvent = null;
      }
    };

    // Store cleanup for send wrapper
    const cleanup = docRecording.unsubscribeEffect;
    docRecording.unsubscribeEffect = () => {
      cleanup();
      (hsm as any).send = originalSend;
    };

    this.docRecordings.set(guid, docRecording);
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.recording) {
      // Stop recording without returning result
      try {
        this.stopRecording();
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Clean up streaming (unwrap all HSMs)
    for (const docRec of this.docRecordings.values()) {
      docRec.unsubscribeEffect();
      docRec.unsubscribeStateChange();
    }
    this.managerUnsubscribe?.();
    this.managerUnsubscribe = null;
    this.docRecordings.clear();

    this.uninstall();
  }
}

// =============================================================================
// Factory Function
// =============================================================================

// Registry of bridges by folder path for multi-folder support
const bridgeRegistry = new Map<string, E2ERecordingBridge>();

// Track active recording state so new bridges auto-join
let activeRecordingName: string | null = null;

/**
 * Create and install E2E recording bridge.
 * Call this in plugin initialization.
 *
 * NOTE: Multiple folders can each have their own bridge.
 * The global __hsmRecording provides aggregate access to all bridges.
 */
export function installE2ERecordingBridge(
  manager: MergeManager,
  config: E2ERecordingBridgeConfig
): E2ERecordingBridge {
  const bridge = new E2ERecordingBridge(manager, config);

  // Register this bridge (use manager's internal identifier)
  const folderPath = (manager as any).folderPath ?? `manager-${bridgeRegistry.size}`;
  bridgeRegistry.set(folderPath, bridge);

  // Install aggregate API that spans all registered bridges
  installAggregateBridgeAPI();

  // Auto-start recording if a recording is currently active
  if (activeRecordingName !== null) {
    try {
      bridge.startRecording(activeRecordingName);
    } catch {
      // Ignore errors (e.g., already recording)
    }
  }

  return bridge;
}

/**
 * Install global API that aggregates across all folder bridges.
 */
function installAggregateBridgeAPI(): void {
  const global = typeof window !== 'undefined' ? window : globalThis;

  const api: HSMRecordingGlobal = {
    startRecording: (name) => {
      // Track active recording so new bridges auto-join
      activeRecordingName = name ?? 'E2E Recording';

      // Start recording on all bridges
      const results: E2ERecordingState[] = [];
      for (const bridge of bridgeRegistry.values()) {
        try {
          results.push(bridge.startRecording(name));
        } catch (e) {
          // Bridge might already be recording
        }
      }
      // Return aggregate state
      return {
        recording: results.some(r => r.recording),
        name: name ?? null,
        id: results[0]?.id ?? null,
        startedAt: results[0]?.startedAt ?? null,
        documentCount: results.reduce((sum, r) => sum + r.documentCount, 0),
        totalEntries: results.reduce((sum, r) => sum + r.totalEntries, 0),
      };
    },
    stopRecording: () => {
      // Clear active recording tracking
      activeRecordingName = null;

      // Stop recording on all bridges and combine results
      const recordings: string[] = [];
      for (const bridge of bridgeRegistry.values()) {
        try {
          recordings.push(bridge.stopRecording());
        } catch (e) {
          // Bridge might not be recording
        }
      }
      // Combine recordings (each is a JSON array)
      const combined = recordings.flatMap(r => {
        try { return JSON.parse(r); } catch { return []; }
      });
      return JSON.stringify(combined, null, 2);
    },
    getState: () => {
      // Aggregate state across all bridges
      let totalDocs = 0;
      let totalEntries = 0;
      let recording = false;
      let name: string | null = null;
      let id: string | null = null;
      let startedAt: string | null = null;

      for (const bridge of bridgeRegistry.values()) {
        const state = bridge.getState();
        if (state.recording) {
          recording = true;
          name = name ?? state.name;
          id = id ?? state.id;
          startedAt = startedAt ?? state.startedAt;
        }
        totalDocs += state.documentCount;
        totalEntries += state.totalEntries;
      }

      return { recording, name, id, startedAt, documentCount: totalDocs, totalEntries };
    },
    isRecording: () => {
      return Array.from(bridgeRegistry.values()).some(b => b.isRecording());
    },
    getActiveDocuments: () => {
      // Combine active documents from all bridges
      const docs: string[] = [];
      for (const bridge of bridgeRegistry.values()) {
        docs.push(...bridge.getActiveDocuments());
      }
      return docs;
    },
    getBootId: () => getHSMBootId(),
    getBootEntries: () => getHSMBootEntries(),
    getRecentEntries: (guid, limit) => getRecentEntries(guid, limit),
    readIdbContent: async (guid, appId) => {
      const dbName = `${appId}-relay-doc-${guid}`;
      const tempDoc = new Y.Doc();
      try {
        const persistence = new IndexeddbPersistence(dbName, tempDoc);
        await persistence.whenSynced;
        const content = tempDoc.getText('contents').toString();
        const stateVector = Y.encodeStateVector(tempDoc);
        await persistence.destroy();
        return { content, stateVector };
      } catch {
        tempDoc.destroy();
        return null;
      }
    },
  };

  (global as any).__hsmRecording = api;
}
