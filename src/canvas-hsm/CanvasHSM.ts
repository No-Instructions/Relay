/**
 * CanvasHSM
 *
 * One machine per canvas, deciding when the canvas localDoc may be written
 * to disk, when the disk file has diverged, and when an attached view must
 * be reconciled. The declarative CANVAS_MACHINE definition is interpreted
 * by the merge-hsm interpreter; guards, actions, invoke sources, and
 * effect emission are bound per instance here.
 *
 * The machine reasons over exactly three inputs — the disk file, the
 * localDoc export, and the persisted LCA. Remote convergence is not its
 * concern: the CanvasDocBridge merges remote state into the localDoc in
 * CRDT space, and the machine only observes the result as
 * LOCAL_DOC_CHANGED.
 *
 * Effects are executed by the host (Canvas / SharedFolder /
 * BackgroundSync): disk writes via SharedFolder.flush, downloads via
 * BackgroundSync, view reconciliation via CanvasPlugin, persistence via
 * the vault-wide HSMStore.
 */

import { processEvent } from "../merge-hsm/machine-interpreter";
import type { ActiveInvoke, PersistedCanvasState } from "../merge-hsm/types";
import { areCanvasDataEqual } from "../CanvasData";
import type { CanvasData } from "../CanvasView";
import { generateHash } from "../hashing";
import { curryLog } from "../debug";
import { CANVAS_MACHINE } from "./machine-definition";
import type {
	CanvasContext,
	CanvasDiskMeta,
	CanvasEffect,
	CanvasEvent,
	CanvasHSMConfig,
	CanvasStatePath,
	EvaluationResult,
	EvaluationVerdict,
} from "./types";

/** Capability each effect type requires from the current state's node. */
const EFFECT_CAPABILITY: Record<
	CanvasEffect["type"],
	| "canWriteDisk"
	| "canReconcileView"
	| "canDownload"
	| "canSurfaceStatus"
	| "canEmitEffects"
> = {
	WRITE_DISK: "canWriteDisk",
	RECONCILE_VIEW: "canReconcileView",
	ENQUEUE_DOWNLOAD: "canDownload",
	SURFACE_STATUS: "canSurfaceStatus",
	PERSIST_STATE: "canEmitEffects",
};

const EMPTY_CANVAS: CanvasData = { nodes: [], edges: [] };

function isCanvasDataEmpty(data: CanvasData): boolean {
	return (data.nodes?.length ?? 0) === 0 && (data.edges?.length ?? 0) === 0;
}

function parseCanvasData(raw: string): CanvasData | null {
	try {
		const parsed = JSON.parse(raw) as CanvasData;
		return {
			nodes: parsed.nodes ?? [],
			edges: parsed.edges ?? [],
		};
	} catch (e) {
		return null;
	}
}

async function defaultHashFn(contents: string): Promise<string> {
	const encoder = new TextEncoder();
	return generateHash(encoder.encode(contents).buffer as ArrayBuffer);
}

function freshContext(): CanvasContext {
	return {
		persistenceLoaded: false,
		userLock: false,
		serverAheadPending: false,
		downloadPending: false,
		reevaluatePending: false,
		lca: null,
		disk: null,
		revision: 0,
	};
}

export class CanvasHSM {
	readonly context: CanvasContext;
	private _statePath: CanvasStatePath = "loading";
	private _activeInvoke: ActiveInvoke | null = null;
	private _processing = false;
	private _queue: CanvasEvent[] = [];
	private _currentEventType = "";
	private _destroyed = false;
	private _stateWaiters = new Set<(statePath: CanvasStatePath) => void>();
	private _waiterAborts = new Set<() => void>();
	/** Result of the most recent completed evaluation (flush payload). */
	private _lastEvaluation: EvaluationResult | null = null;
	private readonly hashFn: (contents: string) => Promise<string>;
	private readonly now: () => number;
	private interpreterConfig: {
		guards: Record<string, (hsm: unknown, event: CanvasEvent) => boolean>;
		actions: Record<string, (hsm: unknown, event: CanvasEvent) => void>;
		invokeSources: Record<
			string,
			(hsm: unknown, signal: AbortSignal) => Promise<unknown>
		>;
	};
	private warn = curryLog("[CanvasHSM]", "warn");

