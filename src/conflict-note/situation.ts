/**
 * The situation box: what happened to the note, how much is left, the
 * whole-file choices, and Done once nothing is left to decide. It sits above
 * the source view, so it stays put while the note scrolls, and folds to its
 * title line. The wording follows from the conflict's situation and the two
 * sides' sources; that mapping is the one table here and nowhere else.
 */

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import type { ConflictSituation, ConflictSource } from "../merge-hsm/conflictValue";
import { type Copy, type View, conflictField, decideAll, diffBlocks, remaining, setPreview, setReview } from "./fields";
import { type Side, isMerged } from "./pick";

/** How the conflict is shown and worded, from what it is and what its sides are. */
export function situationCopy(
	situation: ConflictSituation,
	sources: { ours: ConflictSource; theirs: ConflictSource },
	collaborator: string | null,
): { view: View; copy: Copy } {
	const pair = [sources.ours, sources.theirs].sort().join("+");
	const outside: Copy = {
		title: "This file was changed outside Obsidian",
		text: "The change doesn’t merge cleanly with your note. Review it below, then apply it or keep your note as it is.",
		ours: "Keep my note",
		theirs: "Apply changes",
	};
	if (situation === "merge-failed") {
		return {
			view: "diff",
			copy: {
				title: "Relay hit a bug merging this note",
				text: "Relay couldn’t merge this note’s changes, which should never happen. Both versions are shown below so nothing is lost. [[Send a bug report]] so we can fix it.",
				ours: "Keep my note",
				theirs: "Apply changes",
			},
		};
	}
	if (situation === "drift") {
		return {
			view: "pick",
			copy: {
				title: "Relay hit a bug while you were typing",
				text: "What you typed and Relay’s copy of this note came apart, which should never happen. Your text is shown against Relay’s copy so nothing is lost. [[Send a bug report]] so we can fix it.",
				ours: "Keep what I typed",
				theirs: "Use Relay’s copy",
			},
		};
	}
	if (situation === "no-baseline") {
		if (pair === "file+record") {
			return {
				view: "diff",
				copy: {
					...outside,
					text: "The file on disk differs from the note, and Relay has no record of the version they started from. Review the change below, then apply it or keep your note as it is.",
				},
			};
		}
		return {
			view: "pick",
			copy: {
				title: "Relay is missing a merge baseline for this note",
				text: "The local copy and the shared note have both changed, and Relay has no record of the version they started from, so it can’t merge them automatically. After you resolve these differences, Relay will keep a baseline and merge this note on its own from then on.",
				ours: "Use local copy",
				theirs: "Use remote copy",
			},
		};
	}
	if (pair === "file+record") return { view: "diff", copy: outside };
	if (pair === "file+remote") {
		return {
			view: "pick",
			copy: {
				title: "This file was edited while Relay wasn’t running",
				text: "The file on disk and the shared note both changed since Relay last saw them. Relay merged the changes that don’t overlap; where both changed the same lines, both versions are shown below.",
				ours: "Use local copy",
				theirs: "Use remote copy",
			},
		};
	}
	const who = collaborator ?? "someone else";
	return {
		view: "pick",
		copy: {
			title: `You and ${who} both changed this note since it last synced`,
			text: "Relay merged the changes that don’t overlap. Where you both changed the same lines, both versions are shown below.",
			ours: "Keep all of mine",
			theirs: collaborator ? `Use all of ${collaborator}’s` : "Use all of theirs",
		},
	};
}

const STORE = "relay-conflict-box-collapsed";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
	const e = document.createElement(tag);
	e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
};

/** The box's text, with a phrase in double square brackets as a link: the offer to send a bug report, which says so once sent. */
function linked(text: string, report: (() => void) | undefined) {
	const p = el("p", "relay-conflict-text");
	for (const part of text.split(/(\[\[[^\]]+\]\])/)) {
		if (!part.startsWith("[[")) {
			p.append(part);
			continue;
		}
		const a = el("a", "relay-conflict-link", part.slice(2, -2));
		a.setAttribute("role", "button");
		a.tabIndex = 0;
		a.addEventListener("click", () => {
			report?.();
			a.textContent = "Report sent";
			a.classList.add("is-sent");
		});
		p.append(a);
	}
	return p;
}

/** Obsidian's toggle switch with its label beside it. */
function toggle(label: string, on: boolean, onChange: (on: boolean) => void) {
	const wrap = el("label", "relay-conflict-toggle");
	const box = el("div", "checkbox-container");
	box.classList.toggle("is-enabled", on);
	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = on;
	box.append(input);
	wrap.append(box, el("span", "", label));
	input.addEventListener("change", () => {
		box.classList.toggle("is-enabled", input.checked);
		onChange(input.checked);
	});
	return wrap;
}

