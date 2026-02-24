/**
 * Machine Definition
 *
 * Declarative state machine definition for MergeHSM.
 * Contains the MACHINE constant (the single source of truth for all state
 * transitions) and a factory for the InterpreterConfig.
 *
 * Guards, actions, and invoke sources are bound per-instance by MergeHSM
 * (via buildGuards/buildActions/buildInvokeSources) because they need
 * closure access to private HSM state.
 */

import type {
	StatePath,
	MachineDefinition,
	InterpreterConfig,
	GuardFn,
	ActionFn,
	InvokeSourceFn,
	EventHandler,
	TransitionCandidate,
} from "./types";
import { normalizeToCandidates } from "./machine-interpreter";

// =============================================================================
// Machine Definition
// =============================================================================

/**
 * The declarative state machine definition.
 * Maps state paths to state nodes with event handlers, invokes, and always-transitions.
 * This is the single source of truth for all MergeHSM state transitions.
 */
export const MACHINE: MachineDefinition = {
	// =========================================================================
	// Loading/unloading states
	// =========================================================================

	'unloaded': {
		on: {
			LOAD: { target: 'loading', actions: ['initializeFromLoad'] },
		},
	},

	'loading': {
		on: {
			PERSISTENCE_LOADED: { target: 'loading', actions: ['storePersistenceData'] },
			SET_MODE_ACTIVE: 'active.loading',
			SET_MODE_IDLE: { target: 'idle.loading', actions: ['initIdleMode'] },
			REMOTE_UPDATE: { target: 'loading', actions: ['applyRemoteToRemoteDoc', 'accumulateRemoteUpdate'] },
			DISK_CHANGED: { target: 'loading', actions: ['storeDiskMetadata', 'accumulateDiskChanged'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
		},
	},

	'unloading': {
		invoke: {
			src: 'cleanup',
			onDone: [
				{ target: 'idle.diverged', guard: 'cleanupWasConflict' },
				{ target: 'idle.loading', guard: 'cleanupWasReleaseLock' },
				{ target: 'unloaded' },
			],
			onError: [
				{ target: 'idle.loading', guard: 'cleanupWasReleaseLock' },
				{ target: 'unloaded' },
			],
		},
	},

	// =========================================================================
	// Idle states
	// =========================================================================

	'idle.loading': {
		entry: ['ensureLocalDocForIdle', 'processAccumulatedForIdle'],
		always: [
			{ target: 'idle.synced', guard: 'allSyncedAtLoad' },
			{ target: 'idle.localAhead', guard: 'localAheadAtLoad' },
			{ target: 'idle.remoteAhead', guard: 'remoteAheadAtLoad' },
			{ target: 'idle.diskAhead', guard: 'diskAheadAtLoad' },
			{ target: 'idle.diverged' }, // Default fallback
		],
	},

	'idle.synced': {
		on: {
			REMOTE_UPDATE: [
				{ target: 'idle.diverged', guard: 'diskChangedSinceLCA', actions: ['applyRemoteToRemoteDoc', 'storePendingRemoteUpdate'] },
				{ target: 'idle.remoteAhead', actions: ['applyRemoteToRemoteDoc', 'storePendingRemoteUpdate'] },
			],
			DISK_CHANGED: [
				{ target: 'idle.synced', guard: 'diskMatchesLCA', actions: ['storeDiskMetadata', 'updateLCAMtime'] },
				{ target: 'idle.diverged', guard: 'remoteOrLocalAhead', actions: ['storeDiskMetadata'] },
				{ target: 'idle.diskAhead', actions: ['storeDiskMetadata'] },
			],
			ACQUIRE_LOCK: { target: 'active.entering.awaitingPersistence', actions: ['storeEditorContent'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
			LOAD: { target: 'loading', actions: ['initializeFromLoad'] },
			ERROR: { target: 'idle.error', actions: ['storeError'] },
		},
	},

	'idle.localAhead': {
		entry: ['ensureLocalDocForIdle'],
		invoke: {
			src: 'fork-reconcile',
			onDone: [
				{ target: 'idle.synced', guard: 'mergeSucceeded', actions: ['clearForkAndUpdateLCA'] },
				{ target: 'idle.localAhead', guard: 'awaitingProvider' },
				{ target: 'idle.diverged', actions: ['clearForkKeepDiverged'] },
			],
			onError: { target: 'idle.diverged', actions: ['clearForkKeepDiverged'] },
		},
		on: {
			PROVIDER_SYNCED: { target: 'idle.localAhead', actions: ['markProviderSynced'], reenter: true },
			REMOTE_UPDATE: [
				// If fork exists, stay in localAhead and accumulate - fork-reconcile will handle it
				{ target: 'idle.localAhead', guard: 'hasFork', actions: ['applyRemoteToRemoteDoc', 'storePendingRemoteUpdate'] },
				{ target: 'idle.diverged', guard: 'diskChangedSinceLCA', actions: ['applyRemoteToRemoteDoc', 'storePendingRemoteUpdate'] },
				{ target: 'idle.localAhead', actions: ['applyRemoteToRemoteDoc', 'storePendingRemoteUpdate'] },
			],
			DISK_CHANGED: [
				{ target: 'idle.localAhead', guard: 'diskMatchesLCA', actions: ['storeDiskMetadata', 'updateLCAMtime'] },
				{ target: 'idle.localAhead', actions: ['storeDiskMetadata', 'ingestDiskToLocalDoc'], reenter: true },
			],
			ACQUIRE_LOCK: { target: 'active.entering.awaitingPersistence', actions: ['storeEditorContent'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
			LOAD: { target: 'loading', actions: ['initializeFromLoad'] },
			ERROR: { target: 'idle.error', actions: ['storeError'] },
		},
	},

	'idle.remoteAhead': {
		entry: ['ensureLocalDocForIdle'],
		invoke: {
			src: 'idle-merge',
			onDone: [
				{ target: 'idle.synced', guard: 'mergeSucceeded', actions: ['updateLCAFromInvokeResult'] },
				{ target: 'idle.diverged' },
			],
			onError: { target: 'idle.diverged' },
		},
		on: {
			DISK_CHANGED: { target: 'idle.diverged', actions: ['storeDiskMetadata'] },
			REMOTE_UPDATE: { target: 'idle.remoteAhead', actions: ['applyRemoteToRemoteDoc', 'storePendingRemoteUpdate'], reenter: true },
			ACQUIRE_LOCK: { target: 'active.entering.awaitingPersistence', actions: ['storeEditorContent'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
			LOAD: { target: 'loading', actions: ['initializeFromLoad'] },
			ERROR: { target: 'idle.error', actions: ['storeError'] },
		},
	},

	'idle.diskAhead': {
		entry: ['ensureLocalDocForIdle'],
		invoke: {
			src: 'idle-merge',
			onDone: [
				{ target: 'idle.synced', guard: 'mergeSucceeded', actions: ['updateLCAFromInvokeResult'] },
				{ target: 'idle.localAhead', guard: 'forkWasCreated' },
				{ target: 'idle.diverged' },
			],
			onError: { target: 'idle.diverged' },
		},
		on: {
			REMOTE_UPDATE: { target: 'idle.diverged', actions: ['applyRemoteToRemoteDoc', 'storePendingRemoteUpdate'] },
			DISK_CHANGED: { target: 'idle.diskAhead', actions: ['storeDiskMetadata'], reenter: true },
			ACQUIRE_LOCK: { target: 'active.entering.awaitingPersistence', actions: ['storeEditorContent'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
			LOAD: { target: 'loading', actions: ['initializeFromLoad'] },
			ERROR: { target: 'idle.error', actions: ['storeError'] },
		},
	},

	'idle.diverged': {
		entry: ['ensureLocalDocForIdle'],
		invoke: {
			src: 'idle-merge',
			onDone: [
				{ target: 'idle.synced', guard: 'mergeSucceeded', actions: ['updateLCAFromInvokeResult'] },
				{ target: 'idle.diverged' }, // 3-way conflict — stay diverged
			],
			onError: { target: 'idle.diverged' },
		},
		on: {
			DISK_CHANGED: { target: 'idle.diverged', actions: ['storeDiskMetadata'], reenter: true },
			REMOTE_UPDATE: { target: 'idle.diverged', actions: ['applyRemoteToRemoteDoc', 'storePendingRemoteUpdate'], reenter: true },
			ACQUIRE_LOCK: { target: 'active.entering.awaitingPersistence', actions: ['storeEditorContent'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
			LOAD: { target: 'loading', actions: ['initializeFromLoad'] },
			ERROR: { target: 'idle.error', actions: ['storeError'] },
		},
	},

	'idle.error': {
		on: {
			ACQUIRE_LOCK: { target: 'active.entering.awaitingPersistence', actions: ['storeEditorContent'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
			LOAD: { target: 'loading', actions: ['initializeFromLoad'] },
		},
	},

	// =========================================================================
	// Active conflict/merging states
	// =========================================================================

	'active.merging.twoWay': {
		entry: ['replayAccumulatedEvents', 'startTwoWayMerge'],
		on: {
			RESOLVE: { target: 'active.tracking', actions: ['resolveConflict'] },
			MERGE_CONFLICT: { target: 'active.conflict.bannerShown', actions: ['storeConflictData'] },
			CM6_CHANGE: { target: 'active.merging.twoWay', actions: ['trackEditorText'] },
			REMOTE_UPDATE: { target: 'active.merging.twoWay', actions: ['applyRemoteToRemoteDoc'] },
			RELEASE_LOCK: { target: 'unloading', actions: ['beginReleaseLock'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
		},
	},

	'active.merging.threeWay': {
		entry: ['replayAccumulatedEvents', 'startThreeWayMerge'],
		on: {
			MERGE_SUCCESS: { target: 'active.tracking', actions: ['handleMergeSuccessAction'] },
			MERGE_CONFLICT: { target: 'active.conflict.bannerShown', actions: ['storeConflictData'] },
			CM6_CHANGE: { target: 'active.merging.threeWay', actions: ['trackEditorText'] },
			REMOTE_UPDATE: { target: 'active.merging.threeWay', actions: ['applyRemoteToRemoteDoc'] },
			RELEASE_LOCK: { target: 'unloading', actions: ['beginReleaseLock'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
		},
	},

	'active.conflict.bannerShown': {
		on: {
			OPEN_DIFF_VIEW: 'active.conflict.resolving',
			DISMISS_CONFLICT: { target: 'active.tracking', actions: ['storeDeferredConflict'] },
			CM6_CHANGE: { target: 'active.conflict.bannerShown', actions: ['trackEditorText'] },
			REMOTE_UPDATE: { target: 'active.conflict.bannerShown', actions: ['applyRemoteToRemoteDoc', 'accumulateRemoteUpdate'] },
			DISK_CHANGED: { target: 'active.conflict.bannerShown', actions: ['storeDiskMetadata', 'accumulateDiskChanged'] },
			RESOLVE_HUNK: { target: 'active.conflict.bannerShown', actions: ['resolveHunk'] },
			RELEASE_LOCK: { target: 'unloading', actions: ['beginReleaseLock'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
		},
	},

	'active.conflict.resolving': {
		on: {
			RESOLVE: { target: 'active.tracking', actions: ['resolveConflict'] },
			RESOLVE_HUNK: { target: 'active.conflict.resolving', actions: ['resolveHunk'] },
			CANCEL: 'active.conflict.bannerShown',
			CM6_CHANGE: { target: 'active.conflict.resolving', actions: ['trackEditorText'] },
			REMOTE_UPDATE: { target: 'active.conflict.resolving', actions: ['applyRemoteToRemoteDoc', 'accumulateRemoteUpdate'] },
			DISK_CHANGED: { target: 'active.conflict.resolving', actions: ['storeDiskMetadata', 'accumulateDiskChanged'] },
			RELEASE_LOCK: { target: 'unloading', actions: ['beginReleaseLock'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
		},
	},

	// =========================================================================
	// Active tracking + entering states
	// =========================================================================

	'active.loading': {
		on: {
			ACQUIRE_LOCK: { target: 'active.entering.awaitingPersistence', actions: ['storeEditorContent'] },
			REMOTE_UPDATE: { target: 'active.loading', actions: ['applyRemoteToRemoteDoc', 'accumulateRemoteUpdate'] },
			DISK_CHANGED: { target: 'active.loading', actions: ['storeDiskMetadata', 'accumulateDiskChanged'] },
			RELEASE_LOCK: { target: 'unloading', actions: ['beginReleaseLock'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
			ERROR: { target: 'active.loading', actions: ['storeError'] },
		},
	},

	'active.entering.awaitingPersistence': {
		entry: ['createYDocs'],
		on: {
			PERSISTENCE_SYNCED: [
				{ target: 'active.entering.reconciling', guard: 'persistenceHasContent' },
				{ target: 'active.entering.awaitingRemote', guard: 'persistenceEmptyAndProviderNotSynced' },
				{ target: 'active.entering.reconciling', actions: ['applyRemoteToLocalIfNeeded'] },
			],
			CM6_CHANGE: { target: 'active.entering.awaitingPersistence', actions: ['trackEditorText'] },
			REMOTE_UPDATE: { target: 'active.entering.awaitingPersistence', actions: ['applyRemoteToRemoteDoc', 'accumulateRemoteUpdate'] },
			DISK_CHANGED: { target: 'active.entering.awaitingPersistence', actions: ['storeDiskMetadata', 'accumulateDiskChanged'] },
			RELEASE_LOCK: { target: 'unloading', actions: ['beginReleaseLock'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
			ERROR: { target: 'active.entering.awaitingPersistence', actions: ['storeError'] },
		},
	},

	'active.entering.awaitingRemote': {
		on: {
			PROVIDER_SYNCED: { target: 'active.entering.reconciling', actions: ['applyRemoteToLocalIfNeeded'] },
			CM6_CHANGE: { target: 'active.entering.awaitingRemote', actions: ['trackEditorText'] },
			REMOTE_UPDATE: { target: 'active.entering.awaitingRemote', actions: ['applyRemoteToRemoteDoc', 'accumulateRemoteUpdate'] },
			CONNECTED: 'active.entering.awaitingRemote',
			RELEASE_LOCK: { target: 'unloading', actions: ['beginReleaseLock'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
			ERROR: { target: 'active.entering.awaitingRemote', actions: ['storeError'] },
		},
	},

	'active.entering.reconciling': {
		always: [
			{ target: 'active.conflict.bannerShown', guard: 'hasPreexistingConflict', actions: ['clearEnteringState'] },
			{ target: 'active.tracking', guard: 'contentMatchesAtReconcile', actions: ['clearEnteringState'] },
			{ target: 'active.merging.twoWay', guard: 'isRecoveryMode', actions: ['clearEnteringState'] },
			{ target: 'active.merging.threeWay', actions: ['clearEnteringState'] },
		],
	},

	'active.tracking': {
		entry: ['mergeRemoteToLocal', 'replayAccumulatedEvents'],
		on: {
			CM6_CHANGE: [
				{ target: 'active.tracking', guard: 'isFromYjs' },
				{ target: 'active.tracking', actions: ['applyCM6ToLocalDoc'] },
			],
			REMOTE_DOC_UPDATED: { target: 'active.tracking', actions: ['mergeRemoteToLocal'] },
			REMOTE_UPDATE: { target: 'active.tracking', actions: ['applyRemoteToRemoteDoc', 'mergeRemoteToLocal'] },
			SAVE_COMPLETE: { target: 'active.tracking', actions: ['updateDiskFromSave'] },
			DISK_CHANGED: { target: 'active.tracking', actions: ['storeDiskMetadataOnly'] },
			CONNECTED: { target: 'active.tracking', actions: ['flushPendingToRemote'] },
			DISCONNECTED: { target: 'active.tracking', actions: ['setOffline'] },
			PROVIDER_SYNCED: { target: 'active.tracking', actions: ['markProviderSynced', 'reconcileForkInActive'] },
			MERGE_CONFLICT: { target: 'active.conflict.bannerShown', actions: ['storeConflictData'] },
			RELEASE_LOCK: { target: 'unloading', actions: ['beginReleaseLock'] },
			UNLOAD: { target: 'unloading', actions: ['beginUnload'] },
			ERROR: { target: 'active.tracking', actions: ['storeError'] },
		},
	},
};

// =============================================================================
// Default Lookup Tables (empty — overridden per-instance by MergeHSM)
// =============================================================================

// Guards, actions, and invoke sources are bound per-instance because they
// need closure access to private MergeHSM state. These empty defaults exist
// for createInterpreterConfig() and for test convenience.

export const guards: Record<string, GuardFn> = {};

export const actions: Record<string, ActionFn> = {};

export const invokeSources: Record<string, InvokeSourceFn> = {};

// =============================================================================
// Interpreter Config Factory
// =============================================================================

/**
 * Create the InterpreterConfig for the MergeHSM.
 * Uses the module-level lookup tables by default.
 * Overrideable for testing.
 */
export function createInterpreterConfig(
	overrides?: Partial<InterpreterConfig>,
): InterpreterConfig {
	return {
		guards: overrides?.guards ?? guards,
		actions: overrides?.actions ?? actions,
		invokeSources: overrides?.invokeSources ?? invokeSources,
	};
}

// =============================================================================
// Transition Derivation (for consistency testing)
// =============================================================================

/**
 * Derive a transitions table from the MACHINE definition.
 * For each state, collects all unique target states reachable via:
 * - `on` event handlers (direct targets + candidate targets)
 * - `invoke.onDone` / `invoke.onError` handlers
 * - `always` transitions
 *
 * Useful for visualization and consistency testing.
 */
export function deriveTransitions(
	machine: MachineDefinition,
): Partial<Record<StatePath, StatePath[]>> {
	const result: Partial<Record<StatePath, StatePath[]>> = {};

	for (const [statePathStr, node] of Object.entries(machine)) {
		if (!node) continue;
		const statePath = statePathStr as StatePath;
		const targets = new Set<StatePath>();

		// Collect targets from `on` handlers
		if (node.on) {
			for (const handler of Object.values(node.on)) {
				collectTargets(handler, targets);
			}
		}

		// Collect targets from `invoke`
		if (node.invoke) {
			collectTargets(node.invoke.onDone, targets);
			if (node.invoke.onError) {
				collectTargets(node.invoke.onError, targets);
			}
		}

		// Collect targets from `always`
		if (node.always) {
			for (const candidate of node.always) {
				targets.add(candidate.target);
			}
		}

		if (targets.size > 0) {
			result[statePath] = [...targets].sort();
		}
	}

	return result;
}

/**
 * Collect all target states from an EventHandler.
 */
function collectTargets(handler: EventHandler, targets: Set<StatePath>): void {
	const candidates = normalizeToCandidates(handler);
	for (const c of candidates) {
		targets.add(c.target);
	}
}

// =============================================================================
// Consistency Validation
// =============================================================================

/**
 * Validate that all named references in the MACHINE definition exist in the
 * lookup tables. Returns an array of error messages (empty = valid).
 */
export function validateMachine(
	machine: MachineDefinition,
	config: InterpreterConfig,
): string[] {
	const errors: string[] = [];

	for (const [statePathStr, node] of Object.entries(machine)) {
		if (!node) continue;
		const statePath = statePathStr as StatePath;
		const ctx = `state '${statePath}'`;

		// Validate entry/exit actions
		validateActionNames(node.entry, `${ctx} entry`, config, errors);
		validateActionNames(node.exit, `${ctx} exit`, config, errors);

		// Validate `on` handlers
		if (node.on) {
			for (const [eventType, handler] of Object.entries(node.on)) {
				validateHandler(handler, `${ctx} on.${eventType}`, config, errors);
			}
		}

		// Validate `invoke`
		if (node.invoke) {
			const src = node.invoke.src;
			if (!config.invokeSources[src]) {
				errors.push(`${ctx}: unknown invoke source '${src}'`);
			}
			validateHandler(node.invoke.onDone, `${ctx} invoke.onDone`, config, errors);
			if (node.invoke.onError) {
				validateHandler(node.invoke.onError, `${ctx} invoke.onError`, config, errors);
			}
		}

		// Validate `always`
		if (node.always) {
			for (let i = 0; i < node.always.length; i++) {
				const candidate = node.always[i];
				if (candidate.guard && !config.guards[candidate.guard]) {
					errors.push(`${ctx} always[${i}]: unknown guard '${candidate.guard}'`);
				}
				validateActionNames(candidate.actions, `${ctx} always[${i}]`, config, errors);
			}
		}
	}

	return errors;
}

function validateHandler(
	handler: EventHandler,
	context: string,
	config: InterpreterConfig,
	errors: string[],
): void {
	const candidates = normalizeToCandidates(handler);
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		if (c.guard && !config.guards[c.guard]) {
			errors.push(`${context}[${i}]: unknown guard '${c.guard}'`);
		}
		validateActionNames(c.actions, `${context}[${i}]`, config, errors);
	}
}

function validateActionNames(
	names: string[] | undefined,
	context: string,
	config: InterpreterConfig,
	errors: string[],
): void {
	if (!names) return;
	for (const name of names) {
		if (!config.actions[name]) {
			errors.push(`${context}: unknown action '${name}'`);
		}
	}
}
