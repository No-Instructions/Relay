/**
 * HSM Recording Replay Utilities
 *
 * Functions for replaying recorded HSM sessions and verifying behavior.
 * Used for:
 * - Converting integration test recordings to unit tests
 * - Regression testing
 * - Debugging
 */

import type {
  MergeEvent,
  MergeEffect,
  StatePath,
} from '../types';
import type {
  HSMRecording,
  HSMTimelineEntry,
  ReplayResult,
  ReplayDivergence,
  SerializableEffect,
} from './types';
import {
  deserializeEvent,
  deserializeEffect,
  serializeEffect,
} from './serialization';
import type { RecordableHSM } from './RecordingMergeHSM';

// =============================================================================
// Replay Options
// =============================================================================

export interface ReplayOptions {
  /** Stop on first divergence (default: false) */
  stopOnDivergence?: boolean;

  /** Compare effects strictly (order matters) or loosely (set comparison) */
  strictEffectOrder?: boolean;

  /** Custom effect comparator */
  effectComparator?: (expected: SerializableEffect, actual: SerializableEffect) => boolean;

  /** Callback for each event replayed */
  onEventReplayed?: (entry: HSMTimelineEntry, effects: MergeEffect[]) => void;

  /** Callback for divergence detected */
  onDivergence?: (divergence: ReplayDivergence) => void;
}

// =============================================================================
// Replay Function
// =============================================================================

/**
 * Replay a recording against an HSM instance and check for divergences.
 *
 * The HSM should be in the same initial state as when the recording started.
 * The replay will send each recorded event and compare:
 * - State transitions
 * - Effects emitted
 */
export function replayRecording(
  hsm: RecordableHSM,
  recording: HSMRecording,
  options: ReplayOptions = {}
): ReplayResult {
  const {
    stopOnDivergence = false,
    strictEffectOrder = true,
    effectComparator = defaultEffectComparator,
    onEventReplayed,
    onDivergence,
  } = options;

  const divergences: ReplayDivergence[] = [];
  const allEffects: SerializableEffect[] = [];
  let eventsReplayed = 0;

  // Verify initial state matches
  if (hsm.state.statePath !== recording.initialState.statePath) {
    const divergence: ReplayDivergence = {
      seq: -1,
      type: 'state-mismatch',
      expected: recording.initialState.statePath,
      actual: hsm.state.statePath,
      message: `Initial state mismatch: expected ${recording.initialState.statePath}, got ${hsm.state.statePath}`,
    };
    divergences.push(divergence);
    onDivergence?.(divergence);

    if (stopOnDivergence) {
      return {
        success: false,
        eventsReplayed: 0,
        divergences,
        finalStatePath: hsm.state.statePath,
        allEffects,
      };
    }
  }

  // Set up effect capture
  const capturedEffects: MergeEffect[] = [];
  const unsubscribe = hsm.subscribe((effect) => {
    capturedEffects.push(effect);
  });

  try {
    // Replay each event
    for (const entry of recording.timeline) {
      capturedEffects.length = 0; // Clear captured effects

      // Deserialize and send the event
      const event = deserializeEvent(entry.event);
      hsm.send(event);
      eventsReplayed++;

      // Serialize captured effects for comparison
      const actualEffects = capturedEffects.map(serializeEffect);
      allEffects.push(...actualEffects);

      // Callback
      onEventReplayed?.(entry, capturedEffects);

      // Check state transition
      if (hsm.state.statePath !== entry.statePathAfter) {
        const divergence: ReplayDivergence = {
          seq: entry.seq,
          type: 'state-mismatch',
          expected: entry.statePathAfter,
          actual: hsm.state.statePath,
          message: `State mismatch at seq ${entry.seq} (${entry.event.type}): expected ${entry.statePathAfter}, got ${hsm.state.statePath}`,
        };
        divergences.push(divergence);
        onDivergence?.(divergence);

        if (stopOnDivergence) break;
      }

      // Check effect count
      if (actualEffects.length !== entry.effects.length) {
        const divergence: ReplayDivergence = {
          seq: entry.seq,
          type: 'effect-count-mismatch',
          expected: entry.effects.length,
          actual: actualEffects.length,
          message: `Effect count mismatch at seq ${entry.seq} (${entry.event.type}): expected ${entry.effects.length}, got ${actualEffects.length}`,
        };
        divergences.push(divergence);
        onDivergence?.(divergence);

        if (stopOnDivergence) break;
      }

      // Check effects
      const effectDivergences = compareEffects(
        entry.effects,
        actualEffects,
        entry.seq,
        strictEffectOrder,
        effectComparator
      );

      if (effectDivergences.length > 0) {
        divergences.push(...effectDivergences);
        if (onDivergence) {
          effectDivergences.forEach(onDivergence);
        }

        if (stopOnDivergence) break;
      }
    }
  } finally {
    unsubscribe();
  }

  return {
    success: divergences.length === 0,
    eventsReplayed,
    divergences,
    finalStatePath: hsm.state.statePath,
    allEffects,
  };
}

// =============================================================================
// Effect Comparison
// =============================================================================