export const situationBox = ViewPlugin.fromClass(
	class {
		box = el("div", "relay-conflict-box");
		head = el("div", "relay-conflict-head");
		body = el("div", "relay-conflict-body");
		total = 0;
		host: HTMLElement | null = null;
		/** The last decision was a whole-file choice: that document is the answer, and Done is the next step. */
		whole: Side | null = null;
		deciding = false;
		constructor(readonly view: EditorView) {
			this.box.setAttribute("role", "status");
			const chevron = el("span", "relay-conflict-chevron");
			chevron.innerHTML =
				'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
			this.head.append(chevron, el("div", "relay-conflict-title"), el("span", "relay-conflict-status"));
			this.head.addEventListener("click", () => {
				const on = this.box.classList.toggle("is-collapsed");
				localStorage.setItem(STORE, on ? "1" : "0");
			});
			this.box.classList.toggle("is-collapsed", localStorage.getItem(STORE) === "1");
			this.box.append(this.head, this.body);
			this.render(view.state);
		}
		/** The box goes above the source view while there is a situation to show. */
		mount(on: boolean) {
			if (on === !!this.host) return;
			if (!on) {
				this.box.remove();
				this.host?.classList.remove("relay-has-conflict-box");
				this.host = null;
				return;
			}
			this.host = this.view.dom.closest<HTMLElement>(".view-content") ?? this.view.dom.parentElement;
			if (!this.host) return;
			this.host.classList.add("relay-has-conflict-box");
			this.host.prepend(this.box);
		}
		update(u: ViewUpdate) {
			const now = u.state.field(conflictField, false) ?? null;
			if (now === (u.startState.field(conflictField, false) ?? null)) return;
			// Any decision other than a whole-file choice unmarks the whole-file button.
			if (!this.deciding) this.whole = null;
			this.render(u.state);
		}
		render(state: EditorState) {
			const s = state.field(conflictField, false) ?? null;
			this.mount(!!s);
			if (!s) {
				this.total = 0;
				return;
			}
			const title = this.head.querySelector(".relay-conflict-title")!;
			const status = this.head.querySelector(".relay-conflict-status")!;
			this.body.replaceChildren();
			const diff = s.view === "diff";
			// A diff is taken whole or left: nothing has to be decided one by one, so either button finishes it.
			const left = diff ? 0 : remaining(s);
			this.total = Math.max(this.total, left);
			const settled = left === 0;
			title.textContent = s.copy.title;
			const changes = diffBlocks(s).length;
			status.textContent = diff ? `${changes} change${changes === 1 ? "" : "s"}` : `${left} of ${this.total} conflict${this.total === 1 ? "" : "s"} to resolve`;
			this.body.append(linked(s.copy.text, s.session.report));
			if (!diff) this.body.append(el("p", "relay-conflict-hint", "Choose for each conflict below, or for the whole file:"));
			const options = el("div", "relay-conflict-options");
			for (const side of ["ours", "theirs"] as const) {
				// Taking what came in is the expected answer, so until something is decided that button carries the call to action.
				const cta = side === "theirs" && !settled && s.situation !== "drift" && s.situation !== "merge-failed";
				const b = el("button", `${this.whole === side ? "is-chosen" : ""}${cta || (diff && side === "theirs") ? " mod-cta" : ""}`.trim(), s.copy[side]);
				b.type = "button";
				if (diff) {
					b.addEventListener("click", () => {
						const now = this.view.state.field(conflictField);
						if (!now) return;
						this.view.dispatch({ effects: decideAll(now, side, true) });
						now.session.done();
					});
					options.append(b);
					continue;
				}
				// A whole-file choice: that document is the answer, so it stays in view. The decision is an editor action,
				// so focus goes back to the note and undo can reach it.
				b.addEventListener("click", () => {
					const now = this.view.state.field(conflictField);
					if (!now) return;
					this.deciding = true;
					this.whole = side;
					try {
						this.view.dispatch({ effects: decideAll(now, side) });
					} finally {
						this.deciding = false;
					}
					this.view.focus();
				});
				// Hovering a whole-file button lights that side everywhere.
				b.addEventListener("pointerenter", () => this.view.dispatch({ effects: setPreview.of(side) }));
				b.addEventListener("pointerleave", () => this.view.dispatch({ effects: setPreview.of(null) }));
				options.append(b);
			}
			if (settled && !diff) {
				// Nothing left to decide: Done writes the note as decided.
				const done = el("button", "mod-cta", "Done");
				done.type = "button";
				done.addEventListener("click", () => this.view.state.field(conflictField)?.session.done());
				options.append(done);
			}
			this.body.append(options);
			// Off, a merged edit is just the note's text; on, it is a candidate like any other.
			if (!diff && s.blocks.some(isMerged)) {
				this.body.append(toggle("Review automatically merged lines", s.review, (on) => this.view.dispatch({ effects: setReview.of(on) })));
			}
		}
		destroy() {
			this.mount(false);
		}
	},
);
