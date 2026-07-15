/**
 * CanvasHSM Machine Definition
 *
 * The declarative state machine for canvas content convergence. This
 * constant is the single source of truth for all CanvasHSM state
 * transitions; it is interpreted by the merge-hsm machine interpreter.
 *
 * Structural invariants encoded here (verified by __tests__/canvas-hsm):
 * - WRITE_DISK only from `flushing`: only that node grants canWriteDisk,
 *   and CanvasHSM refuses to emit without the capability. A view-attached
 *   canvas can never reach `flushing` — every state routes ACQUIRE_LOCK
 *   to `active`, and `evaluating` re-checks attachment on invoke
 *   completion.
 * - RECONCILE_VIEW only from `active`: only that node grants
 *   canReconcileView.
 * - No effects from `loading` or `evaluating`: those nodes grant no
 *   capabilities. Signals that arrive there are remembered in context and
 *   drained on the next settled state.
 * - `flushing` and `evaluating` never persist a decision made against a
 *   torn read: changes observed mid-flight set reevaluatePending, and
 *   `synced` immediately falls through to `evaluating` while the flag is
 *   set.
 */

import type { CanvasEventHandler, CanvasMachineDefinition } from "./types";

/**
 * Signals absorbed identically wherever the machine cannot act on them
 * yet: context is updated, no effects are emitted.
 */
const REMEMBER_SIGNALS = (
	target: "loading" | "idle.loading" | "idle.remoteAhead",
): Record<string, CanvasEventHandler> => ({
	SERVER_AHEAD: { target, actions: ["rememberServerAhead"] },
	DOWNLOAD_COMPLETE: { target, actions: ["settleDownload"] },
	DOWNLOAD_FAILED: { target, actions: ["settleDownload"] },
});

