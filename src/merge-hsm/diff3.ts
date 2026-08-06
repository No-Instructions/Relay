/**
 * Adaptive three-way merge kernel.
 *
 * The exact kernel (node-diff3's diff3Merge) computes token LCS with the
 * Hunt–McIlroy candidate algorithm, whose cost grows with the number of
 * MATCHING token pairs between the buffers. Newline-split tokenization makes
 * every "\n" its own token, so two versions of an N-line document share at
 * least N^2 newline token pairs and the merge goes super-linear in document
 * size regardless of how small the edit is (measured with realistic markdown:
 * ~2s at 50KB, ~20s at 100KB, minutes at 300KB — enough to freeze the UI
 * thread).
 *
 * Documents at or below EXACT_TOKEN_LIMIT tokens run through the exact kernel
 * unchanged, so typical notes keep byte-identical merge behavior. Above the
 * limit, hunks are produced by an anchor strategy instead:
 *
 *   1. trim the common prefix/suffix tokens of each pair,
 *   2. anchor on tokens that appear exactly once in both trimmed cores and
 *      keep the longest position-increasing chain of those anchors,
 *   3. between consecutive anchors, run the exact differ when the gap is
 *      small, and treat the whole gap as one replacement when it is large.
 *
 * A coarser hunk never changes the merged text when only one side edited the
 * region — the region is taken wholesale from the changed side either way.
 * When both sides edit the same large ambiguous neighborhood, either kernel
 * may report a conflict where the other auto-merges. Clean coarse merges are
 * required to preserve both sides' edited content.
 *
 * The exact kernel also crashes on token values that collide with
 * Object.prototype members (its equivalence classes are stored in a plain
 * object), e.g. a document line consisting of just "constructor". The
 * below-limit path therefore falls back to the anchor kernel if the exact
 * kernel throws.
 *
 * The region-combining logic mirrors node-diff3's diff3MergeRegions/
 * diff3Merge (MIT licensed), so output shape and conflict semantics match the
 * exact kernel, including suppression of false conflicts where both sides
 * made the same change.
 */

import { diff3Merge } from "node-diff3";

export interface Diff3Conflict {
	a: string[];
	aIndex: number;
	o: string[];
	oIndex: number;
	b: string[];
	bIndex: number;
}

export interface Diff3Region {
	ok?: string[];
	conflict?: Diff3Conflict;
}

/** Buffers with at most this many tokens use the exact kernel unchanged. */
export const EXACT_TOKEN_LIMIT = 512;

/** Exposed so the boundary contract can be pinned without timing internals. */
export function usesExactKernel(maxTokenCount: number): boolean {
	return maxTokenCount <= EXACT_TOKEN_LIMIT;
}

/** Anchor gaps with at most this many tokens per side use the exact differ. */
const GAP_TOKEN_LIMIT = 256;

/**
 * Three-way merge over token arrays with node-diff3-compatible output.
 * Argument order matches diff3Merge: (a, o, b) = (ours, base, theirs).
 */
export function adaptiveDiff3Merge(
	a: string[],
	o: string[],
	b: string[],
): Diff3Region[] {
	if (usesExactKernel(Math.max(a.length, o.length, b.length))) {
		try {
			return diff3Merge(a, o, b) as Diff3Region[];
		} catch (error) {
			// Exact kernel crashed (prototype-colliding token); fall through.
			if (!(error instanceof TypeError)) throw error;
		}
	}
	return anchoredDiff3Merge(a, o, b);
}

/** The anchor-based merge, callable directly (exported for tests). */
export function anchoredDiff3Merge(
	a: string[],
	o: string[],
	b: string[],
): Diff3Region[] {
	const aHunks = anchoredDiffHunks(o, a);
	const bHunks = anchoredDiffHunks(o, b);
	return combineHunks(a, o, b, aHunks, bHunks);
}

/**
 * One mismatched region between the base buffer `o` and a side buffer:
 * o[oStart .. oStart+oLength) is replaced by side[abStart .. abStart+abLength).
 */
interface DiffHunk {
	oStart: number;
	oLength: number;
	abStart: number;
	abLength: number;
}

/**
 * Compute mismatch hunks between `o` and `x` in near-linear time:
 * affix trimming, unique-token anchors, exact diffing only inside small gaps.
 * Hunks are emitted in ascending base order and never adjacent (each pair is
 * separated by at least one common token).
 */
