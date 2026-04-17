/**
 * Integration Test Infrastructure for Merge-HSM
 *
 * Shared utilities for replaying JSONL recordings, filtering events,
 * capturing doc-content snapshots, and asserting against production state.
 */

import { expect } from '@jest/globals';
import * as Y from 'yjs';
import * as fs from 'fs';
import type { HSMLogEntry, SerializableEvent } from '../recording/types';
import type { TestHSM } from './createTestHSM';
import type { CrossVaultTest, VaultHandle } from './createCrossVaultTest';
import { deserializeEvent } from '../recording/serialization';

// =============================================================================
// Event Classification
// =============================================================================

/** Events driven by user actions or lifecycle (replayed as inputs). */
export const INPUT_EVENTS = new Set([
  'LOAD', 'PERSISTENCE_LOADED', 'SET_MODE_IDLE', 'SET_MODE_ACTIVE',
  'DISK_CHANGED', 'ACQUIRE_LOCK', 'RELEASE_LOCK',
  'CM6_CHANGE', 'OPEN_DIFF_VIEW', 'RESOLVE',
  'DISMISS_CONFLICT', 'CANCEL', 'RESOLVE_HUNK',
  'UNLOAD',
]);

/** Events produced by the integration/provider layer (should emerge from the twin). */
export const SYSTEM_EVENTS = new Set([
  'PERSISTENCE_SYNCED', 'PROVIDER_SYNCED', 'CONNECTED', 'DISCONNECTED',
  'REMOTE_UPDATE', 'REMOTE_DOC_UPDATED', 'SAVE_COMPLETE',
  'MERGE_SUCCESS', 'MERGE_CONFLICT',
]);

/** Obsidian diagnostic events (no state transition expected). */
export const DIAGNOSTIC_EVENTS = new Set([
  'OBSIDIAN_LOAD_FILE_INTERNAL',
  'OBSIDIAN_THREE_WAY_MERGE',
  'OBSIDIAN_FILE_OPENED',
  'OBSIDIAN_FILE_UNLOADED',
  'OBSIDIAN_VIEW_REUSED',
  'OBSIDIAN_SAVE_FRONTMATTER',
  'OBSIDIAN_METADATA_SYNC',
]);

// =============================================================================
// JSONL Loading and Filtering
// =============================================================================

/**
 * Load JSONL fixture entries from a file path.
 */
export function loadFixture(filepath: string): HSMLogEntry[] {
  const content = fs.readFileSync(filepath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as HSMLogEntry);
}

/**
 * Filter out non-replayable entries: diagnostic events and non-standard
 * log entries that don't follow the HSMLogEntry schema.
 */
export function filterReplayable(entries: HSMLogEntry[]): HSMLogEntry[] {
  return entries.filter(e => {
    if (typeof e.event === 'string') return false;
    if (typeof e.seq !== 'number') return false;
    if (DIAGNOSTIC_EVENTS.has(e.event.type)) return false;
    return true;
  });
}

/**
 * Filter to only user/lifecycle input events (excluding system events).
 */
export function filterInputsOnly(entries: HSMLogEntry[]): HSMLogEntry[] {
  return filterReplayable(entries).filter(e =>
    INPUT_EVENTS.has(e.event.type)
  );
}

/**
 * A gap in the recording where entry[i].to !== entry[i+1].from.
 */
export interface Gap {
  index: number;
  expectedFrom: string;
  actualFrom: string;
}

/**
 * Detect gaps in the recording where re-entrant send() dropped outer events.
 */
export function detectGaps(entries: HSMLogEntry[]): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].from !== entries[i - 1].to) {
      gaps.push({
        index: i,
        expectedFrom: entries[i - 1].to,
        actualFrom: entries[i].from,
      });
    }
  }
  return gaps;
}

// =============================================================================
// Doc-Content Snapshots
// =============================================================================

export interface DocContentSnapshot {
  local: { content: string; stateVector: string };
  remote: { content: string; stateVector: string };
  server?: { content: string; stateVector: string; updateSize: number };
  disk?: string | null;
}

