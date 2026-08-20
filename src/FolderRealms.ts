"use strict";

/**
 * Folder membership as observed in the remote, claim, and disk realms.
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
 * Remote removals and moves cross onto disk asynchronously. Their source
 * paths remain known while disk still carries the removed or moved identity,
 * even though live membership no longer has a row there. A move keeps its
 * guid and destination here rather than turning the source into a second
 * membership lookup key. This lets the membership realm hold a recreated
 * source under a different guid without changing the move being reconciled.
 *
 * No Obsidian or logging dependencies; the module tests as a value.
 */

export type PathOrigin = "known" | "claimed" | "novel";

export interface DiskMove {
	guid: string;
	from: string;
	to: string;
}

export class FolderRealms {
	/** Persisted remote-realm membership at boot; null until taken. */
	private baseline: Set<string> | null = null;
	/** Remote removals whose disk adoption has not completed. */
	private withdrawn = new Set<string>();
	/** Membership moves whose corresponding disk rename remains outstanding. */
	private diskMovesByGuid = new Map<string, DiskMove>();
	/** The disk path still carrying each moved identity. */
	private diskMoveGuidsBySource = new Map<string, string>();
	/** Move sources at which the vault observed a distinct local creation. */
	private recreatedMoveSources = new Set<string>();

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
		if (this.recreatedMoveSources.has(path)) return "novel";
		if (this.baseline?.has(path)) return "known";
		if (this.withdrawn.has(path)) return "known";
		if (this.diskMoveGuidsBySource.has(path)) return "known";
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
			if (this.diskMoveGuidsBySource.has(path)) continue;
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

	/**
	 * Membership moved an identity while disk still exposes its source path.
	 * Re-recording the same guid updates the observed disk edge, which is
	 * useful when reconciliation skips an intermediate membership path.
	 */
	recordRemoteMove(move: DiskMove): void {
		const previous = this.diskMovesByGuid.get(move.guid);
		const sourceWasRecreated =
			previous?.from === move.from &&
			this.recreatedMoveSources.has(move.from);
		if (previous) {
			this.diskMoveGuidsBySource.delete(previous.from);
			if (previous.from !== move.from) {
				this.recreatedMoveSources.delete(previous.from);
			}
		}

		const displacedGuid = this.diskMoveGuidsBySource.get(move.from);
		if (displacedGuid && displacedGuid !== move.guid) {
			this.diskMovesByGuid.delete(displacedGuid);
		}

		this.withdrawn.delete(move.from);
		this.withdrawn.delete(move.to);
		if (!sourceWasRecreated) {
			this.recreatedMoveSources.delete(move.from);
		}
		this.diskMovesByGuid.set(move.guid, { ...move });
		this.diskMoveGuidsBySource.set(move.from, move.guid);
	}

	/** The move whose identity disk still exposes at this source path. */
	diskMoveFrom(path: string): DiskMove | undefined {
		const guid = this.diskMoveGuidsBySource.get(path);
		return guid ? this.diskMovesByGuid.get(guid) : undefined;
	}

	/** The disk move for one membership identity, independent of path reuse. */
	diskMoveForGuid(guid: string): DiskMove | undefined {
		return this.diskMovesByGuid.get(guid);
	}

	/**
	 * A vault create at a move source is a distinct disk occupant. The boot
	 * baseline retires for that path so normal settling may mint the new
	 * occupant, while the guid-keyed move remains available for its disk echo.
	 */
	observeMoveSourceCreation(path: string): boolean {
		if (!this.diskMoveGuidsBySource.has(path)) return false;
		this.recreatedMoveSources.add(path);
		this.retire(path);
		return true;
	}

	/**
	 * Consume an exact disk observation. A different destination cannot
	 * complete the move, and a move for another guid cannot be reached by
	 * source-path reuse.
	 */
	completeDiskMove(from: string, to: string): DiskMove | undefined {
		const move = this.diskMoveFrom(from);
		if (!move || move.to !== to) return undefined;
		this.diskMoveGuidsBySource.delete(from);
		this.diskMovesByGuid.delete(move.guid);
		this.recreatedMoveSources.delete(from);
		this.retire(from);
		return move;
	}

	/** Outstanding disk moves, for absence reconciliation after a tree sync. */
	pendingDiskMoves(): DiskMove[] {
		return Array.from(this.diskMovesByGuid.values(), (move) => ({ ...move }));
	}
}
