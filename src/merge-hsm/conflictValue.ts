/**
 * The conflict as an immutable value: two sides with what each one is, the
 * blocks that cover the note, and nothing else. Decisions live beside the
 * value, and the outcome is computed from both by a pure function. Nothing
 * here reads a document, a file or an editor, and no block holds a position
 * in one.
 */

import { adaptiveDiff3Blocks, twoWayBlocks, type Diff3Block } from "./diff3";

/** What a side's text is for the user, not which object holds it. */
export type ConflictSource = "editor" | "file" | "record" | "remote";

export type ConflictSituation =
	| "both-edited"
	| "no-baseline"
	| "drift"
	| "merge-failed";

export interface ConflictSide {
	readonly source: ConflictSource;
	readonly text: string;
}

/** A stretch of the note. Blocks cover the whole note, in order, without gaps. */
export type ConflictBlock =
	| { readonly kind: "same"; readonly text: string }
	| { readonly kind: "ours-only"; readonly id: string; readonly base: string; readonly ours: string }
	| { readonly kind: "theirs-only"; readonly id: string; readonly base: string; readonly theirs: string }
	| {
			readonly kind: "conflict";
			readonly id: string;
			readonly base: string | null;
			readonly ours: string;
			readonly theirs: string;
		};

export type DecidableBlock = Exclude<ConflictBlock, { kind: "same" }>;

export interface ConflictValue {
	readonly id: string;
	readonly situation: ConflictSituation;
	readonly base: string | null;
	readonly ours: ConflictSide;
	readonly theirs: ConflictSide;
	readonly blocks: readonly ConflictBlock[];
}

export type BlockDecision = "ours" | "theirs" | "both" | "neither";
export type Decisions = ReadonlyMap<string, BlockDecision>;

// =============================================================================
// Sides
// =============================================================================

/**
 * One of the two texts a conflict compares, as the place that raises the
 * conflict knows it.
 */
export type ComparedText =
	| { readonly holder: "editor"; readonly text: string }
	| { readonly holder: "remote"; readonly text: string }
	| {
			readonly holder: "file";
			readonly text: string;
			/** Whether the file changed since it last agreed with the record; null when nothing can tell. */
			readonly moved: boolean | null;
		}
	| {
			readonly holder: "record";
			readonly text: string;
			/** Whether the record holds edits of this device that the remote does not have. */
			readonly hasOwnEdits: boolean;
			/** Whether the record changed since it last agreed with the file; null when nothing can tell. */
			readonly moved: boolean | null;
		};

const isRemoteContent = (t: ComparedText): boolean =>
	t.holder === "remote" || (t.holder === "record" && !t.hasOwnEdits);

const sourceOf = (t: ComparedText): ConflictSource =>
	isRemoteContent(t) ? "remote" : t.holder;

/**
 * Which of two compared texts is ours, the note as this device has it, and
 * which is theirs, what came in. The one place that decides it.
 *
 * 1. The editor's text is ours.
 * 2. Remote content is theirs: the remote, or a record with nothing of this
 *    device's in it.
 * 3. Otherwise the two are the record and the file, both this device's note:
 *    the one that moved since they last agreed is theirs, and when that
 *    cannot be told the file is, since anything can write a file.
 */
export function assignSides(
	x: ComparedText,
	y: ComparedText,
): { ours: ConflictSide; theirs: ConflictSide } {
	const sides = (ours: ComparedText, theirs: ComparedText) => ({
		ours: { source: sourceOf(ours), text: ours.text },
		theirs: { source: sourceOf(theirs), text: theirs.text },
	});
	if (x.holder === y.holder) {
		throw new Error(`A conflict compares two different texts, got ${x.holder} twice`);
	}
	if (x.holder === "editor") return sides(x, y);
	if (y.holder === "editor") return sides(y, x);
	const xRemote = isRemoteContent(x);
	const yRemote = isRemoteContent(y);
	if (xRemote && yRemote) {
		throw new Error(
			"A conflict between two texts of remote content has no side that is this device's",
		);
	}
	if (yRemote) return sides(x, y);
	if (xRemote) return sides(y, x);
	// The record, holding this device's edits, against the file.
	const record = x.holder === "record" ? x : y;
	const file = x.holder === "file" ? x : y;
	if (record.holder !== "record" || file.holder !== "file") {
		throw new Error(`Cannot assign sides to ${x.holder} against ${y.holder}`);
	}
	if (file.moved === true) return sides(record, file);
	if (file.moved === false && record.moved === true) return sides(file, record);
	return sides(record, file);
}

