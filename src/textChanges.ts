import { diff_match_patch } from "diff-match-patch";
import type * as Y from "yjs";

export interface TextChange {
	from: number;
	to: number;
	insert: string;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Widen non-overlapping, pre-change UTF-16 ranges without changing their result.
 * Preserved code units join the replacement so pairs stay in one Yjs item, both
 * in the old text and in the inserted text. Touching ranges are combined before
 * application so two edits to the same pair cannot split each other's result.
 *
 * Yjs also replaces a lone high surrogate when splitting immediately after it.
 * Carry those code units into the replacement too; never sanitize the input.
 */
export function snapTextChanges(
	before: string,
	changes: readonly TextChange[],
): TextChange[] {
	const sorted = [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
	const result: TextChange[] = [];
	for (let i = 0; i < sorted.length; i++) {
		let { from, to, insert } = sorted[i];
		if (from === to && insert.length === 0) continue;

		while (from > 0 && isHighSurrogate(before.charCodeAt(from - 1))) {
			insert = before[--from] + insert;
		}

		// Absorb a following edit before consuming its source text as padding.
		for (;;) {
			const next = sorted[i + 1];
			if (next && next.from === to) {
				insert += next.insert;
				to = next.to;
				i++;
			} else if (
				to < before.length &&
				(isHighSurrogate(before.charCodeAt(to - 1)) ||
					(isHighSurrogate(insert.charCodeAt(insert.length - 1)) &&
						isLowSurrogate(before.charCodeAt(to))))
			) {
				insert += before[to++];
			} else {
				break;
			}
		}

		const previous = result[result.length - 1];
		if (previous && previous.to === from) {
			previous.to = to;
			previous.insert += insert;
		} else {
			result.push({ from, to, insert });
		}
	}
	return result;
}

/** Compute incremental replacements while retaining unchanged CRDT history. */
export function diffTextChanges(before: string, after: string): TextChange[] {
	if (before === after) return [];
	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(before, after);
	dmp.diff_cleanupSemantic(diffs);
	const changes: TextChange[] = [];
	let pos = 0;
	for (const [op, text] of diffs) {
		if (op === 0) {
			pos += text.length;
		} else if (op === -1) {
			changes.push({ from: pos, to: pos + text.length, insert: "" });
			pos += text.length;
		} else {
			changes.push({ from: pos, to: pos, insert: text });
		}
	}
	return snapTextChanges(before, changes);
}

/** Apply within the caller's transaction, keeping its origin and observers. */
export function applyTextChanges(ytext: Y.Text, changes: readonly TextChange[]): void {
	const snapped = snapTextChanges(ytext.toString(), changes);
	// Every range refers to the original text, so apply from the end.
	for (let i = snapped.length - 1; i >= 0; i--) {
		const { from, to, insert } = snapped[i];
		if (to > from) ytext.delete(from, to - from);
		if (insert.length > 0) ytext.insert(from, insert);
	}
}
