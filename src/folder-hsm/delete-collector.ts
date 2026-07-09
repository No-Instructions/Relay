/**
 * DeleteCollector — the outbound delete policy for the folder doc bridge
 * (specs/folder-hsm.md §Deletion intent).
 *
 * Local map deletions do not replicate individually. The collector holds
 * them with a trailing debounce — the timer resets on every delete — and
 * evaluates the collected burst once the stream goes quiet:
 *
 *  1. burst contains the folder root (host signal; the root is a vault
 *     event, never a map key) → detach: nothing replicates.
 *  2. burst ≤ max(thresholdFraction × membership, thresholdFloor)
 *     → replicate.
 *  3. otherwise → gate: held until an explicit send() or restore().
 *     The gate never resolves automatically and survives restart via
 *     serialized state plus the localDoc/remoteDoc divergence.
 *
 * While keys are held (collecting or gated), the bridge skips inbound
 * replication for them and reconciliation leaves their divergence alone.
 * An outbound re-assertion of a held key drops it from the burst so a
 * later send cannot delete a key the user has since re-created.
 */

import type { TimeProvider } from "../TimeProvider";
import type { FolderDocBridge, FolderMapName, OutboundDelete } from "./bridge";

export const DELETE_COLLECTOR_QUIET_MS = 500;
export const DELETE_COLLECTOR_THRESHOLD_FRACTION = 0.1;
export const DELETE_COLLECTOR_THRESHOLD_FLOOR = 25;

export type BurstClassification = "detach" | "replicate" | "gate";

export type CollectorPhase = "idle" | "collecting" | "gated";

export interface HeldDelete {
	mapName: FolderMapName;
	key: string;
}

/** Persistable collector state. Only a gated burst survives restart. */
export interface SerializedCollectorState {
	phase: "gated";
	deletes: HeldDelete[];
	gatedAt: number;
}

export interface DeleteCollectorCallbacks {
	/** Current committed membership size (threshold denominator). */
	membershipSize(): number;
	/** The burst classified as detach; the host suspends the folder. */
	onDetach(deletes: HeldDelete[]): void;
	/** The burst replicated (below threshold, or explicit send). */
	onReplicated(deletes: HeldDelete[]): void;
	/** The burst gated; the host surfaces the held state. */
	onGated(deletes: HeldDelete[]): void;
	/**
	 * A gated burst discarded by restore(). The host reverses the captured
	 * localDoc ops (preferred) or asks the bridge to refresh the keys from
	 * remote, and re-materializes local files.
	 */
	onRestored(deletes: HeldDelete[]): void;
	/** Collector state changed in a way the host should persist. */
	persist(state: SerializedCollectorState | null): void;
}

export interface DeleteCollectorOptions {
	quietWindowMs?: number;
	thresholdFraction?: number;
	thresholdFloor?: number;
}

function refKey(mapName: FolderMapName, key: string): string {
	return `${mapName}\u0000${key}`;
}

export class DeleteCollector {
	private held = new Map<string, HeldDelete>();
	private phase: CollectorPhase = "idle";
	private rootDeleted = false;
	private timer: number | null = null;
	private gatedAt: number | null = null;

	private readonly quietWindowMs: number;
	private readonly thresholdFraction: number;
	private readonly thresholdFloor: number;

	constructor(
		private readonly bridge: FolderDocBridge,
		private readonly timeProvider: TimeProvider,
		private readonly callbacks: DeleteCollectorCallbacks,
		opts: DeleteCollectorOptions = {},
	) {
		this.quietWindowMs = opts.quietWindowMs ?? DELETE_COLLECTOR_QUIET_MS;
		this.thresholdFraction =
			opts.thresholdFraction ?? DELETE_COLLECTOR_THRESHOLD_FRACTION;
		this.thresholdFloor = opts.thresholdFloor ?? DELETE_COLLECTOR_THRESHOLD_FLOOR;
	}

	get currentPhase(): CollectorPhase {
		return this.phase;
	}

	heldDeletes(): HeldDelete[] {
		return [...this.held.values()].map(({ mapName, key }) => ({
			mapName,
			key,
		}));
	}

	/** Bridge option: whether inbound/reconcile should skip this key. */
	isHeld = (mapName: FolderMapName, key: string): boolean => {
		return this.held.has(refKey(mapName, key));
	};