// =============================================================================
// Building the value
// =============================================================================

function hashString(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

// Separators that cannot occur in a note's text, so hashed parts never run together.
const FIELD = String.fromCharCode(0);
const ABSENT = String.fromCharCode(1);

const tokenize = (s: string): string[] => s.split(/(\n)/);

/**
 * Slide every block edge onto a line boundary. Tokens alternate line, newline,
 * line in every text, so a block edge sits either after a newline or after a
 * line. Where a block starts after a line, its sides begin with the newline
 * that ends that line: that newline moves to the block before, and the
 * newline that begins the block after moves onto the end of every side that
 * has text. A side with no text has neither newline, so for a block with such
 * a side the two moves go together or not at all; where they cannot go and
 * the line before is empty, the empty line moves into the block instead. The
 * texts are unchanged; only where the edges fall between them moves.
 * Afterwards every block boundary follows a newline, except before a last
 * block that adds or removes lines after an unfinished line.
 */
export function alignToLines(blocks: Diff3Block[]): Diff3Block[] {
	const out: Diff3Block[] = blocks.map((b) =>
		b.kind === "same"
			? { kind: "same", tokens: b.tokens.slice() }
			: b.kind === "conflict"
				? { kind: "conflict", a: b.a.slice(), o: b.o.slice(), b: b.b.slice() }
				: { kind: b.kind, o: b.o.slice(), tokens: b.tokens.slice() },
	);
	const sidesOf = (b: Diff3Block): string[][] =>
		b.kind === "same" ? [b.tokens] : b.kind === "conflict" ? [b.a, b.o, b.b] : [b.o, b.tokens];
	const last = (t: string[]) => t[t.length - 1];
	for (let i = 0; i < out.length; i++) {
		const cur = out[i];
		if (cur.kind === "same") continue;
		const all = sidesOf(cur);
		const sides = all.filter((t) => t.length > 0);
		if (sides.length === 0) continue;
		const hasEmpty = sides.length < all.length;
		const prev = i > 0 && out[i - 1].kind === "same" ? (out[i - 1] as { tokens: string[] }) : null;
		const next = i + 1 < out.length && out[i + 1].kind === "same" ? (out[i + 1] as { tokens: string[] }) : null;
		const prefixOpen = !!prev && prev.tokens.length > 0 && last(prev.tokens) !== "\n";
		const curOpen = sides.some((t) => last(t) !== "\n");
		const nextSep = !!next && next.tokens[0] === "\n" && curOpen;
		const front = () => {
			for (const t of sides) if (t[0] === "\n") t.shift();
			prev!.tokens.push("\n");
		};
		const back = () => {
			next!.tokens.shift();
			for (const t of sides) if (last(t) !== "\n") t.push("\n");
		};
		if (!hasEmpty) {
			if (prefixOpen) front();
			if (nextSep) back();
		} else if (prefixOpen && nextSep) {
			front();
			back();
		} else if (prefixOpen && last(prev!.tokens) === "") {
			prev!.tokens.pop();
			for (const t of sides) t.unshift("");
		}
	}
	return out.filter((b) => b.kind !== "same" || b.tokens.length > 0);
}

/**
 * Build the conflict value. Blocks come from Relay's own three-way merge when
 * there is a baseline, and from a line-aligned two-way comparison when there
 * is none. A merge that failed has no computed blocks: both whole texts are
 * one block.
 */
export function buildConflict(args: {
	situation: ConflictSituation;
	base: string | null;
	ours: ConflictSide;
	theirs: ConflictSide;
}): ConflictValue {
	const { situation, ours, theirs } = args;
	const base = situation === "both-edited" ? args.base : null;
	if (situation === "both-edited" && base === null) {
		throw new Error("A both-edited conflict needs a baseline");
	}
	let raw: Diff3Block[];
	if (situation === "merge-failed") {
		raw = [{ kind: "conflict", a: [ours.text], o: [], b: [theirs.text] }];
	} else if (base !== null) {
		raw = alignToLines(adaptiveDiff3Blocks(tokenize(ours.text), tokenize(base), tokenize(theirs.text)));
	} else {
		raw = alignToLines(twoWayBlocks(tokenize(ours.text), tokenize(theirs.text)));
	}

	const used = new Set<string>();
	const idFor = (kind: string, parts: (string | null)[]): string => {
		// Two blocks with the same contents get different ids by their order of
		// appearance, which is as deterministic as the contents are.
		for (let occurrence = 0; ; occurrence++) {
			const id = hashString(
				[kind, ...parts.map((p) => p ?? ABSENT), String(occurrence)].join(FIELD),
			);
			if (!used.has(id)) {
				used.add(id);
				return id;
			}
		}
	};
	const blocks: ConflictBlock[] = raw.map((r): ConflictBlock => {
		if (r.kind === "same") return { kind: "same", text: r.tokens.join("") };
		if (r.kind === "conflict") {
			const blockBase = base === null ? null : r.o.join("");
			const mine = r.a.join("");
			const other = r.b.join("");
			return {
				kind: "conflict",
				id: idFor("conflict", [blockBase, mine, other]),
				base: blockBase,
				ours: mine,
				theirs: other,
			};
		}
		const was = r.o.join("");
		const now = r.tokens.join("");
		return r.kind === "a"
			? { kind: "ours-only", id: idFor("ours-only", [was, now]), base: was, ours: now }
			: { kind: "theirs-only", id: idFor("theirs-only", [was, now]), base: was, theirs: now };
	});

	const id = hashString(
		[situation, ours.source, ours.text, theirs.source, theirs.text, base ?? ABSENT].join(FIELD),
	);
	return Object.freeze({
		id,
		situation,
		base,
		ours: Object.freeze({ ...ours }),
		theirs: Object.freeze({ ...theirs }),
		blocks: Object.freeze(blocks.map((b) => Object.freeze(b))),
	});
}

// =============================================================================
// Decisions and the outcome
// =============================================================================

export const decidableBlocks = (conflict: ConflictValue): DecidableBlock[] =>
	conflict.blocks.filter((b): b is DecidableBlock => b.kind !== "same");

/** The blocks both sides changed: the ones a person has to decide. */
export const conflictBlocks = (conflict: ConflictValue) =>
	conflict.blocks.filter(
		(b): b is Extract<ConflictBlock, { kind: "conflict" }> => b.kind === "conflict",
	);

export const isFullyDecided = (conflict: ConflictValue, decisions: Decisions): boolean =>
	conflictBlocks(conflict).every((b) => decisions.has(b.id));

/** A block's two alternatives: for a one-sided block the missing side is its base. */
function alternatives(block: DecidableBlock): { ours: string; theirs: string } {
	if (block.kind === "ours-only") return { ours: block.ours, theirs: block.base };
	if (block.kind === "theirs-only") return { ours: block.base, theirs: block.theirs };
	return { ours: block.ours, theirs: block.theirs };
}

/** Both texts, ours first, on separate lines. */
function joined(ours: string, theirs: string): string {
	if (ours === "" || theirs === "") return ours + theirs;
	return ours.endsWith("\n") ? ours + theirs : `${ours}\n${theirs}`;
}

/**
 * Whether a decision may be made on a block. Taking both, or neither, means
 * something only between two texts: where one side of a block is empty the
 * choice is one or the other.
 */
export function decisionAllowed(block: DecidableBlock, decision: BlockDecision): boolean {
	if (decision === "ours" || decision === "theirs") return true;
	if (block.kind !== "conflict") return false;
	return block.ours !== "" && block.theirs !== "";
}

/**
 * The note that results from a conflict and the decisions made on it. Pure.
 * Undecided, a one-sided change stays merged in and a disagreement shows
 * ours, so nothing changes for the user until they decide.
 */
export function outcome(conflict: ConflictValue, decisions: Decisions): string {
	const parts: string[] = [];
	for (const block of conflict.blocks) {
		if (block.kind === "same") {
			parts.push(block.text);
			continue;
		}
		const { ours, theirs } = alternatives(block);
		const fallback: BlockDecision = block.kind === "theirs-only" ? "theirs" : "ours";
		let decision = decisions.get(block.id) ?? fallback;
		if (!decisionAllowed(block, decision)) decision = fallback;
		if (decision === "ours") parts.push(ours);
		else if (decision === "theirs") parts.push(theirs);
		else if (decision === "both") parts.push(joined(ours, theirs));
	}
	return parts.join("");
}

/** The decisions that still apply to a conflict raised afresh: those whose block is still there. */
export function carryOver(decisions: Decisions, fresh: ConflictValue): Map<string, BlockDecision> {
	const kept = new Map<string, BlockDecision>();
	for (const block of decidableBlocks(fresh)) {
		const d = decisions.get(block.id);
		if (d !== undefined && decisionAllowed(block, d)) kept.set(block.id, d);
	}
	return kept;
}