function compareEffects(
  expected: SerializableEffect[],
  actual: SerializableEffect[],
  seq: number,
  strictOrder: boolean,
  comparator: (a: SerializableEffect, b: SerializableEffect) => boolean
): ReplayDivergence[] {
  const divergences: ReplayDivergence[] = [];

  if (strictOrder) {
    // Compare in order
    const minLen = Math.min(expected.length, actual.length);
    for (let i = 0; i < minLen; i++) {
      if (!comparator(expected[i], actual[i])) {
        divergences.push({
          seq,
          type: 'effect-mismatch',
          expected: expected[i],
          actual: actual[i],
          message: `Effect mismatch at seq ${seq}, index ${i}: expected ${expected[i].type}, got ${actual[i].type}`,
        });
      }
    }
  } else {
    // Set comparison (order doesn't matter)
    const actualCopy = [...actual];
    for (const exp of expected) {
      const matchIndex = actualCopy.findIndex((act) => comparator(exp, act));
      if (matchIndex === -1) {
        divergences.push({
          seq,
          type: 'effect-mismatch',
          expected: exp,
          actual: null,
          message: `Missing expected effect at seq ${seq}: ${exp.type}`,
        });
      } else {
        actualCopy.splice(matchIndex, 1);
      }
    }

    // Any remaining actual effects are unexpected
    for (const remaining of actualCopy) {
      divergences.push({
        seq,
        type: 'effect-mismatch',
        expected: null,
        actual: remaining,
        message: `Unexpected effect at seq ${seq}: ${remaining.type}`,
      });
    }
  }

  return divergences;
}

/**
 * Default effect comparator.
 * Compares effects by type and essential properties.
 *
 * Note: For effects with Yjs updates (SYNC_TO_REMOTE),
 * we only compare by type since the binary content is non-deterministic.
 */
function defaultEffectComparator(
  expected: SerializableEffect,
  actual: SerializableEffect
): boolean {
  if (expected.type !== actual.type) {
    return false;
  }

  // For effects with Yjs updates, only compare type
  // The binary content is non-deterministic across different YDoc instances
  if (expected.type === 'SYNC_TO_REMOTE') {
    return true; // Type match is sufficient
  }

  // For DISPATCH_CM6, compare the changes structure
  if (expected.type === 'DISPATCH_CM6' && actual.type === 'DISPATCH_CM6') {
    // Changes should match in position and content
    if (expected.changes.length !== actual.changes.length) {
      return false;
    }
    for (let i = 0; i < expected.changes.length; i++) {
      const exp = expected.changes[i];
      const act = actual.changes[i];
      if (exp.from !== act.from || exp.to !== act.to || exp.insert !== act.insert) {
        return false;
      }
    }
    return true;
  }

  // Deep comparison with JSON stringify for other effects
  return JSON.stringify(expected) === JSON.stringify(actual);
}

// =============================================================================
// Assertion Helpers for Tests
// =============================================================================

/**
 * Assert that replay succeeds with no divergences.
 * Throws an error with details if divergences are found.
 */
export function assertReplaySucceeds(
  hsm: RecordableHSM,
  recording: HSMRecording,
  options?: ReplayOptions
): void {
  const result = replayRecording(hsm, recording, options);

  if (!result.success) {
    const messages = result.divergences.map((d) => d.message).join('\n  - ');
    throw new Error(
      `Replay failed with ${result.divergences.length} divergence(s):\n  - ${messages}`
    );
  }
}

/**
 * Assert that replay produces specific divergences.
 * Useful for testing that the HSM behavior has changed intentionally.
 */
export function assertReplayDiverges(
  hsm: RecordableHSM,
  recording: HSMRecording,
  expectedDivergenceCount: number,
  options?: ReplayOptions
): ReplayResult {
  const result = replayRecording(hsm, recording, options);

  if (result.divergences.length !== expectedDivergenceCount) {
    throw new Error(
      `Expected ${expectedDivergenceCount} divergence(s), got ${result.divergences.length}`
    );
  }

  return result;
}

// =============================================================================
// Recording Fixture Loader
// =============================================================================

/**
 * Load a recording from a JSON file (for use in tests).
 * Works in both Node.js (via fs) and browser (via fetch) environments.
 */
export async function loadRecordingFixture(path: string): Promise<HSMRecording> {
  if (typeof require !== 'undefined') {
    // Node.js environment
    const fs = await import('fs');
    const json = fs.readFileSync(path, 'utf-8');
    return JSON.parse(json) as HSMRecording;
  } else {
    // Browser environment
    const response = await fetch(path);
    return response.json() as Promise<HSMRecording>;
  }
}

/**
 * Load all recordings from a directory.
 */
export async function loadRecordingFixtures(
  dirPath: string
): Promise<HSMRecording[]> {
  if (typeof require !== 'undefined') {
    // Node.js environment
    const fs = await import('fs');
    const path = await import('path');
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
    return Promise.all(
      files.map((f) => loadRecordingFixture(path.join(dirPath, f)))
    );
  } else {
    throw new Error('loadRecordingFixtures is only available in Node.js');
  }
}

// =============================================================================
// Recording Filtering/Transformation
// =============================================================================

/**
 * Filter a recording to only include certain event types.
 */
export function filterRecording(
  recording: HSMRecording,
  eventTypes: MergeEvent['type'][]
): HSMRecording {
  const typeSet = new Set(eventTypes);
  return {
    ...recording,
    timeline: recording.timeline.filter((entry) =>
      typeSet.has(entry.event.type as MergeEvent['type'])
    ),
  };
}

/**
 * Slice a recording to a specific sequence range.
 */
export function sliceRecording(
  recording: HSMRecording,
  startSeq: number,
  endSeq?: number
): HSMRecording {
  const end = endSeq ?? recording.timeline.length;
  return {
    ...recording,
    timeline: recording.timeline.filter(
      (entry) => entry.seq >= startSeq && entry.seq < end
    ),
  };
}

/**
 * Find the sequence number where a specific state was reached.
 */
export function findStateTransition(
  recording: HSMRecording,
  targetState: StatePath
): number | null {
  for (const entry of recording.timeline) {
    if (entry.statePathAfter === targetState) {
      return entry.seq;
    }
  }
  return null;
}