/**
 * Capture doc-content state from a TestHSM.
 */
export function captureDocContent(hsm: TestHSM): DocContentSnapshot {
  const localDoc = hsm.hsm.getLocalDoc();
  const remoteDoc = hsm.hsm.getRemoteDoc();

  const localContent = localDoc?.getText('contents').toString() ?? '';
  const localSV = localDoc
    ? Buffer.from(Y.encodeStateVector(localDoc)).toString('base64')
    : '';

  const remoteContent = remoteDoc?.getText('contents').toString() ?? '';
  const remoteSV = remoteDoc
    ? Buffer.from(Y.encodeStateVector(remoteDoc)).toString('base64')
    : '';

  return {
    local: { content: localContent, stateVector: localSV },
    remote: { content: remoteContent, stateVector: remoteSV },
  };
}

/**
 * Capture doc-content state from a vault in a CrossVaultTest,
 * including server state.
 */
export function captureDocContentCrossVault(
  ctx: CrossVaultTest,
  vault: 'A' | 'B',
): DocContentSnapshot {
  const handle = vault === 'A' ? ctx.vaultA : ctx.vaultB;
  const snapshot = captureDocContent(handle.hsm);

  const serverContent = ctx.server.getText('contents').toString();
  const serverSV = Buffer.from(Y.encodeStateVector(ctx.server)).toString('base64');
  const serverUpdate = Y.encodeStateAsUpdate(ctx.server);

  snapshot.server = {
    content: serverContent,
    stateVector: serverSV,
    updateSize: serverUpdate.byteLength,
  };

  snapshot.disk = handle.disk.content;
  return snapshot;
}

/**
 * Assert that actual doc-content matches a production snapshot file.
 */
export function assertMatchesSnapshot(
  actual: DocContentSnapshot,
  snapshotPath: string,
): void {
  const expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));

  if (expected.local?.content !== undefined) {
    expect(actual.local.content).toBe(expected.local.content);
  }
  if (expected.remote?.content !== undefined) {
    expect(actual.remote.content).toBe(expected.remote.content);
  }
  if (expected.server?.content !== undefined && actual.server) {
    expect(actual.server.content).toBe(expected.server.content);
  }
}

/**
 * Assert conflict data from an HSM.
 */
export function assertConflictData(
  hsm: TestHSM,
  expected: {
    base?: string;
    oursContains?: string;
    theirsContains?: string;
  },
): void {
  const conflictData = hsm.hsm.getConflictData();
  expect(conflictData).not.toBeNull();
  if (expected.base !== undefined) {
    expect(conflictData!.base).toBe(expected.base);
  }
  if (expected.oursContains !== undefined) {
    expect(conflictData!.ours).toContain(expected.oursContains);
  }
  if (expected.theirsContains !== undefined) {
    expect(conflictData!.theirs).toContain(expected.theirsContains);
  }
}

// =============================================================================
// Cross-Vault Replay Driver
// =============================================================================

export interface RecordedEvent {
  vault: 'A' | 'B';
  seq: number;
  type: string;
  from: string;
  to: string;
  event: Record<string, any>;
}

export interface ReplayOptions {
  /** Callback at specific seq numbers for mid-replay assertions. */
  checkpoints?: Record<number, (ctx: CrossVaultTest) => void | Promise<void>>;
  /** Whether to sync between vaults after each input event (default: false). */
  autoSync?: boolean;
  /** Maximum divergences before aborting (default: 10). */
  maxDivergences?: number;
  /** State transitions to tolerate as equivalent (fast-path). */
  fastPathRules?: Array<{ expected: string; actual: string }>;
}

export interface ReplayResult {
  divergences: string[];
  transitions: {
    A: Array<{ event: string; from: string; to: string }>;
    B: Array<{ event: string; from: string; to: string }>;
  };
}

/**
 * Default fast-path rules for mock persistence (syncs synchronously,
 * skipping intermediate states that production pauses at).
 */
