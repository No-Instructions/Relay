"use strict";

/**
 * The boot baseline and one classification function.
 *
 * Every path that reaches identity minting asks one question: is this path
 * a local creation, or something we already knew about? The live membership
 * map cannot answer it during bootstrap — it is a document two writers are
 * racing to define (the persistence replay and the server's first update),
 * so it reports whichever got there first. A path another device deleted
 * while this one was closed reads as never known, the file still on disk
 * reads as a local creation, and fresh identity resurrects the deletion.
 *
 * FolderRealms fixes a value to compare against: the boot baseline, a
 * snapshot of the persisted remote realm's membership taken the moment its
 * replay completes, before any traffic can move it. The baseline holds
 * membership only — never the device's own claims. That distinction is
 * load-bearing: `baseline \ remote-now` is the deletion decision, and a
 * claim that never published is absent from the server's view for the
 * innocent reason that it never reached it. Folding claims into the
 * baseline would read every file created during an offline session as one
 * the server had deleted, and release it.
 *
 * The baseline and the withdrawn set each add only "known", never remove
 * it: the model is strictly a refusal to mint — it can withhold identity,
 * never grant it. With an empty baseline `classify` reproduces the
 * unassisted blended-map answer exactly.
 *
 * No Obsidian or logging dependencies; the module tests as a value.
 */

export type PathOrigin = "known" | "claimed" | "novel";

export class FolderRealms {
	/** Persisted remote-realm membership at boot; null until taken. */
	private baseline: Set<string> | null = null;
	/** Remote removals whose disk adoption has not completed. */
	private withdrawn = new Set<string>();

	constructor(
		/** The live remote realm holds this path (committed, legacy, or
		 * migration overlay — everything the blended accessor knows except
		 * the device's own claims). */
		private committed: (path: string) => boolean,
		/** The device holds unpublished identity for this path. */
		private claimed: (path: string) => boolean,
	) {}

	/**
	 * Fix the boot baseline. Taken once, at the moment the persistence
	 * replay completes and before any traffic is permitted — a contaminated
	 * baseline is worse than none, so later calls are refused.
	 */
	takeBaseline(paths: Iterable<string>): void {
		if (this.baseline !== null) return;
		this.baseline = new Set(paths);
	}

	get baselineTaken(): boolean {
		return this.baseline !== null;
	}

	/**
	 * Is this path a local creation, or something we already knew about?
	 *
	 * The baseline and the withdrawn set only ever widen "known": a path we
	 * knew at boot whose fate is undecided, or a path removed remotely whose
	 * disk adoption is still in flight, must not read as a local creation.
	 */
	classify(path: string): PathOrigin {
		if (this.claimed(path)) return "claimed";
		if (this.committed(path)) return "known";
		if (this.baseline?.has(path)) return "known";
		if (this.withdrawn.has(path)) return "known";
		return "novel";
	}

	/**
	 * The deletion decision: paths known to have been remote membership —
	 * from the boot baseline or from witnessed removals — that the remote
	 * realm no longer holds. A set difference over values that are not
	 * moving, so it does not depend on arrival order, and it has no blind
	 * spot for keys that were never present when a delete arrived.
	 *
	 * `remoteNow` must exclude the device's own claims: a path the device
	 * still holds a claim on is "known" to the blended accessor precisely
	 * because of the claim under review, which would make every stale hold
	 * vouch for itself.
	 */
	deletedThere(remoteNow: (path: string) => boolean): string[] {
		const gone: string[] = [];
		for (const path of this.baseline ?? []) {
			if (!remoteNow(path)) gone.push(path);
		}
		for (const path of this.withdrawn) {
			if (this.baseline?.has(path)) continue;
			if (!remoteNow(path)) gone.push(path);
		}
		return gone;
	}

	/**
	 * A reconciliation decided this path — its deletion was adopted on disk
	 * or its membership re-committed. A baseline is a fact about boot and
	 * must not outlive the decisions made against it, or a path the user
	 * legitimately recreates after its deletion is refused forever.
	 */
	retire(path: string): void {
		this.baseline?.delete(path);
	}

	/** The crossing drained: every undecided entry retires with it. */
	retireAll(): void {
		this.baseline = null;
	}

	/** A remote removal arrived; its disk adoption is now pending. */
	recordRemoteRemoval(path: string): void {
		this.withdrawn.add(path);
	}

	/**
	 * The removal's disk adoption completed (the trash executed, or the path
	 * was confirmed absent), or the path re-committed in the map.
	 */
	clearRemoteRemoval(path: string): void {
		this.withdrawn.delete(path);
	}

	/** Removals still awaiting disk adoption, for the host's absence sweep. */
	withdrawnPaths(): string[] {
		return Array.from(this.withdrawn);
	}
}
