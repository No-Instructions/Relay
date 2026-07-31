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

function insertionLayersByBasePosition(
	baseText: string,
	editedText: string,
): Map<number, string> | null {
	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(baseText, editedText);
	const inserts = new Map<number, string>();
	let basePosition = 0;
	for (const [operation, text] of diffs) {
		if (operation === -1) return null;
		if (operation === 0) {
			basePosition += text.length;
		} else {
			inserts.set(basePosition, (inserts.get(basePosition) ?? "") + text);
		}
	}
	return inserts;
}

function ingestedInsertionCoverage(
	baseText: string,
	editedText: string,
	ingestedText: string,
): number | null {
	if (editedText === ingestedText) return Number.MAX_SAFE_INTEGER;
	const complete = insertionLayersByBasePosition(baseText, editedText);
	const ingested = insertionLayersByBasePosition(baseText, ingestedText);
	if (!complete || !ingested) return null;
	const completeInsertions = [...complete.values()];
	let coverage = 0;
	for (const text of ingested.values()) {
		const match = completeInsertions.findIndex((candidate) =>
			candidate.includes(text),
		);
		if (match < 0) return null;
		completeInsertions.splice(match, 1);
		coverage += text.length;
	}
	return ingested.size > 0 ? coverage : null;
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
	alreadyIngestedTexts: readonly string[] = [],
): string | null {
	// A sibling save echo may have delivered some or all of this layer. Use
	// the HSM's point-in-time accepted snapshot as the patch base, never the
	// moving render target; unrelated later edits cannot make delivered input
	// appear new again.
	let patchBase = baseText;
	let bestCoverage = -1;
	for (const ingestedText of alreadyIngestedTexts) {
		const coverage = ingestedInsertionCoverage(
			baseText,
			editedText,
			ingestedText,
		);
		if (coverage !== null && coverage > bestCoverage) {
			patchBase = ingestedText;
			bestCoverage = coverage;
		}
	}
	if (patchBase !== editedText) {
		// A provenance baseline can only remove work already delivered from this
		// typing layer. If rebasing it to the complete layer would delete text,
		// the candidate contains unrelated content and must not become a patch
		// base: buffered typing is a pure-insertion operation here.
		const patchDiffs = new diff_match_patch().diff_main(patchBase, editedText);
		if (patchDiffs.some(([operation]) => operation === -1)) {
			patchBase = baseText;
		}
	}
	if (editedText === patchBase) return replacementText;

	const dmp = new diff_match_patch();
	const patches = dmp.patch_make(patchBase, editedText);
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
