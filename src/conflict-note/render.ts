/**
 * How the conflict shows in the note. In the pick view a candidate's rows
 * wear their side's tint, the hovered candidate lifts, the unchosen dims, and
 * a pill floats beside the rows with the mark of what taking them does.
 * Clicking a candidate chooses it, shift-click takes both, and clicking the
 * sole chosen candidate again takes neither. In the diff view the rows that
 * would go are red and the rows that would come are green, with the words
 * that differ marked in both, and nothing answers the pointer.
 *
 * Nothing is added to any line's text: the rows are the document's own lines,
 * and the rows not in play are folded out of sight.
 */

import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
	type Candidate,
	type NoteBlock,
	type Side,
	clickDecision,
	editingSide,
	isEitherOr,
	isIn,
	isMerged,
	leavesAsWas,
	otherSide,
	removes,
	sameDecision,
} from "./pick";
import { type Hover, type NoteState, conflictField, hoverField, previewField, sameHover, setBlock, setHover, showsMerged } from "./fields";
import { changedWords } from "./words";

/** The rows of a block that stand as candidates: both of a disagreement, both of a merged edit under review. */
export function candidates(b: NoteBlock, s: NoteState): { side: Side; rows: Candidate }[] {
	if (s.view === "diff") return [];
	if (isMerged(b) && !showsMerged(s, b)) return [];
	const out: { side: Side; rows: Candidate }[] = [];
	for (const side of ["ours", "theirs"] as const) {
		const rows = b.rows[side];
		if (rows) out.push({ side, rows });
	}
	return out;
}

/**
 * The rows folded out of sight. A merged edit not under review shows only
 * what it did: not the lines as they were, and not a removal. A diff shows
 * the note's lines and the change's lines, so a removal, which is lines of
 * neither, is folded, as is the second row of the note's own edits.
 */
function hiddenRows(b: NoteBlock, s: NoteState): Candidate[] {
	const editor = editingSide(b);
	const out: Candidate[] = [];
	for (const side of ["ours", "theirs"] as const) {
		const rows = b.rows[side];
		if (!rows) continue;
		if (s.view === "diff") {
			if (rows.removal || (b.kind === "ours-only" && side === "theirs")) out.push(rows);
		} else if (editor && !showsMerged(s, b)) {
			if (rows.removal || side !== editor) out.push(rows);
		}
	}
	return out;
}

type Item = { from: number; to: number; deco: Decoration };

function eachLine(doc: EditorState["doc"], rows: Candidate, f: (from: number, to: number) => void) {
	for (let pos = rows.from; ; ) {
		const line = doc.lineAt(pos);
		f(line.from, line.to);
		if (line.to >= rows.to) break;
		pos = line.to + 1;
	}
}

const decorations = (state: EditorState): DecorationSet => {
	const s = state.field(conflictField);
	const hover = state.field(hoverField);
	const preview = state.field(previewField);
	const builder = new RangeSetBuilder<Decoration>();
	if (!s) return builder.finish();
	const doc = state.doc;
	const items: Item[] = [];
	for (const b of s.blocks) {
		for (const rows of hiddenRows(b, s)) {
			items.push({ from: doc.lineAt(rows.from).from, to: rows.to, deco: Decoration.replace({ block: true }) });
		}
		if (s.view === "diff") {
			diffRows(b, s, doc, items);
			continue;
		}
		const editor = editingSide(b);
		for (const c of candidates(b, s)) {
			// A whole-file preview lights one side everywhere and greys the other, as the click would leave them; it leaves merged edits alone.
			const lit = (!!hover && hover.id === b.id && hover.side === c.side) || (preview !== null && preview === c.side && !editor);
			const fade = preview !== null && (preview !== c.side || !!editor);
			const out = b.resolved && !b.take[c.side] && !lit;
			// A deletion is red whoever made it, and reaches toward the side that made it. The lines as they were before a
			// merged edit are nobody's change: neutral, reaching toward neither side.
			const reach = editor ?? c.side;
			const tone = c.rows.removal ? "is-removal" : leavesAsWas(b, c.side) ? "is-neutral" : "";
			const cls = `relay-conflict-line is-candidate is-${reach} ${tone}${lit ? " is-lit" : ""}${out ? " is-out" : ""}${fade ? " is-fade" : ""}${isIn(b, c.side) ? " is-in" : ""}`;
			eachLine(doc, c.rows, (from) => {
				items.push({ from, to: from, deco: Decoration.line({ class: cls, attributes: { "data-relay-conflict-side": c.side, "data-relay-conflict-block": b.id } }) });
			});
		}
	}
	items.sort((a, z) => a.from - z.from || a.deco.startSide - z.deco.startSide);
	for (const it of items) builder.add(it.from, it.to, it.deco);
	return builder.finish();
};

