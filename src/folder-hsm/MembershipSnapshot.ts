"use strict";

/**
 * The boot snapshot: membership as this device knew it when it was last
 * alive, pinned at replay completion before any traffic can move the live
 * map. It is the merge base for boot classification — a path on disk but
 * absent from membership is ambiguous (created here while closed, or
 * deleted there while closed) and only a fixed base can tell the two
 * apart.
 *
 * The snapshot holds membership only, never the device's own claims: a
 * claim that never published is absent from the server's view for the
 * innocent reason that it never reached it, and folding claims in would
 * read every offline creation as a remote deletion.
 *
 * No Obsidian or logging dependencies; the module tests as a value.
 */

export class MembershipSnapshot {
	private readonly paths: Set<string>;

	constructor(paths: Iterable<string>) {
		this.paths = new Set(paths);
	}

	has(path: string): boolean {
		return this.paths.has(path);
	}

	/**
	 * The deletion decision: paths known at boot that the live membership
	 * no longer holds. A set difference over values that are not moving, so
	 * it does not depend on arrival order and has no blind spot for keys
	 * that were never present when a delete arrived.
	 *
	 * `liveMembership` must exclude the device's own claims — a path the
	 * device still holds a claim on would otherwise vouch for itself.
	 */
	deletedSince(liveMembership: (path: string) => boolean): string[] {
		const gone: string[] = [];
		for (const path of this.paths) {
			if (!liveMembership(path)) gone.push(path);
		}
		return gone;
	}

	/**
	 * A reconciliation decided this path — its deletion was adopted on disk
	 * or its membership re-committed. The snapshot is a fact about boot and
	 * must not outlive the decisions made against it, or a path the user
	 * legitimately recreates after its deletion is refused forever.
	 */
	discard(path: string): void {
		this.paths.delete(path);
	}
}
