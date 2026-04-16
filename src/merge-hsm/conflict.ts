/**
 * Conflict — pure compute primitives plus a small stateful wrapper for the
 * lifetime of a single conflict resolution session.
 *
 * Two layers:
 * 1. `computeConflict(base, ours, theirs)` and `positionRegions(regions, local)`
 *    are pure functions. Test in isolation, share between callers.
 * 2. `Conflict` wraps frozen regions plus mutable resolution/position state for
 *    the duration of a resolution session. Constructed when a conflict is
 *    detected; thrown away and re-built when underlying materials change
 *    (e.g. after a sync event delivers new remote/disk content).
 */

import { diff3Merge } from "node-diff3";
import type { ConflictRegion, PositionedConflict, PositionedChange } from "./types";

export interface ConflictData {
	base: string;
	ours: string;
	theirs: string;
	oursLabel: string;
	theirsLabel: string;
	conflictRegions: ConflictRegion[];
	resolvedIndices: Set<number>;
	positionedConflicts: PositionedConflict[];
}

/**
 * Pure 3-way diff. Returns the conflict regions when sides disagree, or the
 * merged content when they don't. Tokenizes by newline so regions are
 * line-aligned.
 */
export function computeConflict(
	base: string,
	ours: string,
	theirs: string,
): { hasConflict: boolean; regions: ConflictRegion[]; merged?: string } {
	const tok = (s: string) => s.split(/(\n)/);
	const result = diff3Merge(tok(ours), tok(base), tok(theirs));
	const hasConflict = result.some(
		(r: { ok?: string[]; conflict?: { a: string[]; o: string[]; b: string[] } }) =>
			"conflict" in r,
	);
	if (hasConflict) {
		return { hasConflict: true, regions: extractRegions(result) };
	}
	const mergedTokens: string[] = [];
	for (const region of result) {
		if ("ok" in region && region.ok) mergedTokens.push(...region.ok);
	}
	return { hasConflict: false, regions: [], merged: mergedTokens.join("") };
}

function extractRegions(
	result: Array<{
		ok?: string[];
		conflict?: { a: string[]; o: string[]; b: string[] };
	}>,
): ConflictRegion[] {
	const regions: ConflictRegion[] = [];
	let lineOffset = 0;
	for (const region of result) {
		if ("conflict" in region && region.conflict) {
			const { a: localTokens, o: baseTokens, b: remoteTokens } = region.conflict;
			regions.push({
				baseStart: lineOffset,
				baseEnd: lineOffset + (baseTokens?.length ?? 0),
				oursContent: localTokens?.join("") ?? "",
				theirsContent: remoteTokens?.join("") ?? "",
			});
			lineOffset += baseTokens?.length ?? 0;
		} else if ("ok" in region && region.ok) {
			lineOffset += region.ok.length;
		}
	}
	return regions;
}

/**
 * Locate each region's `oursContent` in the current local text. Used for
 * placing inline editor decorations. Cheap (string search) — safe to call
 * after every text edit; no diff3 re-run.
 *
 * Empty `oursContent` (zero-width regions) collapse to the running search
 * position.
 */
export function positionRegions(
	regions: ConflictRegion[],
	localContent: string,
): PositionedConflict[] {
	if (regions.length === 0) return [];
	let searchFrom = 0;
	return regions.map((region, index) => {
		const text = region.oursContent;
		if (!text) {
			return {
				index,
				localStart: searchFrom,
				localEnd: searchFrom,
				oursContent: text,
				theirsContent: region.theirsContent,
			};
		}
		const pos = localContent.indexOf(text, searchFrom);
		const start = pos !== -1 ? pos : searchFrom;
		const end = pos !== -1 ? pos + text.length : searchFrom;
		searchFrom = end;
		return {
			index,
			localStart: start,
			localEnd: end,
			oursContent: text,
			theirsContent: region.theirsContent,
		};
	});
}

