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
	private deletes = new Map<string, string>();
	/** Moves whose disk rename remains outstanding, by identity. */
	private movesByGuid = new Map<string, ServerMove>();
	/** The disk path still carrying each moved identity. */
	private moveGuidsBySource = new Map<string, string>();
	/** Move sources at which the vault observed a distinct local creation. */
	private recreatedSources = new Set<string>();

	constructor(private readonly pathKey: (path: string) => string = path => path) {}

	/**
	 * Is this path spoken for by an operation in flight? A pending delete,
	 * or the vacated source of a pending move (unless a distinct file has
	 * since claimed it).
	 */
	coversPath(path: string): boolean {
		const key = this.pathKey(path);
		if (this.deletes.has(key)) return true;
		if (this.recreatedSources.has(key)) return false;
		return this.moveGuidsBySource.has(key);
	}

	/** A remote removal arrived; its disk adoption is now pending. */
	recordDelete(path: string): void {
		this.deletes.set(this.pathKey(path), path);
	}

	/** The removal's disk adoption completed, or the path re-committed. */
	clearDelete(path: string): void {
		this.deletes.delete(this.pathKey(path));
	}

	hasDelete(path: string): boolean {
		return this.deletes.has(this.pathKey(path));
	}

	/** Removals still awaiting disk adoption, for the absence sweep. */
	pendingDeletePaths(): string[] {
		return Array.from(this.deletes.values());
	}

	/**
	 * Membership moved an identity while disk still exposes its source.
	 * Re-recording a guid updates the observed disk edge, which is how a
	 * reconciliation that skipped an intermediate membership path stays
	 * current.
	 */
	recordMove(move: ServerMove): void {
		const previous = this.movesByGuid.get(move.guid);
		const sourceKey = this.pathKey(move.from);
		const sourceWasRecreated = this.recreatedSources.has(sourceKey);
		if (previous) {
			const previousKey = this.pathKey(previous.from);
			this.moveGuidsBySource.delete(previousKey);
			if (previousKey !== sourceKey) {
				this.recreatedSources.delete(previousKey);
			}
		}

		const displacedGuid = this.moveGuidsBySource.get(sourceKey);
		if (displacedGuid && displacedGuid !== move.guid) {
			this.movesByGuid.delete(displacedGuid);
		}

		this.deletes.delete(sourceKey);
		this.deletes.delete(this.pathKey(move.to));
		if (!sourceWasRecreated) {
			this.recreatedSources.delete(sourceKey);
		}
		this.movesByGuid.set(move.guid, { ...move });
		this.moveGuidsBySource.set(sourceKey, move.guid);
	}

	/** Membership moved again after disk had already left the new source. */
	discardMove(guid: string): void {
		const move = this.movesByGuid.get(guid);
		if (!move) return;
		this.movesByGuid.delete(guid);
		const sourceKey = this.pathKey(move.from);
		if (this.moveGuidsBySource.get(sourceKey) === guid) {
			this.moveGuidsBySource.delete(sourceKey);
			this.recreatedSources.delete(sourceKey);
		}
	}

	/** The move whose identity disk still exposes at this source path. */
	moveFrom(path: string): ServerMove | undefined {
		const guid = this.moveGuidsBySource.get(this.pathKey(path));
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
		const key = this.pathKey(path);
		if (!this.moveGuidsBySource.has(key)) return false;
		this.recreatedSources.add(key);
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
		this.moveGuidsBySource.delete(this.pathKey(from));
		this.movesByGuid.delete(move.guid);
		this.recreatedSources.delete(this.pathKey(from));
		return move;
	}

	/** Outstanding moves, for absence reconciliation after a tree sync. */
	pendingMoves(): ServerMove[] {
		return Array.from(this.movesByGuid.values(), (move) => ({ ...move }));
	}
}