/** A change as a pull request shows it: the note's lines that would go red, the change's lines that would come green. */
function diffRows(b: NoteBlock, s: NoteState, doc: EditorState["doc"], items: Item[]) {
	if (b.kind === "same" || b.kind === "ours-only") return;
	const ours = b.rows.ours && !b.rows.ours.removal ? b.rows.ours : null;
	const theirs = b.rows.theirs && !b.rows.theirs.removal ? b.rows.theirs : null;
	const words = ours && theirs ? changedWords(doc.sliceString(ours.from, ours.to), doc.sliceString(theirs.from, theirs.to)) : { old: [], new: [] };
	if (ours) {
		eachLine(doc, ours, (from) => items.push({ from, to: from, deco: Decoration.line({ class: "relay-conflict-line relay-conflict-diff is-del", attributes: { "data-relay-conflict-side": "ours", "data-relay-conflict-block": b.id } }) }));
		for (const [f, t] of words.old) items.push({ from: ours.from + f, to: ours.from + t, deco: Decoration.mark({ class: "relay-conflict-word is-del" }) });
	}
	if (theirs) {
		eachLine(doc, theirs, (from) => items.push({ from, to: from, deco: Decoration.line({ class: "relay-conflict-line relay-conflict-diff is-add", attributes: { "data-relay-conflict-side": "theirs", "data-relay-conflict-block": b.id } }) }));
		for (const [f, t] of words.new) items.push({ from: theirs.from + f, to: theirs.from + t, deco: Decoration.mark({ class: "relay-conflict-word is-add" }) });
	}
}

const el = (cls: string, text = "") => {
	const e = document.createElement("div");
	e.className = cls;
	e.textContent = text;
	return e;
};

