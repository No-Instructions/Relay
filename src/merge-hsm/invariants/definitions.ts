/**
 * Invariant Definitions
 *
 * Standard invariants for MergeHSM that verify state consistency.
 */

import type { InvariantDefinition, InvariantCheckContext, InvariantViolation } from './types';
import type { YjsSnapshot } from '../snapshots';
import { snapshotContains, snapshotStateVector } from '../snapshots';

/**
 * What `local` lacks of `target`: per client, the clock local stands at
 * against the clock target reached. Equal clocks with containment failing
 * mean the gap is tombstones only.
 */
function describeGap(local: YjsSnapshot, target: YjsSnapshot): Record<string, unknown> {
  const localSv = snapshotStateVector(local);
  const behind: Record<string, string> = {};
  for (const [client, clock] of snapshotStateVector(target)) {
    const have = localSv.get(client) ?? 0;
    if (have < clock) behind[String(client)] = `${have}<${clock}`;
  }
  return Object.keys(behind).length > 0
    ? { structsBehind: behind }
    : { structsBehind: {}, gap: 'tombstones only' };
}

// =============================================================================
// Active Mode Invariants
// =============================================================================

/**
 * The open editor matches localDoc in active.tracking, and in
 * active.reading without a preserved fork.
 */
export const EDITOR_MATCHES_LOCAL_DOC: InvariantDefinition = {
  id: 'editor-matches-local-doc',
  name: 'Editor matches localDoc',
  description: 'In active.tracking and fork-free active.reading, editor content should match localDoc content',
  severity: 'warning',
  trigger: 'on-state',
  applicableStates: ['active.tracking', 'active.reading'],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    if (ctx.editorText === null || ctx.localDocText === null) {
      return null; // Can't check without both values
    }
    if (ctx.statePath.startsWith('active.reading') && ctx.hasFork) {
      return null; // Fork freezes localDoc; the editor renders remoteDoc
    }
    if (ctx.statePath === 'active.reading.repairing') {
      return null; // localDoc is being rebuilt
    }

    if (ctx.editorText !== ctx.localDocText) {
      return {
        invariantId: 'editor-matches-local-doc',
        severity: 'warning',
        timestamp: ctx.now(),
        message: `Editor text does not match localDoc text (drift detected)`,
        statePath: ctx.statePath,
        expected: ctx.localDocText.substring(0, 100) + (ctx.localDocText.length > 100 ? '...' : ''),
        actual: ctx.editorText.substring(0, 100) + (ctx.editorText.length > 100 ? '...' : ''),
        context: {
          editorLength: ctx.editorText.length,
          localDocLength: ctx.localDocText.length,
        },
      };
    }

    return null;
  },
};

/**
 * In active.tracking, localDoc should not be behind remoteDoc.
 */
export const LOCAL_NOT_BEHIND_REMOTE: InvariantDefinition = {
  id: 'local-not-behind-remote',
  name: 'localDoc not behind remoteDoc',
  description:
    'In active.tracking and idle.synced, localDoc contains every op and deletion of the remote head the machine has processed, ' +
    'unless a fork or the local-only gate is deliberately holding remote updates back',
  severity: 'warning',
  trigger: 'on-state',
  applicableStates: ['active.tracking', 'idle.synced'],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    // Checked as the machine enters the state, which is when it claims
    // convergence. Within the state a session can fill the replica before
    // the machine processes it; that window is catch-up, not a violation.
    if (ctx.previousStatePath === ctx.statePath) return null;
    // A fork preserves local state against the remote, and the local-only
    // gate withholds inbound updates: either keeps local behind by design.
    if (ctx.hasFork || ctx.localOnly) return null;
    // Compared with the remote head the machine has been handed, and only
    // where the live replica holds it. A provider can write the next update
    // into the replica while the merge of the previous one is finishing,
    // and that update's own event merges it; a head the replica does not
    // hold describes nothing local could have merged.
    const remote = ctx.processedRemote;
    const replica = remote ? ctx.remoteSnapshot() : null;
    if (!remote || !replica || !snapshotContains(replica, remote)) return null;
    const local = ctx.localSnapshot();
    if (!local || snapshotContains(local, remote)) return null;
    return {
      invariantId: 'local-not-behind-remote',
      severity: 'warning',
      timestamp: ctx.now(),
      message: `localDoc is missing ops or deletions the remoteDoc has`,
      statePath: ctx.statePath,
      context: describeGap(local, remote),
    };
  },
};

/**
 * idle.synced means neither side holds anything the merge base lacks, by the
 * machine's own records. Classification at load requires exactly this; every
 * other route into the state must honour it too, or a recorded change is
 * dropped while the document reads as settled.
 */
