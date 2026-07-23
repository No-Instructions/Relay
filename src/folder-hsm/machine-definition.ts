/**
 * FolderHSM Machine Definition — the folder postures.
 *
 * The declarative folder-level machine for shared-folder membership.
 * This constant is the single source of truth for posture transitions;
 * it is interpreted by the merge-hsm machine interpreter. Per-file
 * decisions live in the entry machine (entry-machine.ts), whose rows the
 * routing actions here address.
 *
 * Structural invariants encoded here (verified by __tests__/folder-hsm):
 * - No effects are emitted from `loading`, `syncing`, or `rebuilding`:
 *   those nodes grant no effect capabilities, and the emit chokepoint
 *   refuses without one.
 * - Uploads dispatch from `reconciling` and `tracking` — the two
 *   postures in which classification runs. The posture grant says WHERE
 *   a publication verdict may execute; WHEN is the dispatch gate's job
 *   (confirmed confidence and write authorization, enforced at emit),
 *   and publication verdicts themselves come only from the CLASSIFY
 *   ladder.
 * - `rebuilding` exits into `reconciling`, never directly into
 *   `tracking`.
 *
 * Classification runs exactly once per (re)connect, plus once per trust
 * or tier edge: a disconnect clears the session's sync claim
 * (`reconnectPending`), the session's first confirmed exchange after a
 * blind boot re-enters classification (`tierWasBlind`), and a
 * classification pass deferred on pending sync state re-arms on the
 * host-observed drain (`classificationDeferred`).
 */

import type { FolderEventHandler, FolderMachineDefinition } from "./types";

/**
 * Observations absorbed identically wherever classification is not yet
 * allowed: context evidence is updated, no effects are emitted.
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
	AUTHORIZATION_CHANGED: { target, actions: ["recordAuthorization"] },
	SYNC_DRAINED: { target, actions: [] },
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
				actions: ["recordTier"],
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
				actions: ["recordTier"],
				reenter: true,
			},
			...ABSORB_OBSERVATIONS("syncing"),
		},
		always: [{ target: "reconciling", guard: "hydrated" }],
	},

	// Transient: classification visits every undecided row over the
	// evidence assembled so far, then control always falls through to
	// tracking. The entry action defers the whole pass when the live
	// replica holds pending sync state (the trust gate).
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
		entry: ["classifyUnclassifiedRows"],
		always: [{ target: "tracking" }],
	},

	tracking: {
		capabilities: {
			canEmitEffects: true,
			canTrash: true,
			canUploadInteractive: true,
			// Bootstrap-origin uploads dispatch from steady state too.
			// Publication verdicts come only from the CLASSIFY ladder,
			// which visits late-discovered rows in tracking (scheduled
			// classification) under exactly the trust and tier gates the
			// reconciling pass honors, and the emit chokepoint still
			// refuses any upload at blind confidence. Without this grant a
			// file discovered after the reconciling pass sits decided but
			// undispatched until the next reconnect re-enters
			// classification — a deadlock, not a safety margin.
			canUploadBootstrap: true,
			canDownload: true,
			canRenameLocal: true,
			canMutateMap: true,
			// Parking must stay available in steady state: reclassification
			// after a remote removal can land on the tombstone rung, and a
			// refusal the user cannot reach is worse than one surfaced late.
			canPark: true,
		},
		on: {
			MAP_DELTA: { target: "tracking", actions: ["routeDeltaToRows"] },
			FILE_DISCOVERED: { target: "tracking", actions: ["routeFileDiscovered"] },
			FILE_CREATED: { target: "tracking", actions: ["routeFileCreated"] },
			FILE_MODIFIED: { target: "tracking", actions: ["routeFileModified"] },
			FILE_DELETED: { target: "tracking", actions: ["routeFileDeleted"] },
			FILE_RENAMED: { target: "tracking", actions: ["routeFileRenamed"] },
			WORK_STARTED: { target: "tracking", actions: ["routeAckToRow"] },
			UPLOAD_COMPLETE: { target: "tracking", actions: ["routeCompletionToRow"] },
			UPLOAD_FAILED: { target: "tracking", actions: ["routeCompletionToRow"] },
			DOWNLOAD_COMPLETE: {
				target: "tracking",
				actions: ["routeCompletionToRow"],
			},
			DOWNLOAD_FAILED: {
				target: "tracking",
				actions: ["routeCompletionToRow"],
			},
			TRASH_COMPLETE: { target: "tracking", actions: ["routeCompletionToRow"] },
			DELETE_HELD: { target: "tracking", actions: ["routePolicyOutcomeToRows"] },
			DELETE_REPLICATED: {
				target: "tracking",
				actions: ["routePolicyOutcomeToRows"],
			},
			DELETE_RESTORED: {
				target: "tracking",
				actions: ["routePolicyOutcomeToRows"],
			},
			UNPARK_REQUESTED: { target: "tracking", actions: ["routeUserActionToRow"] },
			RESOLVE_CONFLICT: { target: "tracking", actions: ["routeUserActionToRow"] },
			CONNECTED: { target: "tracking", actions: ["setOnline"] },
			// Connection is an input, not a posture: offline tracking
			// continues to record local intent.
			DISCONNECTED: { target: "tracking", actions: ["setOffline"] },
			// Classification re-runs on a resync after a disconnect, and on
			// the session's first confirmed exchange after a blind boot —
			// the blind pass classified before the provider delivered
			// anything, so the handshake's truth revisits it. A repeat sync
			// on a live confirmed connection stays a no-op.
			PROVIDER_SYNCED: [
				{
					target: "reconciling",
					guard: "reconnectPending",
					actions: ["recordTier"],
				},
				{
					target: "reconciling",
					guard: "tierWasBlind",
					actions: ["recordTier"],
				},
				{ target: "tracking", actions: ["recordTier"] },
			],
			// A classification pass deferred on pending sync state re-runs
			// when the host observes the drain; otherwise a drain is a
			// no-op.
			SYNC_DRAINED: [
				{ target: "reconciling", guard: "classificationDeferred" },
				{ target: "tracking" },
			],
			// A widened authorization re-enters classification — the same
			// shape as the tier edge — so publication verdicts gated by the
			// old scope re-decide and dispatch from the posture that grants
			// them. A narrowed scope only records; nothing is retracted.
			AUTHORIZATION_CHANGED: [
				{
					target: "reconciling",
					guard: "authorizationExpanded",
					actions: ["recordAuthorization"],
				},
				{
					target: "tracking",
					actions: ["recordAuthorization", "revisitGatedRows"],
				},
			],
			REBUILD_STARTED: { target: "rebuilding" },
		},
	},

	// Wholesale doc replacement in flight: absorb everything, decide
	// nothing; evidence is re-derived in reconciling on the way out.
	rebuilding: {
		on: {
			PERSISTENCE_LOADED: {
				target: "rebuilding",
				actions: ["markPersistenceLoaded"],
			},
			PROVIDER_SYNCED: { target: "rebuilding", actions: ["recordTier"] },
			...ABSORB_OBSERVATIONS("rebuilding"),
			REBUILD_COMPLETE: { target: "reconciling" },
		},
	},
};
