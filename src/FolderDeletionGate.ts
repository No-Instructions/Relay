"use strict";

/**
 * The deletion gate: locally decided membership deletions collect into a
 * burst over a quiet window before anything replicates, and an anomalous
 * burst resolves only by explicit user decision.
 *
 * The gate is not machinery beside the capture staging — it is the staging
 * discipline applied to deletion ops. The burst is the set of un-flushed
 * captured deletions; the evaluation is the flush decision; the two
 * resolutions are the two withdrawal primitives (replicate = flush with the
 * per-entry expired-intent check, restore = cancel). Because held ops never
 * flush, held keys never replicate, and the divergence between the local
 * and remote documents is the durable form of the hold: a burst held at
 * quit re-arms at next launch from the persisted ledger, and no timer or
 * flag has to survive the restart.
 *
 * The folder root's deletion never reaches this gate — the root signal is
 * out-of-band (the folder's registration suspends relinkably before
 * per-file deletions are derived).
 *
 * Inbound deletions are never gated; they converge and disk follows
 * recoverably. This module owns only the outbound policy.
 *
 * No Obsidian or logging dependencies; the module tests as a value.
 */

import type { TimeProvider } from "./TimeProvider";

/** Deletions settle for this window before the burst evaluates. */
export const DELETION_GATE_QUIET_MS = 3_000;

/** Bursts at or under this size always replicate, whatever the folder
 * size — small folders must not be over-gated. */
export const DELETION_GATE_FLOOR = 10;

/** Above the floor, a burst replicates only while it stays under this
 * fraction of membership. */
export const DELETION_GATE_FRACTION = 0.25;

export type DeletionBurstResolution = "replicate" | "restore";

/** The burst evaluation: within threshold ships, anything larger is held. */
export function evaluateDeletionBurst(
	burstSize: number,
	membershipSize: number,
): "replicate" | "hold" {
	const threshold = Math.max(
		DELETION_GATE_FLOOR,
		Math.ceil(membershipSize * DELETION_GATE_FRACTION),
	);
	return burstSize <= threshold ? "replicate" : "hold";
}

export interface FolderDeletionGateOptions {
	/** The un-flushed captured deletion keys — the burst, read live. */
	heldDeletions: () => Set<string>;
	/** Committed membership size at evaluation time (the threshold's base:
	 * membership before the burst applied). */
	membershipSize: () => number;
	/** Ship the burst: flush each key through the expired-intent check. */
	replicate: (paths: string[]) => void;
	/** Surface a held burst. The receiver resolves it by explicit user
	 * decision; a gate with no receiver stays held. */
	onHold: (paths: string[], resolve: (r: DeletionBurstResolution) => void) => void;
	/** Discard the burst: cancel the captured deletions. */
	restore: (paths: string[]) => void;
	timeProvider: TimeProvider;
	quietMs?: number;
}

export class FolderDeletionGate {
	private quietTimer: number | null = null;
	private heldBurst: string[] | null = null;
	private closed = false;

	constructor(private readonly opts: FolderDeletionGateOptions) {}

	/** True while a burst awaits its explicit resolution. */
	get held(): boolean {
		return this.heldBurst !== null;
	}

	/** The paths of the held burst, for resolution surfaces. */
	heldBurstPaths(): string[] {
		return this.heldBurst ? [...this.heldBurst] : [];
	}

	/**
	 * A local deletion was captured; (re)arm the quiet window. Deletions
	 * landing while a burst is already held join it at evaluation time —
	 * the burst is always read from the ledger, never from memory of this
	 * call.
	 */
	noteLocalDeletion(): void {
		if (this.closed) return;
		if (this.quietTimer !== null) {
			this.opts.timeProvider.clearTimeout(this.quietTimer);
		}
		this.quietTimer = this.opts.timeProvider.setTimeout(() => {
			this.quietTimer = null;
			this.evaluate();
		}, this.opts.quietMs ?? DELETION_GATE_QUIET_MS);
	}

	/**
	 * Re-arm from durable state: a burst held at quit is still held at next
	 * launch. Runs the evaluation immediately when the ledger carries
	 * deletions and no quiet window is pending.
	 */
	rearm(): void {
		if (this.closed || this.quietTimer !== null || this.heldBurst) return;
		if (this.opts.heldDeletions().size === 0) return;
		this.evaluate();
	}

	destroy(): void {
		this.closed = true;
		if (this.quietTimer !== null) {
			this.opts.timeProvider.clearTimeout(this.quietTimer);
			this.quietTimer = null;
		}
		this.heldBurst = null;
	}

	private evaluate(): void {
		if (this.closed) return;
		const burst = Array.from(this.opts.heldDeletions()).sort();
		if (burst.length === 0) return;
		if (this.heldBurst) {
			// A held burst absorbs late arrivals; the resolution reads the
			// ledger again, so nothing is lost by widening the list.
			this.heldBurst = burst;
			return;
		}
		if (evaluateDeletionBurst(burst.length, this.opts.membershipSize()) === "replicate") {
			this.opts.replicate(burst);
			return;
		}
		this.heldBurst = burst;
		this.opts.onHold(burst, (resolution) => this.resolve(resolution));
	}

	private resolve(resolution: DeletionBurstResolution): void {
		if (this.closed || !this.heldBurst) return;
		// Resolve against the ledger's present truth: keys the user
		// re-created since the hold have left the burst, and a resolution
		// must not delete them.
		const burst = Array.from(this.opts.heldDeletions()).sort();
		this.heldBurst = null;
		if (burst.length === 0) return;
		if (resolution === "replicate") {
			this.opts.replicate(burst);
		} else {
			this.opts.restore(burst);
		}
	}
}