export const SYNCED_MATCHES_MERGE_BASE: InvariantDefinition = {
  id: 'synced-matches-merge-base',
  name: 'Synced implies recorded heads within the merge base',
  description:
    'On entering idle.synced, the recorded local and remote heads hold no ops or deletions the LCA lacks',
  severity: 'error',
  trigger: 'on-state',
  applicableStates: ['idle.synced'],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    if (ctx.previousStatePath === ctx.statePath) return null;
    // A merge's baseline is held until the executor confirms the disk write
    // that carries it; until then the recorded heads lead it by design.
    if (ctx.diskWritePending) return null;
    const { local, remote, lca } = ctx.recorded;
    if (!lca) return null;
    const ahead: string[] = [];
    if (local && !snapshotContains(lca, local)) ahead.push('local');
    if (remote && !snapshotContains(lca, remote)) ahead.push('remote');
    if (ahead.length === 0) return null;
    return {
      invariantId: 'synced-matches-merge-base',
      severity: 'error',
      timestamp: ctx.now(),
      message: `entered idle.synced with recorded ${ahead.join(' and ')} head ahead of the merge base`,
      statePath: ctx.statePath,
      context: { ahead, enteredFrom: ctx.previousStatePath },
    };
  },
};

// =============================================================================
// Sync State Invariants
// =============================================================================

/**
 * When syncStatus is 'synced', disk hash should match LCA hash.
 */
export const SYNCED_MEANS_DISK_MATCHES_LCA: InvariantDefinition = {
  id: 'synced-means-disk-matches-lca',
  name: 'Synced implies disk matches LCA',
  description: 'When status is synced, disk hash should equal LCA hash',
  severity: 'error',
  trigger: 'on-state',
  applicableStates: ['idle.synced'],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    if (ctx.syncStatus !== 'synced') {
      return null; // Only applies when synced
    }
    // TODO: idle.synced is entered before the executor confirms the write
    // that brings disk to the LCA; until settling waits for confirmation,
    // the window is exempt.
    if (ctx.diskWritePending) return null;

    if (ctx.disk.hash === null || ctx.lca.hash === null) {
      return null; // Can't check without hashes
    }

    if (ctx.disk.hash !== ctx.lca.hash) {
      return {
        invariantId: 'synced-means-disk-matches-lca',
        severity: 'error',
        timestamp: ctx.now(),
        message: `Status is synced but disk hash does not match LCA hash`,
        statePath: ctx.statePath,
        expected: ctx.lca.hash,
        actual: ctx.disk.hash,
        context: {
          diskMtime: ctx.disk.mtime,
          lcaMtime: ctx.lca.mtime,
        },
      };
    }

    return null;
  },
};

/**
 * Disk mtime should be >= LCA mtime (disk shouldn't be older than LCA).
 */
export const DISK_NOT_OLDER_THAN_LCA: InvariantDefinition = {
  id: 'disk-not-older-than-lca',
  name: 'Disk not older than LCA',
  description: 'Disk mtime should be >= LCA mtime',
  severity: 'warning',
  trigger: 'always',
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    if (ctx.disk.mtime === null || ctx.lca.mtime === null) {
      return null;
    }

    if (ctx.disk.mtime < ctx.lca.mtime) {
      return {
        invariantId: 'disk-not-older-than-lca',
        severity: 'warning',
        timestamp: ctx.now(),
        message: `Disk mtime (${ctx.disk.mtime}) is older than LCA mtime (${ctx.lca.mtime})`,
        statePath: ctx.statePath,
        expected: `>= ${ctx.lca.mtime}`,
        actual: ctx.disk.mtime,
      };
    }

    return null;
  },
};

// =============================================================================
// State Transition Invariants
// =============================================================================

/**
 * Should not be in active state without localDoc.
 */
export const ACTIVE_HAS_LOCAL_DOC: InvariantDefinition = {
  id: 'active-has-local-doc',
  name: 'Active mode has localDoc',
  description: 'When in active.* state, localDoc should exist',
  severity: 'critical',
  trigger: 'on-state',
  applicableStates: [
    'active.entering',
    'active.entering.awaitingPersistence',
    'active.entering.reconciling',
    'active.tracking',
    'active.reading',
    'active.merging.twoWay',
    'active.merging.threeWay',
    'active.conflict.bannerShown',
    'active.conflict.resolving',
  ],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    if (ctx.statePath === 'active.reading.repairing') {
      return null; // localDoc is intentionally absent during the rebuild
    }
    if (ctx.statePath.startsWith('active.') && ctx.localDocText === null) {
      return {
        invariantId: 'active-has-local-doc',
        severity: 'critical',
        timestamp: ctx.now(),
        message: `In active mode (${ctx.statePath}) but localDoc is null`,
        statePath: ctx.statePath,
      };
    }

    return null;
  },
};

/**
 * Should not be in idle state with localDoc still loaded.
 * (Memory efficiency - docs should be unloaded in idle mode)
 */
