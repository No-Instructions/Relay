import { RangeSetBuilder, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { Candidate, NoteBlock } from "./pick";
import { changedWords } from "./words";

type Item = { from: number; to: number; deco: Decoration };

/** Shared line and word decorations for a note's two-way comparison layout. */
export function diffDecorations(doc: Text, blocks: readonly NoteBlock[]): DecorationSet {
	const items: Item[] = [];
	const rows = (candidate: Candidate, side: "ours" | "theirs", id: string) => {
		const kind = side === "ours" ? "del" : "add";
		for (let pos = candidate.from; ;) {
			const line = doc.lineAt(pos);
			items.push({ from: line.from, to: line.from, deco: Decoration.line({
				class: `relay-conflict-line relay-conflict-diff is-${kind}`,
				attributes: { "data-relay-conflict-side": side, "data-relay-conflict-block": id },
			}) });
			if (line.to >= candidate.to) break;
			pos = line.to + 1;
		}
	};
	for (const block of blocks) {
		// The pick model includes placeholder rows for an empty candidate.
		// A comparison folds those rows, exactly as the inline differ does.
		for (const side of ["ours", "theirs"] as const) {
			const candidate = block.rows[side];
			if (candidate && (candidate.removal || (block.kind === "ours-only" && side === "theirs"))) {
				items.push({ from: doc.lineAt(candidate.from).from, to: candidate.to, deco: Decoration.replace({ block: true }) });
			}
		}
		if (block.kind === "same" || block.kind === "ours-only") continue;
		const ours = block.rows.ours && !block.rows.ours.removal ? block.rows.ours : null;
		const theirs = block.rows.theirs && !block.rows.theirs.removal ? block.rows.theirs : null;
		const words = ours && theirs ? changedWords(doc.sliceString(ours.from, ours.to), doc.sliceString(theirs.from, theirs.to)) : { old: [], new: [] };
		if (ours) {
			rows(ours, "ours", block.id);
			for (const [from, to] of words.old) items.push({ from: ours.from + from, to: ours.from + to, deco: Decoration.mark({ class: "relay-conflict-word is-del" }) });
		}
		if (theirs) {
			rows(theirs, "theirs", block.id);
			for (const [from, to] of words.new) items.push({ from: theirs.from + from, to: theirs.from + to, deco: Decoration.mark({ class: "relay-conflict-word is-add" }) });
		}
	}
	items.sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide);
	const builder = new RangeSetBuilder<Decoration>();
	for (const item of items) builder.add(item.from, item.to, item.deco);
	return builder.finish();
}
