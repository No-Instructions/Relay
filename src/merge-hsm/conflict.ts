/**
 * Detecting a conflict, and the snapshot of one that API and diagnostic
 * callers read. The conflict itself, its sides, blocks, decisions and outcome,
 * is the value in `conflictValue.ts`.
 */

import { adaptiveDiff3Merge } from "./diff3";
import type { BlockDecision, ConflictValue } from "./conflictValue";
import type { ConflictRegion, StatePath } from "./types";

/** An HSM's conflict state for API and diagnostic callers: the held value and the decisions beside it. */
export interface ConflictInfoSnapshot {
	path: string;
	guid: string;
	statePath: StatePath;
	hasConflict: boolean;
	conflict: ConflictValue | null;
	decisions: Record<string, BlockDecision>;
}

/** The shortest prefix length, at least two, that tells a set of ids apart. */
export function shortestUniquePrefixLength(ids: readonly string[]): number {
	if (ids.length <= 1) return 2;
	for (let len = 2; len <= 8; len++) {
		if (new Set(ids.map((id) => id.slice(0, len))).size === ids.length) return len;
	}
	return 8;
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
	if (ours === theirs) return { hasConflict: false, regions: [], merged: ours };
	if (ours === base) return { hasConflict: false, regions: [], merged: theirs };
	if (theirs === base) return { hasConflict: false, regions: [], merged: ours };

	const tok = (s: string) => s.split(/(\n)/);
	const result = adaptiveDiff3Merge(tok(ours), tok(base), tok(theirs));
	const hasConflict = result.some(
		(r: { ok?: string[]; conflict?: { a: string[]; o: string[]; b: string[] } }) =>
			"conflict" in r,
	);
	if (hasConflict) {
		return { hasConflict: true, regions: extractRegions(result) };
	}
	const mergedTokens: string[] = [];
	for (const region of result) {
		// Index loop rather than spread: spread throws past ~64k elements,
		// which a large document's token regions can exceed.
		if ("ok" in region && region.ok) {
			for (const token of region.ok) mergedTokens.push(token);
		}
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