	/** Bridge option: outbound deletions enter the collector here. */
	collect = (deletes: OutboundDelete[]): void => {
		if (deletes.length === 0) return;
		for (const d of deletes) {
			this.held.set(refKey(d.mapName, d.key), {
				mapName: d.mapName,
				key: d.key,
			});
		}
		if (this.phase === "idle") this.phase = "collecting";
		// A gated folder absorbs further deletions into the gated burst
		// without restarting evaluation; the gate only resolves explicitly.
		if (this.phase === "gated") {
			this.callbacks.persist(this.serialize());
			return;
		}
		this.resetTimer();
	};

	/** Bridge option: a held key re-asserted locally leaves the burst. */
	dropReasserted = (
		sets: Array<{ mapName: FolderMapName; key: string }>,
	): void => {
		let changed = false;
		for (const { mapName, key } of sets) {
			changed = this.held.delete(refKey(mapName, key)) || changed;
		}
		if (!changed) return;
		if (this.held.size === 0) {
			const wasGated = this.phase === "gated";
			this.phase = "idle";
			this.gatedAt = null;
			this.clearTimer();
			if (wasGated) this.callbacks.persist(null);
		} else if (this.phase === "gated") {
			this.callbacks.persist(this.serialize());
		}
	};

	/**
	 * Host signal: the folder root itself was deleted from the vault (the
	 * root is never a map key). Classifies the active burst as detach; if
	 * no burst is active, one is opened so trailing child deletes and the
	 * quiet window still apply.
	 */
	notifyFolderRootDeleted(): void {
		if (this.phase === "gated") {
			// A root deletion while gated supersedes the gate: the folder is
			// leaving the vault. Nothing has replicated; detach immediately.
			this.classifyDetach();
			return;
		}
		this.rootDeleted = true;
		if (this.phase === "idle") this.phase = "collecting";
		this.resetTimer();
	}

	/** Explicitly replicate a gated burst. */
	send(): void {
		if (this.phase !== "gated") return;
		const deletes = this.heldDeletes();
		this.bridge.replicateDeletes(deletes);
		this.reset();
		this.callbacks.persist(null);
		this.callbacks.onReplicated(deletes);
	}

	/** Explicitly discard a gated burst. */
	restore(): void {
		if (this.phase !== "gated") return;
		const deletes = this.heldDeletes();
		this.reset();
		this.callbacks.persist(null);
		this.callbacks.onRestored(deletes);
	}

	/** Rehydrate a persisted gated burst on folder load. */
	loadPersisted(state: SerializedCollectorState): void {
		if (state.phase !== "gated" || state.deletes.length === 0) return;
		this.held = new Map(
			state.deletes.map((d) => [refKey(d.mapName, d.key), d]),
		);
		this.phase = "gated";
		this.gatedAt = state.gatedAt;
	}

	serialize(): SerializedCollectorState | null {
		if (this.phase !== "gated") return null;
		return {
			phase: "gated",
			deletes: this.heldDeletes(),
			gatedAt: this.gatedAt ?? 0,
		};
	}

	destroy(): void {
		this.clearTimer();
	}

	private resetTimer(): void {
		this.clearTimer();
		this.timer = this.timeProvider.setTimeout(
			() => this.evaluate(),
			this.quietWindowMs,
		);
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			this.timeProvider.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private evaluate(): void {
		this.timer = null;
		if (this.phase !== "collecting") return;

		if (this.rootDeleted) {
			this.classifyDetach();
			return;
		}

		const deletes = this.heldDeletes();
		if (deletes.length === 0) {
			this.phase = "idle";
			return;
		}

		const threshold = Math.max(
			this.thresholdFraction * this.callbacks.membershipSize(),
			this.thresholdFloor,
		);
		if (deletes.length <= threshold) {
			this.bridge.replicateDeletes(deletes);
			this.reset();
			this.callbacks.onReplicated(deletes);
		} else {
			this.phase = "gated";
			this.gatedAt = this.timeProvider.now();
			this.callbacks.persist(this.serialize());
			this.callbacks.onGated(deletes);
		}
	}

	private classifyDetach(): void {
		const deletes = this.heldDeletes();
		this.reset();
		this.callbacks.persist(null);
		this.callbacks.onDetach(deletes);
	}

	private reset(): void {
		this.held.clear();
		this.phase = "idle";
		this.rootDeleted = false;
		this.gatedAt = null;
		this.clearTimer();
	}
}
