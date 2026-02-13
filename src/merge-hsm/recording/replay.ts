/**
 * HSM Recording Replay Utilities
 *
 * Functions for replaying log entries against HSM instances and verifying behavior.
 * Used for:
 * - Regression testing
 * - Debugging
 */

import type {
  MergeEvent,
  MergeEffect,
  StatePath,
} from '../types';
import type {
  RecordableHSM,
  HSMLogEntry,
  ReplayResult,
  ReplayDivergence,
  SerializableEffect,
} from './types';
import {
  deserializeEvent,
  serializeEffect,
} from './serialization';

// =============================================================================
// Log-Based Replay Options
// =============================================================================

export interface LogReplayOptions {
  /** Stop on first divergence (default: false) */
  stopOnDivergence?: boolean;

  /** Compare effects strictly (order matters) or loosely (set comparison) */
  strictEffectOrder?: boolean;

  /** Custom effect comparator */
  effectComparator?: (expected: SerializableEffect, actual: SerializableEffect) => boolean;

  /** Callback for each event replayed */
  onEventReplayed?: (entry: HSMLogEntry, effects: MergeEffect[]) => void;

  /** Callback for divergence detected */
  onDivergence?: (divergence: ReplayDivergence) => void;
}

// =============================================================================
// Log-Based Replay
// =============================================================================

/**
 * Replay log entries against an HSM instance and check for divergences.
 */
export function replayLogEntries(
  hsm: RecordableHSM,
  entries: HSMLogEntry[],
  options: LogReplayOptions = {}
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

  // Set up effect capture
  const capturedEffects: MergeEffect[] = [];
  const unsubscribe = hsm.subscribe((effect) => {
    capturedEffects.push(effect);
  });

  try {
    for (const entry of entries) {
      capturedEffects.length = 0;

      const event = deserializeEvent(entry.event);
      hsm.send(event);
      eventsReplayed++;

      const actualEffects = capturedEffects.map(serializeEffect);
      allEffects.push(...actualEffects);

      onEventReplayed?.(entry, capturedEffects);

      // Check state transition
      if (hsm.state.statePath !== entry.to) {
        const divergence: ReplayDivergence = {
          seq: entry.seq,
          type: 'state-mismatch',
          expected: entry.to,
          actual: hsm.state.statePath,
          message: `State mismatch at seq ${entry.seq} (${entry.event.type}): expected ${entry.to}, got ${hsm.state.statePath}`,
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
 * For effects with Yjs updates (SYNC_TO_REMOTE), only compare by type
 * since the binary content is non-deterministic.
 */
function defaultEffectComparator(
  expected: SerializableEffect,
  actual: SerializableEffect
): boolean {
  if (expected.type !== actual.type) {
    return false;
  }

  if (expected.type === 'SYNC_TO_REMOTE') {
    return true;
  }

  if (expected.type === 'DISPATCH_CM6' && actual.type === 'DISPATCH_CM6') {
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

  return JSON.stringify(expected) === JSON.stringify(actual);
}

// =============================================================================
// Log Entry Filtering/Transformation
// =============================================================================

/**
 * Filter log entries to only include certain event types.
 */
export function filterLogEntries(
  entries: HSMLogEntry[],
  eventTypes: MergeEvent['type'][]
): HSMLogEntry[] {
  const typeSet = new Set(eventTypes);
  return entries.filter((entry) =>
    typeSet.has(entry.event.type as MergeEvent['type'])
  );
}

/**
 * Slice log entries to a specific sequence range.
 */
export function sliceLogEntries(
  entries: HSMLogEntry[],
  start: number,
  end?: number
): HSMLogEntry[] {
  const endSeq = end ?? entries.length;
  return entries.filter(
    (entry) => entry.seq >= start && entry.seq < endSeq
  );
}

/**
 * Find the sequence number where a specific state was reached in log entries.
 */
export function findLogTransition(
  entries: HSMLogEntry[],
  targetState: StatePath
): number | null {
  for (const entry of entries) {
    if (entry.to === targetState) {
      return entry.seq;
    }
  }
  return null;
}

// =============================================================================
// Log Fixture Loader
// =============================================================================

/**
 * Load log entries from a JSONL file (one JSON per line).
 */
export async function loadLogFixture(path: string): Promise<HSMLogEntry[]> {
  if (typeof require !== 'undefined') {
    const fs = await import('fs');
    const content = fs.readFileSync(path, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as HSMLogEntry);
  } else {
    throw new Error('loadLogFixture is only available in Node.js');
  }
}

/**
 * Load all log fixtures from a directory (all .jsonl files).
 */
export async function loadLogFixtures(
  dirPath: string
): Promise<HSMLogEntry[][]> {
  if (typeof require !== 'undefined') {
    const fs = await import('fs');
    const pathModule = await import('path');
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    return Promise.all(
      files.map((f) => loadLogFixture(pathModule.join(dirPath, f)))
    );
  } else {
    throw new Error('loadLogFixtures is only available in Node.js');
  }
}
