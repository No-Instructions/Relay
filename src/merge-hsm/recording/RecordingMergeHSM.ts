/**
 * RecordingMergeHSM - Wrapper for recording HSM event/effect traces
 *
 * Wraps a MergeHSM instance and records all events sent to it,
 * along with the resulting state transitions and effects.
 *
 * Usage:
 *   const hsm = new MergeHSM(config);
 *   const recorder = new RecordingMergeHSM(hsm, { metadata: { source: 'e2e-test' } });
 *
 *   recorder.startRecording('test-scenario');
 *   // ... send events ...
 *   const recording = recorder.stopRecording();
 *   saveToFile(recording);
 */

import type * as Y from 'yjs';
import type {
  MergeState,
  MergeEvent,
  MergeEffect,
  StatePath,
  SyncStatus,
  SerializableSnapshot,
} from '../types';
import type { TimeProvider } from '../../TimeProvider';
import { DefaultTimeProvider } from '../../TimeProvider';
import type {
  HSMRecording,
  HSMTimelineEntry,
  RecordingOptions,
  RecordingMetadata,
  SerializableEvent,
  SerializableEffect,
} from './types';
import {
  serializeEvent,
  serializeEffect,
  createSerializableSnapshot,
  generateRecordingId,
} from './serialization';

// =============================================================================
// RecordingMergeHSM Interface
// =============================================================================

/**
 * Interface for the underlying HSM.
 * MergeHSM implements this interface.
 */
export interface RecordableHSM {
  readonly state: MergeState;
  send(event: MergeEvent): void;
  matches(statePath: string): boolean;
  getLocalDoc(): Y.Doc | null;
  getLocalDocLength(): Promise<number>;
  getRemoteDoc(): Y.Doc | null;
  getSyncStatus(): SyncStatus;
  checkAndCorrectDrift(actualEditorText?: string): boolean;
  subscribe(listener: (effect: MergeEffect) => void): () => void;
  onStateChange(listener: (from: StatePath, to: StatePath, event: MergeEvent) => void): () => void;
}

// =============================================================================
// RecordingMergeHSM Class
// =============================================================================

export class RecordingMergeHSM implements RecordableHSM {
  private readonly hsm: RecordableHSM;
  private readonly timeProvider: TimeProvider;
  private readonly options: Required<RecordingOptions>;

  // Recording state
  private recording: boolean = false;
  private recordingId: string | null = null;
  private recordingName: string | null = null;
  private startedAt: string | null = null;
  private initialSnapshot: SerializableSnapshot | null = null;
  private initialStatePath: StatePath | null = null;
  private timeline: HSMTimelineEntry[] = [];
  private seqCounter: number = 0;

  // Pending event (for capturing effects emitted during event processing)
  private pendingEvent: {
    event: MergeEvent;
    statePathBefore: StatePath;
    timestamp: number;
    effects: MergeEffect[];
  } | null = null;

  // Subscriptions
  private unsubscribeEffect: (() => void) | null = null;
  private unsubscribeStateChange: (() => void) | null = null;

  constructor(
    hsm: RecordableHSM,
    options: RecordingOptions = {},
    timeProvider?: TimeProvider
  ) {
    this.hsm = hsm;
    this.timeProvider = timeProvider ?? new DefaultTimeProvider();
    this.options = {
      captureSnapshots: options.captureSnapshots ?? false,
      maxEntries: options.maxEntries ?? 10000,
      eventFilter: options.eventFilter ?? (() => true),
      metadata: {
        source: options.metadata?.source ?? 'manual',
        ...options.metadata,
      },
    };

    this.setupSubscriptions();
  }

  // ===========================================================================
  // Recording Control
  // ===========================================================================

  /**
   * Start recording events.
   * @param name Optional name for the recording
   */
  startRecording(name?: string): void {
    if (this.recording) {
      throw new Error('Recording already in progress');
    }

    this.recording = true;
    this.recordingId = generateRecordingId();
    this.recordingName = name ?? `Recording ${this.recordingId}`;
    this.startedAt = new Date().toISOString();
    this.initialStatePath = this.hsm.state.statePath;
    this.initialSnapshot = this.captureSnapshot();
    this.timeline = [];
    this.seqCounter = 0;
  }

  /**
   * Stop recording and return the complete recording.
   */
  stopRecording(): HSMRecording {
    if (!this.recording) {
      throw new Error('No recording in progress');
    }

    const recording: HSMRecording = {
      version: 1,
      id: this.recordingId!,
      name: this.recordingName!,
      startedAt: this.startedAt!,
      endedAt: new Date().toISOString(),
      document: {
        guid: this.hsm.state.guid,
        path: this.hsm.state.path,
      },
      initialState: {
        statePath: this.initialStatePath!,
        snapshot: this.initialSnapshot!,
      },
      timeline: this.timeline,
      metadata: this.options.metadata as RecordingMetadata,
    };

    // Reset state
    this.recording = false;
    this.recordingId = null;
    this.recordingName = null;
    this.startedAt = null;
    this.initialSnapshot = null;
    this.initialStatePath = null;
    this.timeline = [];
    this.seqCounter = 0;

    return recording;
  }

