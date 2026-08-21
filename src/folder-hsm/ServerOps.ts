"use strict";

/**
 * Server-decided file operations in flight: observed in membership, their
 * disk effect not yet real, their vault echo not yet consumed. The vault
 * event handlers and the mint predicate consult this set synchronously to
 * tell the folder's own lag apart from user intent — a rename that
 * completes a move is an echo to consume, a delete at a vacated source is
 * not a user deletion, and a path mid-adoption must not re-mint.
 *
 * A move keeps its guid and destination rather than aliasing the source
 * path in membership: the source can hold a recreated file under a
 * different guid without changing the move being reconciled.
 *
 * No Obsidian or logging dependencies; the module tests as a value.
 */

export interface ServerMove {
	guid: string;
	from: string;
	to: string;
}

export class ServerOps {
	/** Remote removals whose disk adoption has not completed. */
	private deletes = new Set<string>();
	/** Moves whose disk rename remains outstanding, by identity. */
	private movesByGuid = new Map<string, ServerMove>();
	/** The disk path still carrying each moved identity. */
	private moveGuidsBySource = new Map<string, string>();
	/** Move sources at which the vault observed a distinct local creation. */
	private recreatedSources = new Set<string>();

	/**
	 * Is this path spoken for by an operation in flight? A pending delete,
	 * or the vacated source of a pending move (unless a distinct file has
	 * since claimed it).
	 */
	coversPath(path: string): boolean {
		if (this.deletes.has(path)) return true;
		if (this.recreatedSources.has(path)) return false;
		return this.moveGuidsBySource.has(path);
	}

	/** A remote removal arrived; its disk adoption is now pending. */
	recordDelete(path: string): void {
		this.deletes.add(path);
	}

	/** The removal's disk adoption completed, or the path re-committed. */
	clearDelete(path: string): void {
		this.deletes.delete(path);
	}

	/** Removals still awaiting disk adoption, for the absence sweep. */
	pendingDeletePaths(): string[] {
		return Array.from(this.deletes);
	}

	/**
	 * Membership moved an identity while disk still exposes its source.
	 * Re-recording a guid updates the observed disk edge, which is how a
	 * reconciliation that skipped an intermediate membership path stays
	 * current.
	 */
	recordMove(move: ServerMove): void {
		const previous = this.movesByGuid.get(move.guid);
		const sourceWasRecreated = this.recreatedSources.has(move.from);
		if (previous) {
			this.moveGuidsBySource.delete(previous.from);
			if (previous.from !== move.from) {
				this.recreatedSources.delete(previous.from);
			}
		}

		const displacedGuid = this.moveGuidsBySource.get(move.from);
		if (displacedGuid && displacedGuid !== move.guid) {
			this.movesByGuid.delete(displacedGuid);
		}

		this.deletes.delete(move.from);
		this.deletes.delete(move.to);
		if (!sourceWasRecreated) {
			this.recreatedSources.delete(move.from);
		}
		this.movesByGuid.set(move.guid, { ...move });
		this.moveGuidsBySource.set(move.from, move.guid);
	}

	/** Membership moved again after disk had already left the new source. */
	discardMove(guid: string): void {
		const move = this.movesByGuid.get(guid);
		if (!move) return;
		this.movesByGuid.delete(guid);
		if (this.moveGuidsBySource.get(move.from) === guid) {
			this.moveGuidsBySource.delete(move.from);
			this.recreatedSources.delete(move.from);
		}
	}

	/** The move whose identity disk still exposes at this source path. */
	moveFrom(path: string): ServerMove | undefined {
		const guid = this.moveGuidsBySource.get(path);
		return guid ? this.movesByGuid.get(guid) : undefined;
	}

	/** The move for one identity, independent of source-path reuse. */
	moveFor(guid: string): ServerMove | undefined {
		return this.movesByGuid.get(guid);
	}

	/**
	 * A vault create at a move source is a distinct disk occupant. It may
	 * claim the path without taking over the moved guid; the guid-keyed
	 * move remains available for its disk echo. Returns whether the path
	 * was a move source.
	 */
	observeSourceRecreation(path: string): boolean {
		if (!this.moveGuidsBySource.has(path)) return false;
		this.recreatedSources.add(path);
		return true;
	}

	/**
	 * Consume an exact disk observation. A different destination cannot
	 * complete the move, and a move for another guid cannot be reached by
	 * source-path reuse.
	 */
	completeMove(from: string, to: string): ServerMove | undefined {
		const move = this.moveFrom(from);
		if (!move || move.to !== to) return undefined;
		this.moveGuidsBySource.delete(from);
		this.movesByGuid.delete(move.guid);
		this.recreatedSources.delete(from);
		return move;
	}

	/** Outstanding moves, for absence reconciliation after a tree sync. */
	pendingMoves(): ServerMove[] {
		return Array.from(this.movesByGuid.values(), (move) => ({ ...move }));
	}
}