// The mark on a candidate is a plus where taking it puts lines in the note, a minus where taking it is a deletion,
// and a back arrow where taking it undoes a merged edit: the lines as they were. The note already holds every
// merged edit, whichever side made it, so going back is the same act for both.
const SIGN = (path: string) =>
	`<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const PLUS = SIGN('<path d="M5 12h14"/><path d="M12 5v14"/>');
const MINUS = SIGN('<path d="M5 12h14"/>');
const BACK = SIGN('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>');
const signFor = (b: NoteBlock, side: Side) => (leavesAsWas(b, side) ? BACK : removes(b, side) ? MINUS : PLUS);

interface Pill {
	near: Side;
	tone: Side | "neutral";
	solid: boolean;
	far: boolean;
	plus: Side | null;
}

/** What shows beside a block, for its decision and the pointer. */
function pillState(b: NoteBlock, hover: Hover | null, s: NoteState): Pill | null {
	if (!candidates(b, s).length) return null;
	// A merged edit's pill wears the editing side's colour on what the edit did, and no side's colour on the lines as they were.
	const tone = (near: Side): Side | "neutral" => (leavesAsWas(b, near) ? "neutral" : (editingSide(b) ?? near));
	const hovered = hover && hover.id === b.id ? hover.side : null;
	const only = (c: Side) => b.resolved && b.take[c] && !b.take[otherSide(c)];
	if (b.resolved && b.take.ours && b.take.theirs) return { near: "ours", tone: "ours", solid: true, far: true, plus: null };
	// Once one candidate is chosen, its mark stays put and the plus for "also take the other" hangs off it, there to be
	// clicked whether or not the pointer is on the block. Before that, the pointer only previews a mark on the candidate
	// under it. In a choice of exactly one there is nothing to take as well, so no plus.
	const pair = !isEitherOr(b);
	if (only("ours")) return { near: "ours", tone: tone("ours"), solid: true, far: false, plus: pair ? "theirs" : null };
	if (only("theirs")) return { near: "theirs", tone: tone("theirs"), solid: true, far: false, plus: pair ? "ours" : null };
	if (hovered) return { near: hovered, tone: tone(hovered), solid: false, far: false, plus: null };
	return null;
}

interface Place {
	b: NoteBlock;
	top: number;
	left: number;
	state: Pill;
	to?: number;
}

/** The floating pills, one per block in play, placed beside the rows of the candidate they mark. */
const pills = ViewPlugin.fromClass(
	class {
		layer: HTMLElement;
		pills = new Map<string, HTMLElement>();
		constructor(readonly view: EditorView) {
			this.layer = el("relay-conflict-marks");
			view.scrollDOM.append(this.layer);
			this.schedule();
		}
		update(u: ViewUpdate) {
			if (
				u.docChanged ||
				u.viewportChanged ||
				u.geometryChanged ||
				u.state.field(conflictField) !== u.startState.field(conflictField) ||
				!sameHover(u.state.field(hoverField), u.startState.field(hoverField))
			) {
				this.schedule();
			}
		}
		schedule() {
			this.view.requestMeasure({ read: () => this.measure(), write: (places) => this.place(places) });
		}
		measure(): Place[] {
			const s = this.view.state.field(conflictField);
			const hover = this.view.state.field(hoverField);
			const out: Place[] = [];
			if (!s) return out;
			const content = this.view.contentDOM.getBoundingClientRect();
			const scroller = this.view.scrollDOM.getBoundingClientRect();
			const scrollTop = this.view.scrollDOM.scrollTop;
			const offset = { top: content.top - scroller.top + scrollTop, left: content.left - scroller.left + this.view.scrollDOM.scrollLeft };
			// A candidate's extent comes from its own line elements, so the pill sits at the middle of its rows.
			const lineEl = (pos: number) => {
				try {
					const n = this.view.domAtPos(pos).node;
					const e = (n.nodeType === 3 ? n.parentElement : (n as Element))?.closest(".cm-line");
					return e && e.closest(".cm-content") === this.view.contentDOM ? e : null;
				} catch {
					return null;
				}
			};
			const mid = (r: Candidate | null) => {
				if (!r) return null;
				const a = lineEl(r.from);
				const z = lineEl(r.to);
				if (a && z) return (a.getBoundingClientRect().top + z.getBoundingClientRect().bottom) / 2 - scroller.top + scrollTop;
				const first = this.view.lineBlockAt(r.from);
				const last = this.view.lineBlockAt(r.to);
				return (first.top + last.bottom) / 2 + offset.top;
			};
			for (const b of s.blocks) {
				const state = pillState(b, hover, s);
				if (!state) continue;
				const nearMid = mid(b.rows[state.near]) ?? mid(b.rows[otherSide(state.near)]) ?? this.view.lineBlockAt(b.from).top + offset.top;
				// The mark sits at its candidate's centre; the pill stretches to the other candidate's centre only while the plus or the far mark is out.
				const otherMid = state.plus || state.far ? mid(b.rows[otherSide(state.near)]) : null;
				out.push({ b, top: nearMid, left: offset.left, state, to: otherMid ?? undefined });
			}
			return out;
		}
		place(places: Place[]) {
			const seen = new Set<string>();
			for (const p of places) {
				seen.add(p.b.id);
				let pill = this.pills.get(p.b.id);
				if (!pill) {
					pill = el("relay-conflict-pill");
					this.layer.append(pill);
					this.pills.set(p.b.id, pill);
					this.wire(pill, p.b.id);
				}
				const { near, tone, solid, far, plus } = p.state;
				pill.className = `relay-conflict-pill is-${tone}${solid ? " is-solid" : ""}${far ? " is-both" : ""}`;
				pill.replaceChildren();
				const mark = el("relay-conflict-pill-mark");
				mark.innerHTML = signFor(p.b, near);
				mark.dataset.side = near;
				pill.append(mark);
				if (far) {
					const f = el("relay-conflict-pill-mark is-far");
					f.innerHTML = signFor(p.b, "theirs");
					f.dataset.side = "theirs";
					pill.append(f);
				} else if (plus) {
					const pl = el(`relay-conflict-pill-plus is-${plus}`, "+");
					pl.dataset.side = plus;
					pl.setAttribute("aria-label", plus === "ours" ? "Also take mine" : "Also take theirs");
					pill.append(pl);
				}
				pill.style.left = `${p.left - 26}px`;
				// Laid from the near candidate's centre to the other's, or collapsed to the mark alone.
				const top = p.to === undefined ? p.top : Math.min(p.top, p.to);
				const bottom = p.to === undefined ? p.top : Math.max(p.top, p.to);
				pill.style.top = `${top - 9}px`;
				pill.style.height = `${bottom - top + 18}px`;
				// The mark is at the near end: below the plus when the near candidate is the lower one.
				pill.classList.toggle("is-reversed", p.to !== undefined && p.to < p.top);
			}
			for (const [id, pill] of this.pills) {
				if (!seen.has(id)) {
					pill.remove();
					this.pills.delete(id);
				}
			}
		}
		wire(pill: HTMLElement, id: string) {
			pill.addEventListener("mousedown", (e) => e.preventDefault());
			pill.addEventListener("click", (e) => {
				const target = (e.target as HTMLElement).closest<HTMLElement>("[data-side]");
				const s = this.view.state.field(conflictField);
				const b = s?.blocks.find((x) => x.id === id);
				if (!target || !b) return;
				const side = target.dataset.side as Side;
				// The plus adds the other candidate; a mark on a lone candidate toggles it; a mark in a "both" pill drops that one.
				const both = b.resolved && b.take.ours && b.take.theirs;
				const decision = target.classList.contains("relay-conflict-pill-plus")
					? { resolved: true, take: { ours: true, theirs: true } }
					: both
						? { resolved: true, take: { ours: side !== "ours", theirs: side !== "theirs" } }
						: clickDecision(b, side, false);
				if (!sameDecision(b, decision)) this.view.dispatch({ effects: setBlock.of({ id, patch: decision }) });
				e.stopPropagation();
			});
			pill.addEventListener("pointerenter", () => {
				const mark = pill.querySelector<HTMLElement>(".relay-conflict-pill-mark");
				this.hover(mark ? { id, side: mark.dataset.side as Side } : null);
			});
			pill.addEventListener("pointerleave", () => scheduleClear(this.view));
		}
		hover(h: Hover | null) {
			cancelClear(this.view);
			if (!sameHover(h, this.view.state.field(hoverField))) this.view.dispatch({ effects: setHover.of(h) });
		}
		destroy() {
			cancelClear(this.view);
			this.layer.remove();
		}
	},
);

/** Which candidate the pointer is on, if any. */
export function candidateAt(view: EditorView, e: MouseEvent): Hover | null {
	const s = view.state.field(conflictField);
	if (!s || s.view === "diff") return null;
	const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
	if (pos === null) return null;
	const line = view.state.doc.lineAt(pos);
	// The nearest position is not enough: the pointer has to be on the line itself, not below the note or beside it.
	const content = view.contentDOM.getBoundingClientRect();
	const block = view.lineBlockAt(line.from);
	if (e.clientX < content.left || e.clientX > content.right || e.clientY < content.top + block.top || e.clientY > content.top + block.top + block.height) return null;
	for (const b of s.blocks) {
		for (const c of candidates(b, s)) {
			if (line.from >= c.rows.from && line.from <= c.rows.to) return { id: b.id, side: c.side };
		}
	}
	return null;
}

// The hover outlives the pointer by a moment when it leaves the text, so a move across the gap to the pill keeps the pill there.
const pendingClear = new WeakMap<EditorView, number>();
const windowOf = (view: EditorView) => view.dom.ownerDocument.defaultView ?? window;
function scheduleClear(view: EditorView) {
	cancelClear(view);
	pendingClear.set(
		view,
		windowOf(view).setTimeout(() => {
			pendingClear.delete(view);
			if (view.state.field(hoverField)) view.dispatch({ effects: setHover.of(null) });
		}, 220),
	);
}
function cancelClear(view: EditorView) {
	const t = pendingClear.get(view);
	if (t !== undefined) {
		windowOf(view).clearTimeout(t);
		pendingClear.delete(view);
	}
}

const pointer = EditorView.domEventHandlers({
	mousemove(e, view) {
		if (!view.state.field(conflictField)) return false;
		// The lit candidate is the one under the pointer, nothing held over from where the pointer was.
		const h = candidateAt(view, e);
		if (h) cancelClear(view);
		// Off every candidate but heading for the pills at the left: keep the hover a moment longer.
		if (!h && view.state.field(hoverField) && e.clientX < view.contentDOM.getBoundingClientRect().left + 8) {
			scheduleClear(view);
			return false;
		}
		if (!sameHover(h, view.state.field(hoverField))) view.dispatch({ effects: setHover.of(h) });
		return false;
	},
	mouseleave(_e, view) {
		if (view.state.field(hoverField)) scheduleClear(view);
		return false;
	},
	mousedown(e, view) {
		if (e.button !== 0) return false;
		const h = candidateAt(view, e);
		if (!h) return false;
		const s = view.state.field(conflictField)!;
		const b = s.blocks.find((x) => x.id === h.id)!;
		// A pick is an editor action: keyboard undo should reach it afterwards.
		view.focus();
		const decision = clickDecision(b, h.side, e.shiftKey);
		if (!sameDecision(b, decision)) view.dispatch({ effects: setBlock.of({ id: b.id, patch: decision }) });
		e.preventDefault();
		return true;
	},
});

/** The tints, the folded rows, the pills and the pointer handling. */
export const rendering = [EditorView.decorations.compute([conflictField, hoverField, previewField], decorations), pills, pointer];