export const CANVAS_MACHINE: CanvasMachineDefinition = {
	loading: {
		on: {
			LOAD: { target: "loading", actions: ["resetContext"], reenter: true },
			PERSISTENCE_LOADED: {
				target: "loading",
				actions: ["restorePersistedState"],
				reenter: true,
			},
			ACQUIRE_LOCK: { target: "loading", actions: ["markLocked"] },
			RELEASE_LOCK: { target: "loading", actions: ["markUnlocked"] },
			LOCAL_DOC_CHANGED: { target: "loading", actions: [] },
			DISK_CHANGED: { target: "loading", actions: [] },
			...REMEMBER_SIGNALS("loading"),
		},
		always: [
			{ target: "active", guard: "persistenceLoadedAndLocked" },
			{ target: "idle.loading", guard: "persistenceLoaded" },
		],
	},

	// Transient: read disk, compare disk / localDoc / LCA, route on the
	// verdict. Attachment races resolve toward the view: a ACQUIRE_LOCK
	// mid-read exits immediately (cancelling the invoke), and the verdict
	// handler re-checks attachment before acting on the read.
	"idle.loading": {
		invoke: {
			src: "evaluate",
			onDone: [
				{ target: "active", guard: "userLock" },
				{ target: "idle.synced", guard: "evaluationNotMember" },
				{
					target: "idle.remoteAhead",
					guard: "evaluationRemoteAhead",
					actions: ["recordEvaluation"],
				},
				{
					target: "idle.synced",
					guard: "evaluationSynced",
					actions: ["recordEvaluation", "advanceLCAFromEvaluation"],
				},
				{
					target: "idle.synced",
					guard: "evaluationAwaitingEnrollment",
					actions: ["recordEvaluation"],
				},
				// disk-ahead and diverged both park until snapshot ingestion
				// ships; the verdicts stay distinct in the evaluation result.
				{ target: "idle.diverged", actions: ["recordEvaluation"] },
			],
			onError: [{ target: "idle.diverged", actions: ["recordEvaluationError"] }],
		},
		on: {
			ACQUIRE_LOCK: { target: "active", actions: ["markLocked"] },
			RELEASE_LOCK: { target: "idle.loading", actions: ["markUnlocked"] },
			// A fresh change invalidates the in-flight read; restart it.
			LOCAL_DOC_CHANGED: { target: "idle.loading", reenter: true },
			DISK_CHANGED: { target: "idle.loading", reenter: true },
			...REMEMBER_SIGNALS("idle.loading"),
		},
	},

	"idle.synced": {
		capabilities: {
			canEmitEffects: true,
			canDownload: true,
		},
		entry: ["drainPendingSignals"],
		always: [
			{
				target: "idle.loading",
				guard: "reevaluatePending",
				actions: ["clearReevaluatePending"],
			},
		],
		on: {
			// Hibernation re-enters loading: context resets (freeing the
			// resident LCA contents) and the machine waits for the wake's
			// PERSISTENCE_LOADED. Only synced and diverged handle LOAD —
			// hibernating mid-flush or mid-download is structurally
			// impossible.
			LOAD: { target: "loading", actions: ["resetContext"] },
			LOCAL_DOC_CHANGED: { target: "idle.loading" },
			DISK_CHANGED: { target: "idle.loading" },
			// Wake rehydration: the manager reloads the record after
			// rematerializing the docs; posture is re-derived, never trusted.
			PERSISTENCE_LOADED: {
				target: "idle.loading",
				actions: ["restorePersistedState"],
			},
			SERVER_AHEAD: { target: "idle.synced", actions: ["requestDownload"] },
			DOWNLOAD_COMPLETE: {
				target: "idle.loading",
				actions: ["settleDownload"],
			},
			DOWNLOAD_FAILED: { target: "idle.synced", actions: ["settleDownload"] },
			ACQUIRE_LOCK: { target: "active", actions: ["markLocked"] },
			RELEASE_LOCK: { target: "idle.synced", actions: ["markUnlocked"] },
		},
	},

	// The localDoc is ahead of a disk file that is provably untouched
	// (matches the LCA, or is empty/absent). The WRITE_DISK effect is
	// emitted on entry; the host reports completion.
	"idle.remoteAhead": {
		capabilities: {
			canEmitEffects: true,
			canWriteDisk: true,
		},
		entry: ["emitWriteDisk"],
		on: {
			FLUSH_COMPLETE: {
				target: "idle.synced",
				actions: ["advanceLCAFromFlush"],
			},
			FLUSH_FAILED: { target: "idle.diverged", actions: ["recordFlushFailure"] },
			LOCAL_DOC_CHANGED: {
				target: "idle.remoteAhead",
				actions: ["rememberReevaluate"],
			},
			DISK_CHANGED: { target: "idle.remoteAhead", actions: ["rememberReevaluate"] },
			// The in-flight write completes under the view; FLUSH_COMPLETE
			// in `active` still advances the LCA.
			ACQUIRE_LOCK: { target: "active", actions: ["markLocked"] },
			RELEASE_LOCK: { target: "idle.remoteAhead", actions: ["markUnlocked"] },
			...REMEMBER_SIGNALS("idle.remoteAhead"),
		},
	},

	// Disk changed locally and cannot be proven untouched. Nothing is
	// written; remote updates keep converging in CRDT space (downloads are
	// allowed), and opening the view resolves additively. Snapshot
	// ingestion (per-id three-way against the LCA) will exit this state
	// automatically once it ships.
	"idle.diverged": {
		capabilities: {
			canEmitEffects: true,
			canDownload: true,
			canSurfaceStatus: true,
		},
		entry: ["surfaceStatus", "drainPendingSignals"],
		on: {
			LOAD: { target: "loading", actions: ["resetContext"] },
			LOCAL_DOC_CHANGED: { target: "idle.loading" },
			DISK_CHANGED: { target: "idle.loading" },
			PERSISTENCE_LOADED: {
				target: "idle.loading",
				actions: ["restorePersistedState"],
			},
			SERVER_AHEAD: { target: "idle.diverged", actions: ["requestDownload"] },
			DOWNLOAD_COMPLETE: {
				target: "idle.loading",
				actions: ["settleDownload"],
			},
			DOWNLOAD_FAILED: { target: "idle.diverged", actions: ["settleDownload"] },
			ACQUIRE_LOCK: { target: "active", actions: ["markLocked"] },
			RELEASE_LOCK: { target: "idle.diverged", actions: ["markUnlocked"] },
		},
	},

	// A view is attached: the view owns the disk file through Obsidian's
	// save path, and the machine's only job is keeping the view and the
	// localDoc reconciled. No disk writes, ever (canWriteDisk is not
	// granted). Detach re-evaluates, which advances the LCA when the
	// view's saves left disk and localDoc converged.
	active: {
		capabilities: {
			canEmitEffects: true,
			canReconcileView: true,
		},
		entry: ["emitReconcileView"],
		on: {
			OBSIDIAN_SET_VIEW_DATA: {
				target: "active",
				actions: ["emitReconcileView"],
			},
			PERSISTENCE_LOADED: {
				target: "active",
				actions: ["restorePersistedState"],
			},
			ACQUIRE_LOCK: { target: "active", actions: [] },
			RELEASE_LOCK: {
				target: "idle.loading",
				actions: ["markUnlocked"],
			},
			LOCAL_DOC_CHANGED: { target: "active", actions: [] },
			DISK_CHANGED: { target: "active", actions: [] },
			FLUSH_COMPLETE: {
				target: "active",
				actions: ["advanceLCAFromFlush"],
			},
			FLUSH_FAILED: { target: "active", actions: [] },
			SERVER_AHEAD: { target: "active", actions: [] },
			DOWNLOAD_COMPLETE: { target: "active", actions: ["settleDownload"] },
			DOWNLOAD_FAILED: { target: "active", actions: ["settleDownload"] },
		},
	},
};
