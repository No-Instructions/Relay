/**
 * The words that differ between two texts, as ranges in each, for marking
 * inside changed lines the way a pull request does.
 */

import { diffWordsWithSpace } from "diff";

export interface WordRanges {
	old: [number, number][];
	new: [number, number][];
}

export function changedWords(oldText: string, newText: string): WordRanges {
	const out: WordRanges = { old: [], new: [] };
	if (!oldText || !newText) return out;
	let a = 0;
	let b = 0;
	for (const part of diffWordsWithSpace(oldText, newText)) {
		const n = part.value.length;
		if (part.added) {
			if (part.value.trim()) out.new.push([b, b + n]);
			b += n;
		} else if (part.removed) {
			if (part.value.trim()) out.old.push([a, a + n]);
			a += n;
		} else {
			a += n;
			b += n;
		}
	}
	// Texts that share almost nothing are better read whole than as a scatter of marks.
	const share = (ranges: [number, number][], len: number) => ranges.reduce((s, [f, t]) => s + t - f, 0) / Math.max(1, len);
	if (share(out.old, oldText.length) > 0.6 || share(out.new, newText.length) > 0.6) return { old: [], new: [] };
	return out;
}
