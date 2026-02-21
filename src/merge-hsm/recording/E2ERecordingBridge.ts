/**
 * E2E Recording Bridge
 *
 * Per-folder passive sink for HSM transition events pushed by MergeHSM
 * via the `onTransition` callback. Streams entries to disk (via onEntry)
 * and captures in-memory timelines on demand for E2E tests.
 *
 * Lifecycle: 1:1 with SharedFolder. Created during folder init,
 * disposed during folder destroy.
 */

import type { MergeEvent, MergeEffect, StatePath } from '../types';
import type { TimeProvider } from '../../TimeProvider';
import { DefaultTimeProvider } from '../../TimeProvider';
import type { HSMLogEntry, RecordingSummary } from './types';
import {
  serializeEvent,
  serializeEffect,
  generateRecordingId,
} from './serialization';

// =============================================================================
// Types
// =============================================================================

export interface E2ERecordingBridgeConfig {
  /** Time provider (for testing) */
  timeProvider?: TimeProvider;

  /** Streaming callback - called for each entry as it's recorded */
  onEntry?: (entry: HSMLogEntry) => void;

  /** Callback to get full vault path for a guid (for recording/logging) */
  getFullPath: (guid: string) => string | undefined;
}

/** Lightweight per-guid tracking state */
interface DocTracker {
  guid: string;
  path: string;
  initialStatePath: StatePath;
  seqCounter: number;
  eventCounts: Record<string, number>;
  eventTotal: number;
  lastStatePath: string;
}

export interface E2ERecordingState {
  recording: boolean;
  name: string | null;
  id: string | null;
  startedAt: string | null;
  documentCount: number;
  totalEntries: number;
}

// =============================================================================
// E2ERecordingBridge
// =============================================================================

export class E2ERecordingBridge {
  private readonly timeProvider: TimeProvider;
  private readonly onEntry?: (entry: HSMLogEntry) => void;
  private readonly _getFullPath: (guid: string) => string | undefined;

  // Recording state
  private recording: boolean = false;
  private recordingId: string | null = null;
  private recordingName: string | null = null;
  private startedAt: string | null = null;

  // Per-document trackers (created lazily on first transition)
  private docTrackers: Map<string, DocTracker> = new Map();

  constructor(config: E2ERecordingBridgeConfig) {
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.onEntry = config.onEntry;
    this._getFullPath = config.getFullPath;
  }

  // ===========================================================================
  // Push-based entry point (called by MergeManager's onTransition callback)
  // ===========================================================================

  /**
   * Record a single HSM transition. Called by MergeManager for every
   * send() on every HSM that has the onTransition callback wired.
   */
  recordTransition(
    guid: string,
    path: string,
    info: { from: StatePath; to: StatePath; event: MergeEvent; effects: MergeEffect[] },
  ): void {
    const tracker = this.getOrCreateTracker(guid, path, info.from);
    const seq = tracker.seqCounter++;
    const eventType = info.event.type;

    // Update per-doc counters
    tracker.eventCounts[eventType] = (tracker.eventCounts[eventType] || 0) + 1;
    tracker.eventTotal++;
    tracker.lastStatePath = info.to;

    // Stream to disk if callback provided
    if (this.onEntry) {
      const timestamp = this.timeProvider.now();
      this.onEntry({
        ns: 'mergeHSM',
        ts: new Date(timestamp).toISOString(),
        guid,
        path: this._getFullPath(guid) ?? path,
        seq,
        event: serializeEvent(info.event),
        from: info.from,
        to: info.to,
        effects: info.effects.map(serializeEffect),
      });
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Start recording all HSM activity in-memory.
   */
  startRecording(name?: string): E2ERecordingState {
    if (this.recording) {
      throw new Error('Recording already in progress');
    }

    this.recording = true;
    this.recordingId = generateRecordingId();
    this.recordingName = name ?? `E2E Recording ${this.recordingId}`;
    this.startedAt = new Date().toISOString();

    // Reset counters on existing trackers for fresh recording
    for (const tracker of this.docTrackers.values()) {
      tracker.seqCounter = 0;
      tracker.eventCounts = {};
      tracker.eventTotal = 0;
    }

    return this.getState();
  }

  /**
   * Stop recording and return lightweight summary as JSON.
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

    for (const tracker of this.docTrackers.values()) {
      summary.documents.push({
        guid: tracker.guid,
        path: tracker.path,
        eventCount: tracker.eventTotal,
        eventCounts: { ...tracker.eventCounts },
        initialStatePath: tracker.initialStatePath,
        finalStatePath: tracker.lastStatePath,
      });
    }

    // Reset counters but keep trackers (they'll continue receiving transitions)
    for (const tracker of this.docTrackers.values()) {
      tracker.eventCounts = {};
      tracker.eventTotal = 0;
    }

    // Reset recording state
    this.recording = false;
    this.recordingId = null;
    this.recordingName = null;
    this.startedAt = null;

    return JSON.stringify(summary, null, 2);
  }

  getState(): E2ERecordingState {
    let totalEntries = 0;
    for (const tracker of this.docTrackers.values()) {
      totalEntries += tracker.eventTotal;
    }

    return {
      recording: this.recording,
      name: this.recordingName,
      id: this.recordingId,
      startedAt: this.startedAt,
      documentCount: this.docTrackers.size,
      totalEntries,
    };
  }

  isRecording(): boolean {
    return this.recording;
  }

  getActiveDocuments(): string[] {
    return Array.from(this.docTrackers.keys());
  }

  dispose(): void {
    if (this.recording) {
      try { this.stopRecording(); } catch { /* ignore */ }
    }
    this.docTrackers.clear();
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private getOrCreateTracker(guid: string, path: string, currentStatePath: StatePath): DocTracker {
    let tracker = this.docTrackers.get(guid);
    if (!tracker) {
      tracker = {
        guid,
        path,
        initialStatePath: currentStatePath,
        seqCounter: 0,
        eventCounts: {},
        eventTotal: 0,
        lastStatePath: currentStatePath,
      };
      this.docTrackers.set(guid, tracker);
    }
    return tracker;
  }
}
