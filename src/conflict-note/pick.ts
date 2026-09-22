/**
 * The pick document: the note with every disagreement open, built from a
 * conflict value's blocks, and the outcome read back out of it once the
 * decisions are made. Everything here is pure. Positions are the document's
 * own and are mapped through edits by the state field that holds them.
 *
 * Ours is the note as this device has it and theirs is what came in, as the
 * conflict value says. In the document ours's rows come first, theirs's after.
 */

import type { BlockDecision, ConflictBlock, ConflictValue } from "../merge-hsm/conflictValue";

export type Side = "ours" | "theirs";
export const otherSide = (s: Side): Side => (s === "ours" ? "theirs" : "ours");

/**
 * Rows in the pick document that stand for one text: a candidate's, or a
 * stretch nobody changed. The text's own newlines at its edges are not rows,
 * they are the separators around them, so they are kept as flags and put
 * back when the text is read out.
 */
export interface Rows {
	from: number;
	to: number;
	/** The text begins with the newline that ends the line before it. */
	before: boolean;
	/** The text ends with a newline. */
	after: boolean;
}

/** A candidate's rows. */
export interface Candidate extends Rows {
	/** Taking it contributes nothing to the note: the rows shown are the lines it removes. */
	removal: boolean;
}

export type BlockKind = ConflictBlock["kind"];

export interface NoteBlock {
	/** The conflict value's block id, so a decision here names the same block the CLI would. Context blocks have their own. */
	id: string;
	kind: BlockKind;
	/** The block's whole span in the document: every row it has. */
	from: number;
	to: number;
	/** A context block's text; null for the others. */
	text: Rows | null;
	/**
	 * The rows of each side. A disagreement has both. A merged edit has the
	 * edit on the editing side and the lines as they were on the other. A
	 * context block has neither.
	 */
	rows: { ours: Candidate | null; theirs: Candidate | null };
	/** Decided, and which sides are in. A merged edit starts undecided with the edit in. */
	resolved: boolean;
	take: { ours: boolean; theirs: boolean };
}

export interface PickDocument {
	doc: string;
	blocks: NoteBlock[];
}

/** The side that made a merged edit; null for a disagreement or context. */
export const editingSide = (b: NoteBlock): Side | null =>
	b.kind === "ours-only" ? "ours" : b.kind === "theirs-only" ? "theirs" : null;
export const isMerged = (b: NoteBlock) => editingSide(b) !== null;
export const isDisagreement = (b: NoteBlock) => b.kind === "conflict";
export const isContext = (b: NoteBlock) => b.kind === "same";
/** Whether taking this side takes lines out rather than putting lines in. */
export const removes = (b: NoteBlock, s: Side) => !!b.rows[s]?.removal;
/** Whether this side is the lines as they were before a merged edit: taking it puts them back. */
export const leavesAsWas = (b: NoteBlock, s: Side) => isMerged(b) && s !== editingSide(b) && !removes(b, s);
/** A choice of exactly one row: a text against its removal, or an edit against the lines as they were. */
export const isEitherOr = (b: NoteBlock) =>
	isMerged(b) || !b.rows.ours || !b.rows.theirs || removes(b, "ours") || removes(b, "theirs");
export const undecided = (b: NoteBlock) => isDisagreement(b) && !b.resolved;
export const isIn = (b: NoteBlock, s: Side) => b.resolved && b.take[s];

/**
 * A text as rows. The value's blocks are runs of whole lines: a newline at
 * the end of a text closes its last line, and a text that begins right after
 * an unfinished line begins with the newline that finishes it. Neither is a
 * row; the lines between them are.
 */
function split(text: string, prevOpen: boolean): { rows: string[]; before: boolean; after: boolean } {
	const before = prevOpen && text.startsWith("\n");
	let t = before ? text.slice(1) : text;
	const after = t.endsWith("\n");
	if (after) t = t.slice(0, -1);
	return { rows: t.split("\n"), before, after };
}

/** How the rows of a block are ordered: a pick shows what a merged edit did before the lines as they were; a diff shows the note's lines before the change's in every block. */
export type Layout = "pick" | "diff";

/**
 * Lay the conflict out as a document. Every row of every candidate is a real
 * line, so the note renders them as it renders any line. A disagreement shows
 * ours's rows then theirs's; a merged edit shows what the edit did, then the
 * lines as they were, except in a diff, where the note's lines come first in
 * every block. A removal, a side with no text, shows the lines it removes:
 * the block's base, or where there is no base the other side's lines.
 */