/**
 * Re-position only the unresolved regions. Used during in-progress
 * resolution where earlier hunks have shifted later hunks' offsets.
 * Searches for each remaining hunk's `oursContent` near its previous
 * position before falling back to a full scan.
 */
export function repositionUnresolved(
	current: PositionedConflict[],
	resolved: ReadonlySet<number>,
	localContent: string,
): PositionedConflict[] {
	const max = localContent.length;
	const clamp = (n: number) => Math.max(0, Math.min(n, max));
	let searchFrom = 0;

	return current.map((c, i) => {
		if (resolved.has(i)) {
			searchFrom = clamp(Math.max(searchFrom, c.localStart));
			return c;
		}

		const text = c.oursContent;
		const orderedFrom = clamp(Math.max(searchFrom, c.localStart));
		if (!text) {
			searchFrom = orderedFrom;
			return { ...c, localStart: orderedFrom, localEnd: orderedFrom };
		}

		let pos = localContent.indexOf(text, orderedFrom);
		if (pos === -1) {
			const nearFrom = clamp(Math.max(searchFrom, c.localStart - 100));
			pos = localContent.indexOf(text, nearFrom);
		}
		if (pos === -1) {
			pos = localContent.indexOf(text, clamp(searchFrom));
		}
		if (pos !== -1) {
			const end = pos + text.length;
			searchFrom = clamp(end);
			return { ...c, localStart: pos, localEnd: end };
		}

		// Keep stale positions in-bounds so downstream replace ranges stay valid.
		const clampedStart = clamp(Math.max(searchFrom, c.localStart));
		const clampedEnd = clamp(Math.max(clampedStart, c.localEnd));
		searchFrom = clampedEnd;
		return { ...c, localStart: clampedStart, localEnd: clampedEnd };
	});
}

/**
 * Conflict — a single resolution session.
 *
 * Construction = full diff (frozen regions). Lifetime methods are cheap:
 * `updateOurs(text)` repositions the unresolved regions; `markResolved(i)`
 * records user choice. When underlying materials (base/theirs) change due
 * to sync events, throw this away and build a new `Conflict` from a fresh
 * `computeConflict` call.
 */
export class Conflict {
	readonly base: string;
	readonly theirs: string;
	readonly oursLabel: string;
	readonly theirsLabel: string;
	readonly regions: ConflictRegion[];
	readonly resolved = new Set<number>();
	private _ours: string;
	private _positions: PositionedConflict[];

	constructor(args: {
		base: string;
		ours: string;
		theirs: string;
		oursLabel?: string;
		theirsLabel?: string;
		regions: ConflictRegion[];
	}) {
		this.base = args.base;
		this._ours = args.ours;
		this.theirs = args.theirs;
		this.oursLabel = args.oursLabel ?? "Local";
		this.theirsLabel = args.theirsLabel ?? "Remote";
		this.regions = args.regions;
		this._positions = positionRegions(this.regions, this._ours);
	}

	get ours(): string {
		return this._ours;
	}

	get positions(): PositionedConflict[] {
		return this._positions;
	}

	/**
	 * Update the local content and reposition unresolved hunks. Called after
	 * the editor applies a resolution (which deletes a hunk and shifts the
	 * remaining ones). No diff3 — only string search.
	 */
	updateOurs(newOurs: string): void {
		this._ours = newOurs;
		this._positions = repositionUnresolved(this._positions, this.resolved, newOurs);
	}

	markResolved(index: number): void {
		this.resolved.add(index);
	}

	get isFullyResolved(): boolean {
		return this.resolved.size === this.regions.length;
	}

	/** Snapshot in the `ConflictData` shape for read-only callers. */
	toData(): ConflictData {
		return {
			base: this.base,
			ours: this._ours,
			theirs: this.theirs,
			oursLabel: this.oursLabel,
			theirsLabel: this.theirsLabel,
			conflictRegions: this.regions,
			resolvedIndices: this.resolved,
			positionedConflicts: this._positions,
		};
	}
}

// Re-export so MergeHSM.ts has one place to import position helpers from.
export type { PositionedChange };