export function anchoredDiffHunks(o: string[], x: string[]): DiffHunk[] {
	const oLen = o.length;
	const xLen = x.length;

	let prefix = 0;
	const maxPrefix = Math.min(oLen, xLen);
	while (prefix < maxPrefix && o[prefix] === x[prefix]) prefix++;

	let suffix = 0;
	const maxSuffix = maxPrefix - prefix;
	while (
		suffix < maxSuffix &&
		o[oLen - 1 - suffix] === x[xLen - 1 - suffix]
	) {
		suffix++;
	}

	const oCoreEnd = oLen - suffix;
	const xCoreEnd = xLen - suffix;
	if (prefix === oCoreEnd && prefix === xCoreEnd) return [];
	if (prefix === oCoreEnd || prefix === xCoreEnd) {
		return [
			{
				oStart: prefix,
				oLength: oCoreEnd - prefix,
				abStart: prefix,
				abLength: xCoreEnd - prefix,
			},
		];
	}

	// Anchors: tokens that appear exactly once in each core. A Map keeps
	// prototype-colliding token values ("constructor", …) safe.
	const oUnique = new Map<string, number>();
	for (let i = prefix; i < oCoreEnd; i++) {
		const token = o[i];
		oUnique.set(token, oUnique.has(token) ? -1 : i);
	}
	const xUnique = new Map<string, number>();
	for (let j = prefix; j < xCoreEnd; j++) {
		const token = x[j];
		xUnique.set(token, xUnique.has(token) ? -1 : j);
	}
	const pairs: Array<[number, number]> = [];
	for (const [token, i] of oUnique) {
		if (i < 0) continue;
		const j = xUnique.get(token);
		if (j !== undefined && j >= 0) pairs.push([i, j]);
	}
	pairs.sort((p, q) => p[0] - q[0]);
	const chain = longestIncreasingChain(pairs);

	const hunks: DiffHunk[] = [];
	let oPos = prefix;
	let xPos = prefix;

	const emitGap = (oEnd: number, xEnd: number) => {
		const oGap = oEnd - oPos;
		const xGap = xEnd - xPos;
		if (oGap === 0 && xGap === 0) return;
		if (oGap === xGap && segmentsEqual(o, oPos, x, xPos, oGap)) return;
		if (oGap <= GAP_TOKEN_LIMIT && xGap <= GAP_TOKEN_LIMIT) {
			const fine = safeDiffIndices(
				o.slice(oPos, oEnd),
				x.slice(xPos, xEnd),
			);
			for (const d of fine) {
				hunks.push({
					oStart: oPos + d.buffer1[0],
					oLength: d.buffer1[1],
					abStart: xPos + d.buffer2[0],
					abLength: d.buffer2[1],
				});
			}
		} else {
			hunks.push({
				oStart: oPos,
				oLength: oGap,
				abStart: xPos,
				abLength: xGap,
			});
		}
	};

	for (const [anchorO, anchorX] of chain) {
		emitGap(anchorO, anchorX);
		oPos = anchorO + 1;
		xPos = anchorX + 1;
	}
	emitGap(oCoreEnd, xCoreEnd);

	return hunks;
}

interface LcsCandidate {
	buffer1index: number;
	buffer2index: number;
	chain: LcsCandidate | null;
}

interface DiffIndicesResult {
	buffer1: [number, number];
	buffer2: [number, number];
}

/**
 * node-diff3-compatible mismatch indices with a Map-backed equivalence table.
 * The dependency's implementation uses a plain object, so token values such
 * as "constructor" resolve to Object.prototype members and crash. Gap sizes
 * are bounded by GAP_TOKEN_LIMIT, keeping the candidate scan bounded too.
 */
function safeDiffIndices(buffer1: string[], buffer2: string[]): DiffIndicesResult[] {
	const equivalenceClasses = new Map<string, number[]>();
	for (let j = 0; j < buffer2.length; j++) {
		const item = buffer2[j];
		const indices = equivalenceClasses.get(item);
		if (indices) indices.push(j);
		else equivalenceClasses.set(item, [j]);
	}

	const nullResult: LcsCandidate = {
		buffer1index: -1,
		buffer2index: -1,
		chain: null,
	};
	const candidates: LcsCandidate[] = [nullResult];

	for (let i = 0; i < buffer1.length; i++) {
		const buffer2indices = equivalenceClasses.get(buffer1[i]) ?? [];
		let r = 0;
		let candidate = candidates[0];
		for (const j of buffer2indices) {
			let s = r;
			for (; s < candidates.length; s++) {
				if (
					candidates[s].buffer2index < j &&
					(s === candidates.length - 1 || candidates[s + 1].buffer2index > j)
				) {
					break;
				}
			}
			if (s < candidates.length) {
				const next = { buffer1index: i, buffer2index: j, chain: candidates[s] };
				if (r === candidates.length) candidates.push(candidate);
				else candidates[r] = candidate;
				r = s + 1;
				candidate = next;
				if (r === candidates.length) break;
			}
		}
		candidates[r] = candidate;
	}

	const result: DiffIndicesResult[] = [];
	let tail1 = buffer1.length;
	let tail2 = buffer2.length;
	for (
		let candidate: LcsCandidate | null = candidates[candidates.length - 1];
		candidate !== null;
		candidate = candidate.chain
	) {
		const length1 = tail1 - candidate.buffer1index - 1;
		const length2 = tail2 - candidate.buffer2index - 1;
		tail1 = candidate.buffer1index;
		tail2 = candidate.buffer2index;
		if (length1 || length2) {
			result.push({
				buffer1: [tail1 + 1, length1],
				buffer2: [tail2 + 1, length2],
			});
		}
	}
	result.reverse();
	return result;
}

