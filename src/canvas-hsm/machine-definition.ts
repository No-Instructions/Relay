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
 *   canvas can never reach `flushing` — every state routes VIEW_ATTACHED
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
	target: "loading" | "evaluating" | "flushing",
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
			VIEW_ATTACHED: { target: "loading", actions: ["markViewAttached"] },
			VIEW_DETACHED: { target: "loading", actions: ["markViewDetached"] },
			LOCAL_DOC_CHANGED: { target: "loading", actions: [] },
			DISK_CHANGED: { target: "loading", actions: [] },
			...REMEMBER_SIGNALS("loading"),
		},
		always: [
			{ target: "active", guard: "persistenceLoadedAndViewAttached" },
			{ target: "evaluating", guard: "persistenceLoaded" },
		],
	},

	// Transient: read disk, compare disk / localDoc / LCA, route on the
	// verdict. Attachment races resolve toward the view: a VIEW_ATTACHED
	// mid-read exits immediately (cancelling the invoke), and the verdict
	// handler re-checks attachment before acting on the read.
	evaluating: {
		invoke: {
			src: "evaluate",
			onDone: [
				{ target: "active", guard: "viewAttached" },
				{ target: "synced", guard: "evaluationNotMember" },
				{
					target: "flushing",
					guard: "evaluationLocalAhead",
					actions: ["recordEvaluation"],
				},
				{
					target: "synced",
					guard: "evaluationInSync",
					actions: ["recordEvaluation", "advanceLCAFromEvaluation"],
				},
				{
					target: "synced",
					guard: "evaluationEmptyLocal",
					actions: ["recordEvaluation"],
				},
				// disk-ahead and diverged both park until snapshot ingestion
				// ships; the verdicts stay distinct in the evaluation result.
				{ target: "diverged", actions: ["recordEvaluation"] },
			],
			onError: [{ target: "diverged", actions: ["recordEvaluationError"] }],
		},
		on: {
			VIEW_ATTACHED: { target: "active", actions: ["markViewAttached"] },
			VIEW_DETACHED: { target: "evaluating", actions: ["markViewDetached"] },
			// A fresh change invalidates the in-flight read; restart it.
			LOCAL_DOC_CHANGED: { target: "evaluating", reenter: true },
			DISK_CHANGED: { target: "evaluating", reenter: true },
			...REMEMBER_SIGNALS("evaluating"),
		},
	},

	synced: {
		capabilities: {
			canEmitEffects: true,
			canDownload: true,
		},
		entry: ["drainPendingSignals"],
		always: [
			{
				target: "evaluating",
				guard: "reevaluatePending",
				actions: ["clearReevaluatePending"],
			},
		],
		on: {
			LOCAL_DOC_CHANGED: { target: "evaluating" },
			DISK_CHANGED: { target: "evaluating" },
			SERVER_AHEAD: { target: "synced", actions: ["requestDownload"] },
			DOWNLOAD_COMPLETE: {
				target: "evaluating",
				actions: ["settleDownload"],
			},
			DOWNLOAD_FAILED: { target: "synced", actions: ["settleDownload"] },
			VIEW_ATTACHED: { target: "active", actions: ["markViewAttached"] },
			VIEW_DETACHED: { target: "synced", actions: ["markViewDetached"] },
		},
	},

	// The localDoc is ahead of a disk file that is provably untouched
	// (matches the LCA, or is empty/absent). The WRITE_DISK effect is
	// emitted on entry; the host reports completion.
	flushing: {
		capabilities: {
			canEmitEffects: true,
			canWriteDisk: true,
		},
		entry: ["emitWriteDisk"],
		on: {
			FLUSH_COMPLETE: {
				target: "synced",
				actions: ["advanceLCAFromFlush"],
			},
			FLUSH_FAILED: { target: "diverged", actions: ["recordFlushFailure"] },
			LOCAL_DOC_CHANGED: {
				target: "flushing",
				actions: ["rememberReevaluate"],
			},
			DISK_CHANGED: { target: "flushing", actions: ["rememberReevaluate"] },
			// The in-flight write completes under the view; FLUSH_COMPLETE
			// in `active` still advances the LCA.
			VIEW_ATTACHED: { target: "active", actions: ["markViewAttached"] },
			VIEW_DETACHED: { target: "flushing", actions: ["markViewDetached"] },
			...REMEMBER_SIGNALS("flushing"),
		},
	},

	// Disk changed locally and cannot be proven untouched. Nothing is
	// written; remote updates keep converging in CRDT space (downloads are
	// allowed), and opening the view resolves additively. Snapshot
	// ingestion (per-id three-way against the LCA) will exit this state
	// automatically once it ships.
	diverged: {
		capabilities: {
			canEmitEffects: true,
			canDownload: true,
			canSurfaceStatus: true,
		},
		entry: ["surfaceStatus", "drainPendingSignals"],
		on: {
			LOCAL_DOC_CHANGED: { target: "evaluating" },
			DISK_CHANGED: { target: "evaluating" },
			SERVER_AHEAD: { target: "diverged", actions: ["requestDownload"] },
			DOWNLOAD_COMPLETE: {
				target: "evaluating",
				actions: ["settleDownload"],
			},
			DOWNLOAD_FAILED: { target: "diverged", actions: ["settleDownload"] },
			VIEW_ATTACHED: { target: "active", actions: ["markViewAttached"] },
			VIEW_DETACHED: { target: "diverged", actions: ["markViewDetached"] },
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
			VIEW_DATA_LOADED: {
				target: "active",
				actions: ["emitReconcileView"],
			},
			VIEW_ATTACHED: { target: "active", actions: [] },
			VIEW_DETACHED: {
				target: "evaluating",
				actions: ["markViewDetached"],
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
