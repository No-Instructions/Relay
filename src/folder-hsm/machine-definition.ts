/**
 * FolderHSM Machine Definition
 *
 * The declarative state machine for shared-folder membership
 * reconciliation. This constant is the single
 * source of truth for all FolderHSM state transitions; it is interpreted
 * by the merge-hsm machine interpreter.
 *
 * Structural invariants encoded here (verified by __tests__/folder-hsm):
 * - No effects are emitted from `loading` or `syncing`: those nodes
 *   grant no effect capabilities, and FolderHSM refuses to emit without one.
 * - TRASH_LOCAL only from `tracking` (guid-matched MAP_DELTA delete) or
 *   `reconciling` (ladder rung 2): only those nodes grant canTrash.
 * - Bootstrap-origin uploads only from `reconciling` (rungs 1 and 4);
 *   interactive uploads also from `tracking`.
 * - `rebuilding` exits into `reconciling`, never directly into `tracking`.
 */

import type { FolderEventHandler, FolderMachineDefinition } from "./types";

/**
 * Observations absorbed identically wherever classification is not yet
 * allowed: context is updated, no effects are emitted.
 */
const ABSORB_OBSERVATIONS = (
	target: "loading" | "syncing" | "rebuilding",
): Record<string, FolderEventHandler> => ({
	MAP_DELTA: { target, actions: ["absorbMapDelta"] },
	FILE_DISCOVERED: { target, actions: ["absorbDiscoveredFile"] },
	FILE_CREATED: { target, actions: ["absorbInteractiveCreate"] },
	FILE_MODIFIED: { target, actions: [] },
	FILE_DELETED: { target, actions: ["absorbLocalDelete"] },
	FILE_RENAMED: { target, actions: ["absorbLocalRename"] },
	CONNECTED: { target, actions: ["setOnline"] },
	DISCONNECTED: { target, actions: ["setOffline"] },
});

export const FOLDER_MACHINE: FolderMachineDefinition = {
	loading: {
		on: {
			LOAD: { target: "loading", actions: ["resetContext"], reenter: true },
			PERSISTENCE_LOADED: {
				target: "loading",
				actions: ["markPersistenceLoaded"],
				reenter: true,
			},
			PROVIDER_SYNCED: {
				target: "loading",
				actions: ["markProviderSynced"],
				reenter: true,
			},
			...ABSORB_OBSERVATIONS("loading"),
		},
		always: [{ target: "syncing", guard: "persistenceLoaded" }],
	},

	syncing: {
		on: {
			PROVIDER_SYNCED: {
				target: "syncing",
				actions: ["markProviderSynced"],
				reenter: true,
			},
			...ABSORB_OBSERVATIONS("syncing"),
		},
		always: [{ target: "reconciling", guard: "hydrated" }],
	},

	// Transient: the bootstrap provenance ladder runs over the evidence
	// assembled during loading/syncing, then control always falls through
	// to tracking. Exactly once per connect.
	reconciling: {
		capabilities: {
			canEmitEffects: true,
			canTrash: true,
			canUploadBootstrap: true,
			canUploadInteractive: true,
			canDownload: true,
			canRenameLocal: true,
			canMutateMap: true,
			canPark: true,
		},
		entry: ["runProvenanceLadder"],
		always: [{ target: "tracking" }],
	},

	tracking: {
		capabilities: {
			canEmitEffects: true,
			canTrash: true,
			canUploadInteractive: true,
			canDownload: true,
			canRenameLocal: true,
			canMutateMap: true,
		},
		on: {
			MAP_DELTA: { target: "tracking", actions: ["applyMapDelta"] },
			FILE_DISCOVERED: { target: "tracking", actions: ["trackDiscoveredFile"] },
			FILE_CREATED: { target: "tracking", actions: ["handleInteractiveCreate"] },
			FILE_MODIFIED: { target: "tracking", actions: [] },
			FILE_DELETED: { target: "tracking", actions: ["handleLocalDelete"] },
			FILE_RENAMED: { target: "tracking", actions: ["handleLocalRename"] },
			UPLOAD_COMPLETE: { target: "tracking", actions: ["settleUpload"] },
			UPLOAD_FAILED: { target: "tracking", actions: [] },
			DOWNLOAD_COMPLETE: { target: "tracking", actions: ["settleDownload"] },
			DOWNLOAD_FAILED: { target: "tracking", actions: [] },
			TRASH_COMPLETE: { target: "tracking", actions: ["settleTrash"] },
			CONNECTED: { target: "tracking", actions: ["setOnline"] },
			// Connection is an input, not a state: offline tracking continues
			// to record local intent.
			DISCONNECTED: { target: "tracking", actions: ["setOffline"] },
			// The ladder reruns exactly once per connect: only a resync after
			// a disconnect re-enters reconciling.
			PROVIDER_SYNCED: [
				{
					target: "reconciling",
					guard: "reconnectPending",
					actions: ["markProviderSynced"],
				},
				{ target: "tracking", actions: ["markProviderSynced"] },
			],
			REBUILD_STARTED: { target: "rebuilding" },
		},
	},

	// Wholesale doc replacement in flight: absorb everything, decide
	// nothing; evidence is re-derived in reconciling on the way out.
	rebuilding: {
		on: {
			PERSISTENCE_LOADED: { target: "rebuilding", actions: ["markPersistenceLoaded"] },
			PROVIDER_SYNCED: { target: "rebuilding", actions: ["markProviderSynced"] },
			...ABSORB_OBSERVATIONS("rebuilding"),
			REBUILD_COMPLETE: { target: "reconciling" },
		},
	},
};