/**
 * Longest chain of anchor pairs increasing in both coordinates. `pairs` is
 * sorted by (unique) first coordinate; standard patience algorithm on the
 * second coordinate, O(n log n).
 */
function longestIncreasingChain(
	pairs: Array<[number, number]>,
): Array<[number, number]> {
	if (pairs.length === 0) return [];
	const tails: number[] = [];
	const prev = new Array<number>(pairs.length).fill(-1);
	for (let k = 0; k < pairs.length; k++) {
		const j = pairs[k][1];
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (pairs[tails[mid]][1] < j) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[k] = tails[lo - 1];
		tails[lo] = k;
	}
	const chain: Array<[number, number]> = [];
	let k = tails[tails.length - 1];
	while (k >= 0) {
		chain.push(pairs[k]);
		k = prev[k];
	}
	chain.reverse();
	return chain;
}

function segmentsEqual(
	o: string[],
	oStart: number,
	x: string[],
	xStart: number,
	length: number,
): boolean {
	for (let k = 0; k < length; k++) {
		if (o[oStart + k] !== x[xStart + k]) return false;
	}
	return true;
}

function tokensEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Combine per-side hunks into ok/conflict regions. Port of node-diff3's
 * diff3MergeRegions + diff3Merge emission (MIT), with excludeFalseConflicts
 * semantics, generalized to take precomputed hunks and using index loops
 * instead of array spreads (spread throws past ~64k elements, which large
 * documents exceed).
 */
function combineHunks(
	a: string[],
	o: string[],
	b: string[],
	aHunks: DiffHunk[],
	bHunks: DiffHunk[],
): Diff3Region[] {
	interface SideHunk extends DiffHunk {
		ab: "a" | "b";
	}
	const hunks: SideHunk[] = [];
	for (const h of aHunks) hunks.push({ ab: "a", ...h });
	for (const h of bHunks) hunks.push({ ab: "b", ...h });
	// Stable sort keeps a-side before b-side at equal base offsets, matching
	// the exact kernel's ordering.
	hunks.sort((p, q) => p.oStart - q.oStart);

	const regions: Diff3Region[] = [];
	let okBuffer: string[] = [];
	const flushOk = () => {
		if (okBuffer.length) {
			regions.push({ ok: okBuffer });
			okBuffer = [];
		}
	};
	let currOffset = 0;
	const advanceTo = (endOffset: number) => {
		for (; currOffset < endOffset; currOffset++) {
			okBuffer.push(o[currOffset]);
		}
	};

	let index = 0;
	while (index < hunks.length) {
		let hunk = hunks[index++];
		const regionStart = hunk.oStart;
		let regionEnd = hunk.oStart + hunk.oLength;
		const regionHunks = [hunk];
		advanceTo(regionStart);

		// Pull in every subsequent hunk that overlaps this base region.
		while (index < hunks.length && hunks[index].oStart <= regionEnd) {
			hunk = hunks[index++];
			regionEnd = Math.max(regionEnd, hunk.oStart + hunk.oLength);
			regionHunks.push(hunk);
		}

		if (regionHunks.length === 1) {
			// Only one side changed this region: take its content.
			const only = regionHunks[0];
			if (only.abLength > 0) {
				const buffer = only.ab === "a" ? a : b;
				const end = only.abStart + only.abLength;
				for (let i = only.abStart; i < end; i++) {
					okBuffer.push(buffer[i]);
				}
			}
		} else {
			// Both sides touched the region: compute each side's span,
			// correcting for skew exactly as the exact kernel does.
			const bounds: Record<"a" | "b", number[]> = {
				a: [a.length, -1, o.length, -1],
				b: [b.length, -1, o.length, -1],
			};
			for (const h of regionHunks) {
				const oStart = h.oStart;
				const oEnd = oStart + h.oLength;
				const abStart = h.abStart;
				const abEnd = abStart + h.abLength;
				const bd = bounds[h.ab];
				bd[0] = Math.min(abStart, bd[0]);
				bd[1] = Math.max(abEnd, bd[1]);
				bd[2] = Math.min(oStart, bd[2]);
				bd[3] = Math.max(oEnd, bd[3]);
			}
			const aStart = bounds.a[0] + (regionStart - bounds.a[2]);
			const aEnd = bounds.a[1] + (regionEnd - bounds.a[3]);
			const bStart = bounds.b[0] + (regionStart - bounds.b[2]);
			const bEnd = bounds.b[1] + (regionEnd - bounds.b[3]);
			const aContent = a.slice(aStart, aEnd);
			const bContent = b.slice(bStart, bEnd);

			if (tokensEqual(aContent, bContent)) {
				// False conflict: both sides made the same change.
				for (const token of aContent) okBuffer.push(token);
			} else {
				flushOk();
				regions.push({
					conflict: {
						a: aContent,
						aIndex: aStart,
						o: o.slice(regionStart, regionEnd),
						oIndex: regionStart,
						b: bContent,
						bIndex: bStart,
					},
				});
			}
		}
		currOffset = regionEnd;
	}
	advanceTo(o.length);
	flushOk();

	return regions;
}