	constructor(private config: CanvasHSMConfig) {
		this.context = freshContext();
		this.hashFn = config.hashFn ?? defaultHashFn;
		this.now = config.now ?? (() => Date.now());

		const verdictIs = (verdict: EvaluationVerdict) => {
			return (_hsm: unknown, event: CanvasEvent): boolean => {
				const result = (event as { data?: EvaluationResult }).data;
				return result?.verdict === verdict;
			};
		};

		this.interpreterConfig = {
			guards: {
				persistenceLoaded: () => this.context.persistenceLoaded,
				persistenceLoadedAndLocked: () =>
					this.context.persistenceLoaded && this.context.userLock,
				userLock: () => this.context.userLock,
				reevaluatePending: () => this.context.reevaluatePending,
				evaluationNotMember: verdictIs("not-member"),
				evaluationAwaitingEnrollment: verdictIs("awaiting-enrollment"),
				evaluationSynced: verdictIs("synced"),
				evaluationRemoteAhead: verdictIs("remote-ahead"),
			},
			actions: {
				resetContext: () => this.resetContext(),
				restorePersistedState: (_hsm, event) => {
					if (event.type !== "PERSISTENCE_LOADED") return;
					this.context.lca = event.state?.lca
						? { ...event.state.lca }
						: null;
					this.context.disk = event.state?.disk
						? { ...event.state.disk }
						: null;
					this.context.persistenceLoaded = true;
				},
				markLocked: () => {
					this.context.userLock = true;
				},
				markUnlocked: () => {
					this.context.userLock = false;
				},
				rememberServerAhead: () => {
					this.context.serverAheadPending = true;
				},
				rememberReevaluate: () => {
					this.context.reevaluatePending = true;
				},
				clearReevaluatePending: () => {
					this.context.reevaluatePending = false;
				},
				requestDownload: () => this.requestDownload(),
				drainPendingSignals: () => {
					if (this.context.serverAheadPending) {
						this.context.serverAheadPending = false;
						this.requestDownload();
					}
				},
				settleDownload: () => {
					this.context.downloadPending = false;
				},
				recordEvaluation: (_hsm, event) => {
					const result = (event as { data?: EvaluationResult }).data;
					if (!result) return;
					this._lastEvaluation = result;
					this.context.disk = result.disk ? { ...result.disk } : null;
					this.touch();
				},
				recordEvaluationError: (_hsm, event) => {
					this.warn(
						"evaluation failed",
						this.config.getPath(),
						(event as { data?: unknown }).data,
					);
				},
				recordFlushFailure: (_hsm, event) => {
					if (event.type !== "FLUSH_FAILED") return;
					this.warn("flush failed", this.config.getPath(), event.error);
				},
				advanceLCAFromEvaluation: () => {
					const result = this._lastEvaluation;
					if (!result) return;
					this.context.lca = {
						contents: result.contents,
						hash: result.hash,
						mtime: result.disk?.mtime ?? this.now(),
					};
					this.touch();
				},
				advanceLCAFromFlush: (_hsm, event) => {
					if (event.type !== "FLUSH_COMPLETE") return;
					this.context.lca = {
						contents: event.contents,
						hash: event.hash,
						mtime: event.mtime,
					};
					this.context.disk = { hash: event.hash, mtime: event.mtime };
					this.touch();
				},
				emitWriteDisk: () => {
					const result = this._lastEvaluation;
					if (!result) {
						this.warn("entered idle.remoteAhead without an evaluation");
						return;
					}
					this.emit({
						type: "WRITE_DISK",
						contents: result.contents,
						hash: result.hash,
					});
				},
				emitReconcileView: () => {
					this.emit({ type: "RECONCILE_VIEW" });
				},
				surfaceStatus: () => {
					this.emit({ type: "SURFACE_STATUS" });
				},
			},
			invokeSources: {
				evaluate: (_hsm, signal) => this.evaluate(signal),
			},
		};
	}