export function buildPickDocument(conflict: ConflictValue, layout: Layout = "pick"): PickDocument {
	const out: string[] = [];
	const blocks: NoteBlock[] = [];
	const pos = () => out.reduce((n, l) => n + l.length + 1, 0);
	const put = (text: string, prevOpen: boolean): Rows => {
		const { rows, before, after } = split(text, prevOpen);
		const from = pos();
		out.push(...rows);
		return { from, to: pos() - 1, before, after };
	};
	// Whether the text laid out so far ends without a newline, so the next text begins with the separator.
	let prevOpen = false;
	let context = 0;
	for (const block of conflict.blocks) {
		if (block.kind === "same") {
			const text = put(block.text, prevOpen);
			prevOpen = !text.after;
			blocks.push({ id: `same-${context++}`, kind: "same", from: text.from, to: text.to, text, rows: { ours: null, theirs: null }, resolved: true, take: { ours: false, theirs: false } });
			continue;
		}
		const texts = block.kind === "conflict"
			? { ours: block.ours, theirs: block.theirs }
			: block.kind === "ours-only"
				? { ours: block.ours, theirs: block.base }
				: { ours: block.base, theirs: block.theirs };
		// A side with no text is a removal: it shows the lines it removes, the
		// base's or, with no base, the other side's, and its own text is empty.
		const fallbacks = block.kind === "conflict"
			? { ours: block.base ?? block.theirs, theirs: block.base ?? block.ours }
			: block.kind === "ours-only"
				? { ours: block.base, theirs: block.ours }
				: { ours: block.theirs, theirs: block.base };
		const candidate = (s: Side): Candidate => {
			const own = texts[s];
			const rows = put(own === "" ? fallbacks[s] : own, prevOpen);
			return own === "" ? { ...rows, before: false, after: false, removal: true } : { ...rows, removal: false };
		};
		const side = block.kind === "ours-only" ? "ours" : block.kind === "theirs-only" ? "theirs" : null;
		const first: Side = layout === "diff" ? "ours" : (side ?? "ours");
		const upper = candidate(first);
		const lower = candidate(otherSide(first));
		const rows = first === "ours" ? { ours: upper, theirs: lower } : { ours: lower, theirs: upper };
		const shown = texts.ours === "" ? rows.theirs : rows.ours;
		prevOpen = !shown.after;
		blocks.push({
			id: block.id,
			kind: block.kind,
			from: upper.from,
			to: lower.to,
			text: null,
			rows,
			resolved: false,
			take: { ours: side === "ours", theirs: side === "theirs" },
		});
	}
	return { doc: out.join("\n"), blocks };
}

export type Decision = { resolved: boolean; take: { ours: boolean; theirs: boolean } };
export const sameDecision = (b: NoteBlock, d: Decision) =>
	b.resolved === d.resolved && b.take.ours === d.take.ours && b.take.theirs === d.take.theirs;

/**
 * The decision a click on a side makes. Between two texts, the sole chosen
 * side clicked again takes neither and shift adds the other. In a choice of
 * exactly one, a click chooses that row and a second click leaves it chosen.
 */
export function clickDecision(b: NoteBlock, s: Side, also: boolean): Decision {
	const one: Decision = { resolved: true, take: { ours: s === "ours", theirs: s === "theirs" } };
	if (isEitherOr(b)) return one;
	if (also) return { resolved: true, take: { ours: true, theirs: true } };
	if (b.resolved && b.take[s] && !b.take[otherSide(s)]) return { resolved: true, take: { ours: false, theirs: false } };
	return one;
}

/** A decision in the engine's words: that side, both, or neither. */
export function wholeDecision(d: BlockDecision): Decision {
	return { resolved: true, take: { ours: d === "ours" || d === "both", theirs: d === "theirs" || d === "both" } };
}

/** The engine's word for a block's decision, so a debug reader and the CLI name the same thing. */
export function decisionOf(b: NoteBlock): BlockDecision | null {
	if (!b.resolved) return null;
	if (b.take.ours && b.take.theirs) return "both";
	if (b.take.ours) return "ours";
	if (b.take.theirs) return "theirs";
	return "neither";
}

/** The rows a block contributes to the outcome, in order, given its decision so far. */
export function takenRows(b: NoteBlock): Candidate[] {
	if (isContext(b)) return [];
	const editor = editingSide(b);
	let take = b.take;
	if (!b.resolved) take = editor ? { ours: editor === "ours", theirs: editor === "theirs" } : { ours: true, theirs: false };
	const out: Candidate[] = [];
	for (const s of ["ours", "theirs"] as const) {
		const c = b.rows[s];
		if (take[s] && c && !c.removal) out.push(c);
	}
	return out;
}

/**
 * The note as decided, read from the document so that edits made inside a
 * row are kept. Each text is its rows with its own edge newlines put back,
 * and the texts run together as the value's blocks do. Undecided, a
 * disagreement shows ours and a merged edit stays merged; a removal taken
 * contributes nothing.
 */
export function outcomeText(doc: { sliceString(from: number, to: number): string }, blocks: NoteBlock[]): string {
	const read = (r: Rows) => (r.before ? "\n" : "") + doc.sliceString(r.from, r.to) + (r.after ? "\n" : "");
	let text = "";
	for (const b of blocks) {
		if (b.text) text += read(b.text);
		// Both sides taken go on separate lines, as the engine joins them.
		let last = "";
		for (const c of takenRows(b)) {
			const t = read(c);
			text += last !== "" && !last.endsWith("\n") && t !== "" ? `\n${t}` : t;
			last = t;
		}
	}
	return text;
}
