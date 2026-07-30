import { diff_match_patch } from "diff-match-patch";
import type { PositionedChange } from "../types";

export interface BufferedCM6Edit {
	changes: PositionedChange[];
	docText: string;
	userEvent?: string;
}

export interface BufferedCM6ReplayEvent {
	type: "CM6_CHANGE";
	changes: PositionedChange[];
	docText: string;
	viewId: string;
	userEvent?: string;
}

export function buildBufferedCM6ReplayEvents(
	pendingEdits: BufferedCM6Edit[],
	viewId: string,
): BufferedCM6ReplayEvent[] {
	return pendingEdits.map((edit) => ({
		type: "CM6_CHANGE",
		changes: edit.changes,
		docText: edit.docText,
		viewId,
		...(edit.userEvent !== undefined ? { userEvent: edit.userEvent } : {}),
	}));
}

/**
 * Reapply edits made against an editor's pre-load buffer after setViewData
 * replaces that buffer with the loaded document.
 */
export function rebaseBufferedTextAcrossReplacement(
	baseText: string,
	editedText: string,
	replacementText: string,
): string | null {
	const dmp = new diff_match_patch();
	const patches = dmp.patch_make(baseText, editedText);
	const [rebased, applied] = dmp.patch_apply(patches, replacementText) as [
		string,
		boolean[],
	];
	return applied.every(Boolean) ? rebased : null;
}

export function buildTextChanges(
	before: string,
	after: string,
): PositionedChange[] {
	if (before === after) return [];

	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(before, after);
	dmp.diff_cleanupSemantic(diffs);

	const changes: PositionedChange[] = [];
	let pos = 0;
	for (let i = 0; i < diffs.length; ) {
		const [op, text] = diffs[i];
		if (op === 0) {
			pos += text.length;
			i += 1;
			continue;
		}

		const from = pos;
		let insert = "";
		while (i < diffs.length && diffs[i][0] !== 0) {
			const [editOp, editText] = diffs[i];
			if (editOp === -1) {
				pos += editText.length;
			} else {
				insert += editText;
			}
			i += 1;
		}
		changes.push({ from, to: pos, insert });
	}
	return changes;
}