	// =========================================================================
	// MachineHSM surface (consumed by the merge-hsm interpreter)
	// =========================================================================

	get statePath(): CanvasStatePath {
		return this._statePath;
	}

	setStatePath(target: CanvasStatePath): void {
		const from = this._statePath;
		this._statePath = target;
		if (from !== target) {
			this.config.onTransition?.(from, target, this._currentEventType);
			for (const waiter of [...this._stateWaiters]) {
				waiter(target);
			}
		}
	}

	/**
	 * Resolve once the state path satisfies `check` — immediately when it
	 * already does — or reject after `timeoutMs`. Event-driven off state
	 * transitions; no polling.
	 */
	awaitState(
		check: (statePath: CanvasStatePath) => boolean,
		timeoutMs = 10_000,
	): Promise<CanvasStatePath> {
		if (this._destroyed) {
			return Promise.reject(new Error("CanvasHSM destroyed"));
		}
		if (check(this._statePath)) {
			return Promise.resolve(this._statePath);
		}
		return new Promise((resolve, reject) => {
			const settle = (fn: () => void) => {
				clearTimeout(timer);
				this._stateWaiters.delete(waiter);
				this._waiterAborts.delete(abort);
				fn();
			};
			const timer = setTimeout(() => {
				settle(() =>
					reject(
						new Error(
							`awaitState timed out after ${timeoutMs}ms (state: ${this._statePath})`,
						),
					),
				);
			}, timeoutMs);
			const waiter = (statePath: CanvasStatePath) => {
				if (!check(statePath)) return;
				settle(() => resolve(statePath));
			};
			const abort = () => {
				settle(() => reject(new Error("CanvasHSM destroyed")));
			};
			this._stateWaiters.add(waiter);
			this._waiterAborts.add(abort);
		});
	}

	getActiveInvoke(): ActiveInvoke | null {
		return this._activeInvoke;
	}

	setActiveInvoke(invoke: ActiveInvoke | null): void {
		this._activeInvoke = invoke;
	}

	send(event: CanvasEvent): void {
		if (this._destroyed) return;
		if (this._processing) {
			this._queue.push(event);
			return;
		}
		this._processing = true;
		try {
			this.dispatch(event);
			while (this._queue.length > 0) {
				this.dispatch(this._queue.shift()!);
			}
		} finally {
			this._processing = false;
		}
	}

	private dispatch(event: CanvasEvent): void {
		this._currentEventType = event.type;
		const revisionBefore = this.context.revision;
		const stateBefore = this._statePath;
		// The interpreter is generic at runtime; its types are bound to
		// MergeHSM's unions, so the boundary casts here are deliberate.
		processEvent(
			this as never,
			event as never,
			CANVAS_MACHINE as never,
			this.interpreterConfig as never,
		);
		if (
			(this.context.revision !== revisionBefore ||
				this._statePath !== stateBefore) &&
			this.currentCapabilities()?.canEmitEffects
		) {
			this.emit({ type: "PERSIST_STATE", state: this.buildPersistedState() });
		}
	}

	// =========================================================================
	// Effects
	// =========================================================================

	private currentCapabilities() {
		return CANVAS_MACHINE[this._statePath]?.capabilities;
	}

	private emit(effect: CanvasEffect): void {
		const capability = EFFECT_CAPABILITY[effect.type];
		const granted = this.currentCapabilities()?.[capability];
		if (!granted) {
			throw new Error(
				`CanvasHSM: state '${this._statePath}' does not grant ` +
					`${capability} (effect ${effect.type})`,
			);
		}
		this.config.onEffect(effect);
	}

	private requestDownload(): void {
		if (this.context.downloadPending) return;
		this.context.downloadPending = true;
		this.emit({ type: "ENQUEUE_DOWNLOAD" });
	}

	// =========================================================================
	// Evaluation
	// =========================================================================

