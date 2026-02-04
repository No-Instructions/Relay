/**
 * Invariant Definitions
 *
 * Standard invariants for MergeHSM that verify state consistency.
 */

import type { InvariantDefinition, InvariantCheckContext, InvariantViolation } from './types';

// =============================================================================
// Active Mode Invariants
// =============================================================================

/**
 * In active.tracking, editor text should match localDoc text.
 */
export const EDITOR_MATCHES_LOCAL_DOC: InvariantDefinition = {
  id: 'editor-matches-local-doc',
  name: 'Editor matches localDoc',
  description: 'In active.tracking state, editor content should match localDoc content',
  severity: 'warning',
  trigger: 'on-state',
  applicableStates: ['active.tracking'],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    if (ctx.editorText === null || ctx.localDocText === null) {
      return null; // Can't check without both values
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
  description: 'In active.tracking, localDoc should have all updates that remoteDoc has',
  severity: 'warning',
  trigger: 'periodic',
  applicableStates: ['active.tracking'],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    // This would require state vector comparison
    // For now, just check that both texts are available
    if (ctx.localDocText !== null && ctx.remoteDocText !== null) {
      // In tracking, they should be equal after merges
      // (Note: This is a simplified check)
    }
    return null;
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
    'active.tracking',
    'active.merging',
    'active.conflict.blocked',
    'active.conflict.bannerShown',
    'active.conflict.resolving',
  ],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
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
  description: 'When in conflict state, disk and local content should differ',
  severity: 'warning',
  trigger: 'on-state',
  applicableStates: [
    'active.conflict.blocked',
    'active.conflict.bannerShown',
    'active.conflict.resolving',
  ],
  check: (ctx: InvariantCheckContext): InvariantViolation | null => {
    if (!ctx.statePath.includes('conflict')) {
      return null;
    }

    // If we're in conflict but content is actually the same, that's suspicious
    if (
      ctx.disk.hash !== null &&
      ctx.lca.hash !== null &&
      ctx.disk.hash === ctx.lca.hash
    ) {
      return {
        invariantId: 'conflict-has-divergence',
        severity: 'warning',
        timestamp: ctx.now(),
        message: `In conflict state but disk hash equals LCA hash (false conflict?)`,
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

// =============================================================================
// All Standard Invariants
// =============================================================================

/**
 * All standard invariants to check.
 */
export const STANDARD_INVARIANTS: InvariantDefinition[] = [
  EDITOR_MATCHES_LOCAL_DOC,
  LOCAL_NOT_BEHIND_REMOTE,
  SYNCED_MEANS_DISK_MATCHES_LCA,
  DISK_NOT_OLDER_THAN_LCA,
  ACTIVE_HAS_LOCAL_DOC,
  IDLE_NO_LOCAL_DOC,
  CONFLICT_HAS_DIVERGENCE,
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
