/** A comparison document with exact source ranges and current text before stashed text. */

import type { ConflictBlock, ConflictValue } from "../merge-hsm/conflictValue";

export type Side = "ours" | "theirs";

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
	/** The conflict value's block id. Context blocks receive their own ids. */
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
}

export interface PickDocument {
	doc: string;
	blocks: NoteBlock[];
}

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

/** Lay out both candidates, retaining newline metadata and placeholders for empty sides. */
export function buildPickDocument(conflict: ConflictValue): PickDocument {
	const out: string[] = [];
	const blocks: NoteBlock[] = [];
	let position = 0;
	const put = (text: string, prevOpen: boolean): Rows => {
		const { rows, before, after } = split(text, prevOpen);
		const from = position;
		for (const row of rows) { out.push(row); position += row.length + 1; }
		return { from, to: position - 1, before, after };
	};
	// Whether the text laid out so far ends without a newline, so the next text begins with the separator.
	let prevOpen = false;
	let context = 0;
	for (const block of conflict.blocks) {
		if (block.kind === "same") {
			const text = put(block.text, prevOpen);
			prevOpen = !text.after;
			blocks.push({ id: `same-${context++}`, kind: "same", from: text.from, to: text.to, text, rows: { ours: null, theirs: null } });
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
		const ours = candidate("ours"), theirs = candidate("theirs");
		const rows = { ours, theirs };
		const shown = texts.ours === "" ? rows.theirs : rows.ours;
		prevOpen = !shown.after;
		blocks.push({
			id: block.id,
			kind: block.kind,
			from: ours.from,
			to: theirs.to,
			text: null,
			rows,
		});
	}
	return { doc: out.join("\n"), blocks };
}