export const IDLE_NO_LOCAL_DOC: InvariantDefinition = {
  id: 'idle-no-local-doc',
  name: 'Idle mode has no localDoc',
  description: 'When in idle.* state, localDoc should be null (memory efficiency)',
  severity: 'warning',
  trigger: 'on-state',
  applicableStates: [
    'idle.loading',
    'idle.synced',
    'idle.localAhead',
    'idle.remoteAhead',
    'idle.diskAhead',
    'idle.diverged',
  ],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    if (ctx.statePath.startsWith('idle.') && ctx.localDocText !== null) {
      return {
        invariantId: 'idle-no-local-doc',
        severity: 'warning',
        timestamp: ctx.now(),
        message: `In idle mode (${ctx.statePath}) but localDoc is still loaded (memory leak)`,
        statePath: ctx.statePath,
      };
    }

    return null;
  },
};

// =============================================================================
// Conflict Invariants
// =============================================================================

/**
 * In conflict state, should have divergent content.
 */
export const CONFLICT_HAS_DIVERGENCE: InvariantDefinition = {
  id: 'conflict-has-divergence',
  name: 'Conflict state has actual divergence',
  description:
    'When in conflict state, something actually diverges: disk from the LCA, a fork, or local from remote',
  severity: 'warning',
  trigger: 'on-state',
  applicableStates: [
    'active.conflict.bannerShown',
    'active.conflict.resolving',
    'idle.conflict',
  ],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    if (!ctx.statePath.includes('conflict')) {
      return null;
    }

    // A conflict between a fork, or the local CRDT, and the remote leaves
    // disk at the LCA; only a conflict where nothing diverges is suspicious.
    if (ctx.hasFork) return null;
    if (
      ctx.localDocText !== null &&
      ctx.remoteDocText !== null &&
      ctx.localDocText !== ctx.remoteDocText
    ) {
      return null;
    }
    if (
      ctx.disk.hash !== null &&
      ctx.lca.hash !== null &&
      ctx.disk.hash === ctx.lca.hash
    ) {
      return {
        invariantId: 'conflict-has-divergence',
        severity: 'warning',
        timestamp: ctx.now(),
        message: `In conflict state but disk equals the LCA and local equals remote (false conflict?)`,
        statePath: ctx.statePath,
        context: {
          diskHash: ctx.disk.hash,
          lcaHash: ctx.lca.hash,
        },
      };
    }

    return null;
  },
};

/** In active.reading with a preserved fork, the editor renders remoteDoc. */
export const READING_EDITOR_MATCHES_SHARED: InvariantDefinition = {
  id: 'reading-editor-matches-shared',
  name: 'Reading editor matches shared version',
  description: 'In active.reading with a preserved fork, editor content should match remoteDoc content',
  severity: 'warning',
  trigger: 'on-state',
  applicableStates: ['active.reading'],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    if (ctx.statePath !== 'active.reading' || !ctx.hasFork) {
      return null;
    }
    if (ctx.editorText === null || ctx.remoteDocText === null) {
      return null;
    }
    if (ctx.editorText !== ctx.remoteDocText) {
      return {
        invariantId: 'reading-editor-matches-shared',
        severity: 'warning',
        timestamp: ctx.now(),
        message: 'Read-mode editor does not match the shared remote version',
        statePath: ctx.statePath,
        expected: ctx.remoteDocText.substring(0, 100) + (ctx.remoteDocText.length > 100 ? '...' : ''),
        actual: ctx.editorText.substring(0, 100) + (ctx.editorText.length > 100 ? '...' : ''),
      };
    }
    return null;
  },
};

// =============================================================================
// All Standard Invariants
// =============================================================================

/**
 * All standard invariants to check.
 */
//
// Not standard: IDLE_NO_LOCAL_DOC predates warm idle — every idle state now
// declares localDoc optional and the resource contracts enforce residency.
// DISK_NOT_OLDER_THAN_LCA compares a filesystem mtime with this machine's
// clock, which are not comparable (external tools, clock skew, restores).
export const STANDARD_INVARIANTS: InvariantDefinition[] = [
  EDITOR_MATCHES_LOCAL_DOC,
  LOCAL_NOT_BEHIND_REMOTE,
  SYNCED_MATCHES_MERGE_BASE,
  SYNCED_MEANS_DISK_MATCHES_LCA,
  ACTIVE_HAS_LOCAL_DOC,
  CONFLICT_HAS_DIVERGENCE,
  READING_EDITOR_MATCHES_SHARED,
];

/**
 * Get invariants applicable to a specific state.
 */
export function getInvariantsForState(
  statePath: string,
  invariants: InvariantDefinition[] = STANDARD_INVARIANTS
): InvariantDefinition[] {
  return invariants.filter((inv) => {
    // Always applicable if no specific states defined
    if (!inv.applicableStates || inv.applicableStates.length === 0) {
      return true;
    }

    // Check if current state matches any applicable state
    return inv.applicableStates.some((applicable) =>
      statePath === applicable || statePath.startsWith(applicable + '.')
    );
  });
}

/**
 * Get invariants by trigger type.
 */
export function getInvariantsByTrigger(
  trigger: InvariantDefinition['trigger'],
  invariants: InvariantDefinition[] = STANDARD_INVARIANTS
): InvariantDefinition[] {
  return invariants.filter((inv) => inv.trigger === trigger);
}
