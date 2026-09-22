/**
 * The state the note carries while a conflict is open: the blocks and their
 * decisions, which candidate the pointer is on, and which side a whole-file
 * button is previewing. Decisions live beside the text in a state field until
 * the note is resolved. Nothing in the text moves while picking, so any
 * decision can still be changed, and undo takes decisions back like edits.
 */

import { StateEffect, StateField, type Transaction } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import type { ConflictSituation, ConflictSource } from "../merge-hsm/conflictValue";
import { type Candidate, type Decision, type NoteBlock, type Rows, type Side, editingSide, isDisagreement, isMerged, undecided } from "./pick";

/** How the conflict is shown: a pick between rows, or one diff taken whole or left. */
export type View = "pick" | "diff";

/**
 * What the situation box says and offers. `text` may hold one phrase in double
 * square brackets, the link that sends a bug report.
 */
export interface Copy {
	title: string;
	text: string;
	ours: string;
	theirs: string;
}

/** What the note needs from the view that opened it. */
export interface Session {
	done(): void;
	/** The document was replaced under the conflict by something other than the session. */
	lost(): void;
	report?(): void;
}

export interface NoteState {
	conflictId: string;
	situation: ConflictSituation;
	sources: { ours: ConflictSource; theirs: ConflictSource };
	view: View;
	copy: Copy;
	blocks: NoteBlock[];
	/** Merged edits are candidates to review, not just the note's text. */
	review: boolean;
	session: Session;
}

export type BlockPatch = Partial<Decision>;
export const setBlock = StateEffect.define<{ id: string; patch: BlockPatch }>();
export const setReview = StateEffect.define<boolean>();
/** Replace the whole state, for opening or closing the conflict. */
export const setConflict = StateEffect.define<NoteState | null>();

const replacesAll = (tr: Transaction): boolean => {
	if (tr.isUserEvent("set")) return true;
	let whole = false;
	tr.changes.iterChangedRanges((fromA, toA) => {
		if (fromA === 0 && toA === tr.startState.doc.length) whole = true;
	});
	return whole;
};

const mapRows = <R extends Rows>(r: R, tr: Transaction): R => ({ ...r, from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) });
const mapCandidate = (c: Candidate | null, tr: Transaction): Candidate | null => (c ? mapRows(c, tr) : null);

export const conflictField = StateField.define<NoteState | null>({
	create: () => null,
	update(value, tr) {
		// A change that replaces the whole document leaves nothing of the layout to follow: the conflict is no longer shown.
		if (value && tr.docChanged && replacesAll(tr)) value = null;
		// Blocks already held follow the transaction's changes; a state arriving with it is placed in the new document.
		if (value && tr.docChanged) {
			value = {
				...value,
				blocks: value.blocks.map((b) => ({
					...b,
					from: tr.changes.mapPos(b.from, -1),
					to: tr.changes.mapPos(b.to, 1),
					text: b.text ? mapRows(b.text, tr) : null,
					rows: { ours: mapCandidate(b.rows.ours, tr), theirs: mapCandidate(b.rows.theirs, tr) },
				})),
			};
		}
		for (const e of tr.effects) if (e.is(setConflict)) value = e.value;
		if (!value) return value;
		let blocks = value.blocks;
		let review = value.review;
		for (const e of tr.effects) {
			if (e.is(setBlock)) blocks = blocks.map((b) => (b.id === e.value.id ? { ...b, ...e.value.patch } : b));
			if (e.is(setReview)) review = e.value;
		}
		return blocks === value.blocks && review === value.review ? value : { ...value, blocks, review };
	},
});

/** Undo puts a decision back the way it was. */
export const conflictHistory = invertedEffects.of((tr) => {
	const before = tr.startState.field(conflictField, false);
	const out: StateEffect<unknown>[] = [];
	if (!before) return out;
	for (const e of tr.effects) {
		if (!e.is(setBlock)) continue;
		const b = before.blocks.find((x) => x.id === e.value.id);
		if (!b) continue;
		const patch: BlockPatch = {};
		if ("resolved" in e.value.patch) patch.resolved = b.resolved;
		if ("take" in e.value.patch) patch.take = { ...b.take };
		out.push(setBlock.of({ id: b.id, patch }));
	}
	return out;
});

export interface Hover {
	id: string;
	side: Side;
}
export const setHover = StateEffect.define<Hover | null>();
export const hoverField = StateField.define<Hover | null>({
	create: () => null,
	update(v, tr) {
		for (const e of tr.effects) if (e.is(setHover)) v = e.value;
		return v;
	},
});
export const sameHover = (a: Hover | null, b: Hover | null) => a === b || (!!a && !!b && a.id === b.id && a.side === b.side);

/** A whole-file button under the pointer: every candidate on that side lights at once, and the other side's grey. */
export const setPreview = StateEffect.define<Side | null>();
export const previewField = StateField.define<Side | null>({
	create: () => null,
	update(v, tr) {
		for (const e of tr.effects) if (e.is(setPreview)) v = e.value;
		return v;
	},
});

/**
 * Whether a merged edit shows as a candidate at all. With the review off it
 * does not, unless the user has picked the lines as they were: a decision
 * against the merge has to stay in sight.
 */
export const showsMerged = (s: NoteState, b: NoteBlock) => isMerged(b) && (s.review || !b.take[editingSide(b)!]);
/** Disagreements still to decide. */
export const remaining = (s: NoteState | null) => (s ? s.blocks.filter(undecided).length : 0);
/** The changes a diff view shows: every disagreement and every edit that merged on its own from the side that came in. */
export const diffBlocks = (s: NoteState | null) => (s ? s.blocks.filter((b) => isDisagreement(b) || b.kind === "theirs-only") : []);

/**
 * A whole-file choice: every disagreement takes that side. A diff is taken
 * whole or left, so there the choice also covers the edits that merged on
 * their own from the side that came in.
 */
export function decideAll(state: NoteState, side: Side | "both", whole = false): StateEffect<unknown>[] {
	const take = { ours: side === "ours" || side === "both", theirs: side === "theirs" || side === "both" };
	return state.blocks
		.filter((b) => isDisagreement(b) || (whole && b.kind === "theirs-only"))
		.map((b) => setBlock.of({ id: b.id, patch: { resolved: true, take } }));
}