	/**
	 * Read the disk file and compare disk / localDoc / LCA. Pure with
	 * respect to machine state: returns a verdict; routing and context
	 * mutation happen in the machine's guarded onDone handlers.
	 */
	private async evaluate(_signal: AbortSignal): Promise<EvaluationResult> {
		const data = this.config.exportData();
		const contents = this.config.formatData(data);
		const hash = await this.hashFn(contents);

		const base = { contents, hash, parseError: false };

		if (!this.config.isMember()) {
			return { ...base, verdict: "not-member", disk: null };
		}

		const diskFile = await this.config.readDisk();
		const raw = diskFile?.contents ?? "";
		const hasDiskFile = diskFile !== null && raw.trim().length > 0;

		let disk: CanvasDiskMeta | null = null;
		if (diskFile !== null) {
			disk = {
				hash: await this.hashFn(diskFile.contents),
				mtime: diskFile.mtime,
			};
		}

		let diskData: CanvasData = EMPTY_CANVAS;
		if (hasDiskFile) {
			const parsed = parseCanvasData(raw);
			if (parsed === null) {
				return { ...base, verdict: "diverged", disk, parseError: true };
			}
			diskData = parsed;
		}

		const diskEmpty = isCanvasDataEmpty(diskData);
		const localEmpty = isCanvasDataEmpty(data);

		if (diskFile === null) {
			// A member with no file on disk is a remotely added canvas that
			// has not been materialized yet. Write the localDoc's export even
			// when it is empty — the folder meta already lists this path, and
			// the vault must gain the file for the membership to be visible.
			return { ...base, verdict: "remote-ahead", disk: null };
		}
		if (diskEmpty && localEmpty) {
			return { ...base, verdict: "synced", disk };
		}
		if (localEmpty) {
			// A localDoc with no content yet (first sync or enrollment in
			// flight) must never flush emptiness over a real file.
			return { ...base, verdict: "awaiting-enrollment", disk };
		}
		if (areCanvasDataEqual(diskData, data)) {
			return { ...base, verdict: "synced", disk };
		}
		if (diskEmpty) {
			return { ...base, verdict: "remote-ahead", disk };
		}

		const lcaData = this.context.lca
			? parseCanvasData(this.context.lca.contents)
			: null;
		if (lcaData && areCanvasDataEqual(diskData, lcaData)) {
			return { ...base, verdict: "remote-ahead", disk };
		}
		if (lcaData && areCanvasDataEqual(data, lcaData)) {
			return { ...base, verdict: "disk-ahead", disk };
		}
		return { ...base, verdict: "diverged", disk };
	}

	// =========================================================================
	// Context / persistence
	// =========================================================================

	private touch(): void {
		this.context.revision++;
	}

	private resetContext(): void {
		const fresh = freshContext();
		fresh.userLock = this.context.userLock;
		Object.assign(this.context, fresh);
		this._lastEvaluation = null;
	}

	private buildPersistedState(): PersistedCanvasState {
		return {
			kind: "canvas",
			guid: this.config.guid,
			path: this.config.getPath(),
			folder: this.config.folderGuid,
			lca: this.context.lca ? { ...this.context.lca } : null,
			disk: this.context.disk ? { ...this.context.disk } : null,
			localSnapshot: this.config.getLocalSnapshot?.() ?? null,
			lastStatePath: this._statePath,
			persistedAt: this.now(),
		};
	}

	// =========================================================================
	// Introspection / lifecycle
	// =========================================================================

	getSnapshot(): {
		statePath: CanvasStatePath;
		userLock: boolean;
		hasLCA: boolean;
		disk: CanvasDiskMeta | null;
		downloadPending: boolean;
	} {
		return {
			statePath: this._statePath,
			userLock: this.context.userLock,
			hasLCA: this.context.lca !== null,
			disk: this.context.disk ? { ...this.context.disk } : null,
			downloadPending: this.context.downloadPending,
		};
	}

	destroy(): void {
		if (this._destroyed) return;
		this._destroyed = true;
		if (this._activeInvoke) {
			this._activeInvoke.controller.abort();
			this._activeInvoke = null;
		}
		this._queue.length = 0;
		for (const abort of [...this._waiterAborts]) {
			abort();
		}
	}
}