export const DEFAULT_FAST_PATH_RULES = [
  { expected: 'active.entering.awaitingPersistence', actual: 'active.tracking' },
  { expected: 'active.entering.awaitingPersistence', actual: 'active.conflict.bannerShown' },
  { expected: 'unloading', actual: 'idle.synced' },
  { expected: 'unloading', actual: 'idle.diverged' },
  { expected: 'idle.diskAhead', actual: 'idle.diverged' },
];

/**
 * Replay recorded input events against a cross-vault digital twin.
 * System events are skipped (they should emerge from the integration layer).
 */
export async function replayInputsAgainstTwin(
  ctx: CrossVaultTest,
  events: RecordedEvent[],
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const {
    checkpoints = {},
    autoSync = false,
    maxDivergences = 10,
    fastPathRules = DEFAULT_FAST_PATH_RULES,
  } = options;

  const divergences: string[] = [];
  const transitionsA: Array<{ event: string; from: string; to: string }> = [];
  const transitionsB: Array<{ event: string; from: string; to: string }> = [];

  ctx.vaultA.hsm.hsm.onStateChange((from, to, event) => {
    transitionsA.push({ event: event.type, from, to });
  });
  ctx.vaultB.hsm.hsm.onStateChange((from, to, event) => {
    transitionsB.push({ event: event.type, from, to });
  });

  for (const recorded of events) {
    const { vault, seq, type: eventType, from: expectedFrom, to: expectedTo } = recorded;
    const vaultHandle = vault === 'A' ? ctx.vaultA : ctx.vaultB;

    // Skip system events
    if (SYSTEM_EVENTS.has(eventType)) continue;
    if (eventType.startsWith('done.invoke') || eventType.startsWith('error.invoke')) continue;

    // Check pre-state
    const actualFrom = vaultHandle.hsm.statePath;
    const preStateFastPath = fastPathRules.some(
      r => r.expected === expectedFrom && r.actual === actualFrom,
    );
    if (actualFrom !== expectedFrom && !preStateFastPath) {
      if (expectedFrom === 'unloaded' && actualFrom !== 'unloaded') {
        vaultHandle.send({ type: 'UNLOAD' });
        try { await vaultHandle.hsm.hsm.awaitCleanup(); } catch {}
        await new Promise(r => setTimeout(r, 10));
      }
      const newActual = vaultHandle.hsm.statePath;
      if (newActual !== expectedFrom) {
        divergences.push(
          `${vault} seq ${seq} (${eventType}): pre-state expected=${expectedFrom}, actual=${newActual}`,
        );
        if (divergences.length >= maxDivergences) break;
        continue;
      }
    }

    // Replay input event
    try {
      const mergeEvent = deserializeEvent(recorded.event as unknown as SerializableEvent);
      vaultHandle.send(mergeEvent);
    } catch (err: any) {
      divergences.push(`${vault} seq ${seq} (${eventType}): CRASH — ${err.message}`);
      break;
    }

    // Wait for async operations
    if (eventType === 'RELEASE_LOCK') {
      try { await vaultHandle.hsm.hsm.awaitCleanup(); } catch {}
    }
    if (eventType === 'DISK_CHANGED') {
      await new Promise(r => setTimeout(r, 20));
      try { await vaultHandle.hsm.awaitIdleAutoMerge(); } catch {}
    }

    if (autoSync) ctx.sync();

    // Let deferred provider sync fire
    await new Promise(r => setTimeout(r, 5));

    // Run checkpoint
    if (checkpoints[seq]) {
      await checkpoints[seq](ctx);
    }

    // Check post-state
    const actualTo = vaultHandle.hsm.statePath;
    const postStateFastPath = fastPathRules.some(
      r => r.expected === expectedTo && r.actual === actualTo,
    );
    if (actualTo !== expectedTo && !postStateFastPath) {
      divergences.push(
        `${vault} seq ${seq} (${eventType}): post-state expected=${expectedTo}, actual=${actualTo}`,
      );
      if (divergences.length >= maxDivergences) break;
    }
  }

  return {
    divergences,
    transitions: { A: transitionsA, B: transitionsB },
  };
}