  /**
   * Check if currently recording.
   */
  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Get the current recording state (without stopping).
   * Useful for intermediate inspection.
   */
  getRecordingState(): {
    recording: boolean;
    id: string | null;
    name: string | null;
    entryCount: number;
  } {
    return {
      recording: this.recording,
      id: this.recordingId,
      name: this.recordingName,
      entryCount: this.timeline.length,
    };
  }

  // ===========================================================================
  // HSM Delegation (implements RecordableHSM)
  // ===========================================================================

  get state(): MergeState {
    return this.hsm.state;
  }

  /**
   * Send an event to the HSM.
   * If recording, the event and its effects are captured.
   */
  send(event: MergeEvent): void {
    const shouldRecord = this.recording && this.options.eventFilter(event);

    if (shouldRecord) {
      // Start capturing effects for this event
      this.pendingEvent = {
        event,
        statePathBefore: this.hsm.state.statePath,
        timestamp: this.timeProvider.now(),
        effects: [],
      };
    }

    // Send to underlying HSM
    this.hsm.send(event);

    if (shouldRecord && this.pendingEvent) {
      // Finalize the timeline entry
      this.finalizeTimelineEntry();
    }
  }

  matches(statePath: string): boolean {
    return this.hsm.matches(statePath);
  }

  getLocalDoc(): Y.Doc | null {
    return this.hsm.getLocalDoc();
  }

  getLocalDocLength(): Promise<number> {
    return this.hsm.getLocalDocLength();
  }

  getRemoteDoc(): Y.Doc | null {
    return this.hsm.getRemoteDoc();
  }

  getSyncStatus(): SyncStatus {
    return this.hsm.getSyncStatus();
  }

  checkAndCorrectDrift(actualEditorText?: string): boolean {
    return this.hsm.checkAndCorrectDrift(actualEditorText);
  }

  subscribe(listener: (effect: MergeEffect) => void): () => void {
    return this.hsm.subscribe(listener);
  }

  onStateChange(
    listener: (from: StatePath, to: StatePath, event: MergeEvent) => void
  ): () => void {
    return this.hsm.onStateChange(listener);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private setupSubscriptions(): void {
    // Capture effects emitted by the HSM
    this.unsubscribeEffect = this.hsm.subscribe((effect) => {
      if (this.pendingEvent) {
        this.pendingEvent.effects.push(effect);
      }
    });
  }

  private finalizeTimelineEntry(): void {
    if (!this.pendingEvent) return;

    const entry: HSMTimelineEntry = {
      seq: this.seqCounter++,
      timestamp: this.pendingEvent.timestamp,
      event: serializeEvent(this.pendingEvent.event),
      statePathBefore: this.pendingEvent.statePathBefore,
      statePathAfter: this.hsm.state.statePath,
      effects: this.pendingEvent.effects.map(serializeEffect),
    };

    // Optionally capture snapshot
    if (this.options.captureSnapshots) {
      entry.snapshotAfter = this.captureSnapshot();
    }

    // Add to timeline (with maxEntries limit)
    this.timeline.push(entry);
    if (this.timeline.length > this.options.maxEntries) {
      this.timeline.shift(); // Remove oldest entry
    }

    this.pendingEvent = null;
  }

  private captureSnapshot(): SerializableSnapshot {
    const state = this.hsm.state;
    const localDoc = this.hsm.getLocalDoc();
    const remoteDoc = this.hsm.getRemoteDoc();

    return createSerializableSnapshot(
      state,
      this.timeProvider.now(),
      localDoc?.getText('contents').toString() ?? null,
      remoteDoc?.getText('contents').toString() ?? null
    );
  }

  /**
   * Clean up subscriptions.
   */
  dispose(): void {
    this.unsubscribeEffect?.();
    this.unsubscribeStateChange?.();
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a RecordingMergeHSM with default options for E2E tests.
 */
export function createE2ERecorder(
  hsm: RecordableHSM,
  testName: string,
  testFile?: string,
  timeProvider?: TimeProvider
): RecordingMergeHSM {
  return new RecordingMergeHSM(
    hsm,
    {
      captureSnapshots: true,
      metadata: {
        source: 'e2e-test',
        testName,
        testFile,
      },
    },
    timeProvider
  );
}

/**
 * Create a RecordingMergeHSM with default options for integration tests.
 */
export function createIntegrationRecorder(
  hsm: RecordableHSM,
  testName: string,
  timeProvider?: TimeProvider
): RecordingMergeHSM {
  return new RecordingMergeHSM(
    hsm,
    {
      captureSnapshots: false, // Less expensive for integration tests
      metadata: {
        source: 'integration-test',
        testName,
      },
    },
    timeProvider
  );
}

/**
 * Create a RecordingMergeHSM for shadow mode.
 */
export function createShadowRecorder(
  hsm: RecordableHSM,
  timeProvider?: TimeProvider
): RecordingMergeHSM {
  return new RecordingMergeHSM(
    hsm,
    {
      captureSnapshots: false,
      metadata: {
        source: 'shadow-mode',
      },
    },
    timeProvider
  );
}
