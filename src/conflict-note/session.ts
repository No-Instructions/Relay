/**
 * A conflict open in one note: the pick document installed in the editor, the
 * view's saves held off while it is shown, and the way out, by Done or by the
 * conflict going away. The pick document exists only in the editor while the
 * conflict is open: it never reaches the disk or the record.
 */

import { Transaction, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkdownView } from "obsidian";
import type { MergeHSM } from "../merge-hsm/MergeHSM";
import type { BlockDecision, ConflictValue } from "../merge-hsm/conflictValue";
import { ySyncAnnotation } from "../merge-hsm/integration/annotations";
import { getPatcher } from "../Patcher";
import { curryLog } from "../debug";
import { type NoteState, conflictField, setBlock, setConflict } from "./fields";
import { type NoteBlock, buildPickDocument, decisionOf, outcomeText, wholeDecision } from "./pick";
import { situationCopy } from "./situation";

/** A view whose saves the session holds off: Obsidian's own text file view members. */
interface SavingView {
	requestSave: () => void;
	getViewData: () => string;
}

export interface SessionOptions {
	collaborator: string | null;
	/** Opens the bug report, for the situations that offer one. */
	report?: () => void;
}

/** What the debug surface reads. */
export interface SessionSnapshot {
	shown: boolean;
	conflictId: string;
	view: "pick" | "diff";
	blocks: { id: string; kind: NoteBlock["kind"]; decision: BlockDecision | null }[];
	outcome: string;
}

const log = curryLog("[ConflictNote]", "log");

export class ConflictNoteSession {
	private unpatch: (() => void) | null = null;
	/** The text the editor held before the pick document, restored when the note unloads. */
	private original: string | null = null;
	private conflictId: string;
	private closed = false;
	/** How the session ended, once it has. */
	endedBy: "done" | "close" | "unload" | "lost" | null = null;

	constructor(
		private readonly view: MarkdownView,
		private readonly cm: EditorView,
		private readonly hsm: MergeHSM,
		conflict: ConflictValue,
		private readonly options: SessionOptions,
	) {
		this.conflictId = conflict.id;
		this.install(conflict, new Map());
	}

	get shown(): boolean {
		return !this.closed && this.cm.state.field(conflictField, false) !== null && this.cm.state.field(conflictField, false)?.conflictId === this.conflictId;
	}

	/**
	 * Whether the view is this session's for the conflict it opened on: while
	 * the pick document is shown, and after Done or an unload, when the machine
	 * is still settling and no second session should open on the same conflict.
	 * A session whose layout was replaced under it leaves the view free.
	 */
	get keepsView(): boolean {
		return this.shown || (this.closed && this.endedBy !== "lost");
	}

	/** Every dispatch of the session is sync-origin and out of the editor's history. */
	private static annotations(view: EditorView) {
		return [ySyncAnnotation.of(view), Transaction.addToHistory.of(false), Transaction.remote.of(true)];
	}

	/** Build the pick document for the conflict and put it in the editor, carrying over the decisions given. */
	private install(conflict: ConflictValue, carried: ReadonlyMap<string, BlockDecision>) {
		const { view, copy } = situationCopy(conflict.situation, { ours: conflict.ours.source, theirs: conflict.theirs.source }, this.options.collaborator);
		const pick = buildPickDocument(conflict, view);
		const state: NoteState = {
			conflictId: conflict.id,
			situation: conflict.situation,
			sources: { ours: conflict.ours.source, theirs: conflict.theirs.source },
			view,
			copy,
			blocks: pick.blocks.map((b) => {
				const d = carried.get(b.id);
				return d ? { ...b, ...wholeDecision(d) } : b;
			}),
			review: false,
			session: { done: () => this.done(), lost: () => this.lost(), report: this.options.report },
		};
		const current = this.cm.state.doc.toString();
		if (this.original === null) {
			this.original = current;
			this.holdSaves();
		}
		this.cm.dispatch({
			// Keep history positions attached to surviving text in the layout.
			changes: this.hsm.computeDiffChanges(current, pick.doc),
			effects: setConflict.of(state),
			annotations: ConflictNoteSession.annotations(this.cm),
		});
		log(`${this.view.file?.path ?? "?"}: pick document shown for ${conflict.id} (${view}, ${pick.blocks.length} blocks)`);
	}

	/**
	 * Obsidian saves the editor buffer on a debounced timer after an edit, on
	 * an explicit save, and when the file unloads; each reads the view's data.
	 * While the pick document is shown, new saves are not requested, and any
	 * save that runs reads the text the editor held before.
	 */
	private holdSaves() {
		const original = () => this.original ?? "";
		this.unpatch = getPatcher().patch(this.view as unknown as SavingView, {
			requestSave() {
				return function (this: SavingView) {};
			},
			getViewData() {
				return function (this: SavingView) {
					return original();
				};
			},
		});
	}

	private releaseSaves() {
		this.unpatch?.();
		this.unpatch = null;
	}

	/** The note as decided, read from the editor. */
	outcome(): string {
		const s = this.cm.state.field(conflictField, false);
		if (!s) return this.cm.state.doc.toString();
		return outcomeText(this.cm.state.doc, s.blocks);
	}

	snapshot(): SessionSnapshot {
		const s = this.cm.state.field(conflictField, false) ?? null;
		return {
			shown: this.shown,
			conflictId: this.conflictId,
			view: s?.view ?? "pick",
			blocks: (s?.blocks ?? []).filter((b) => b.kind !== "same").map((b) => ({ id: b.id, kind: b.kind, decision: decisionOf(b) })),
			outcome: this.outcome(),
		};
	}

	/** A decision by id, as the debug surface makes it; `blockId` may be any prefix that names one block. */
	decide(blockId: string, decision: BlockDecision) {
		const s = this.cm.state.field(conflictField, false);
		if (!s) throw new Error("no conflict is shown in the note");
		const matches = s.blocks.filter((b) => b.kind !== "same" && b.id.startsWith(blockId));
		if (matches.length !== 1) throw new Error(`${JSON.stringify(blockId)} names ${matches.length} blocks`);
		this.cm.dispatch({ effects: setBlock.of({ id: matches[0].id, patch: wholeDecision(decision) }) });
	}

	/**
	 * Done: the outcome replaces the pick document in the editor, saves are
	 * let through again, and the machine is told. The editor then holds the
	 * outcome as any edit, and Obsidian saves it as it saves any edit. A
	 * conflict the machine no longer holds is refused: the note is rebuilt
	 * from the conflict it holds now, keeping the decisions whose blocks survive.
	 */
	done() {
		if (this.closed) return;
		const s = this.cm.state.field(conflictField, false);
		if (!s) return;
		const text = this.outcome();
		const decisions = new Map<string, BlockDecision>();
		for (const b of s.blocks) {
			const d = decisionOf(b);
			if (d && b.kind !== "same") decisions.set(b.id, d);
		}
		const current = this.hsm.getConflict();
		if (!current || current.id !== this.conflictId) {
			if (!current) {
				log(`${this.view.file?.path ?? "?"}: the conflict is gone; leaving the note as the machine has it`);
				this.close();
				return;
			}
			log(`${this.view.file?.path ?? "?"}: conflict ${this.conflictId} is stale, rebuilding from ${current.id}`);
			this.conflictId = current.id;
			this.install(current, decisions);
			return;
		}
		this.endedBy = "done";
		this.leave(text);
		void this.hsm.resolveConflict(current.id, text).catch((error: unknown) => {
			log(`${this.view.file?.path ?? "?"}: resolve refused: ${error instanceof Error ? error.message : String(error)}`);
			// The conflict is still held: the view is free for a session on it.
			this.endedBy = "lost";
		});
	}

	/**
	 * Something other than the session replaced the document: the layout is
	 * gone, so the session ends and the editor keeps what it was given.
	 */
	private lost() {
		if (this.closed) return;
		log(`${this.view.file?.path ?? "?"}: the document was replaced under the conflict`);
		this.endedBy = "lost";
		this.closed = true;
		this.releaseSaves();
		if (sessions.get(this.view) === this) sessions.delete(this.view);
	}

	/**
	 * The conflict went away without Done: the note takes the text the machine
	 * has for it, so the editor and the record agree again.
	 */
	close() {
		if (this.closed) return;
		this.endedBy = "close";
		const text = this.hsm.getLocalDoc()?.getText("contents").toString() ?? this.original ?? this.cm.state.doc.toString();
		this.leave(text);
	}

	/**
	 * The note is unloading: the editor gets back the text it held before the
	 * pick document, so what Obsidian saves and what the machine captures is
	 * that text, and the conflict stays held for the next open.
	 */
	restoreForUnload() {
		if (this.closed) return;
		this.endedBy = "unload";
		this.leave(this.original ?? this.cm.state.doc.toString());
	}

	/** Put `text` in the editor as an ordinary document, saves allowed, and end the session. */
	private leave(text: string) {
		this.closed = true;
		this.releaseSaves();
		const current = this.cm.state.doc.toString();
		const shown = this.cm.state.field(conflictField, false) !== null;
		// A change of text is an editor change like any other: Obsidian asks for a save as it does for every edit.
		if (current !== text || shown) {
			this.cm.dispatch({
				// Undo of an edit within a kept row must still target that row.
				changes: this.hsm.computeDiffChanges(current, text),
				effects: setConflict.of(null),
				annotations: ConflictNoteSession.annotations(this.cm),
			});
		}
	}

	/** Whether the document the session laid out is still the one in the editor. */
	static holds(state: EditorState, conflictId: string): boolean {
		return state.field(conflictField, false)?.conflictId === conflictId;
	}
}

/** The open sessions, by view, so the unload hook can restore a note before Obsidian reads it. */
const sessions = new WeakMap<MarkdownView, ConflictNoteSession>();

export function sessionOf(view: MarkdownView): ConflictNoteSession | undefined {
	return sessions.get(view);
}

export function openSession(view: MarkdownView, cm: EditorView, hsm: MergeHSM, conflict: ConflictValue, options: SessionOptions): ConflictNoteSession {
	sessions.get(view)?.close();
	const session = new ConflictNoteSession(view, cm, hsm, conflict, options);
	sessions.set(view, session);
	return session;
}

export function closeSession(view: MarkdownView) {
	const session = sessions.get(view);
	if (!session) return;
	sessions.delete(view);
	session.close();
}

/** Before Obsidian saves and Relay captures an unloading note, give it back its text. */
export function restoreBeforeUnload(view: MarkdownView) {
	const session = sessions.get(view);
	if (!session) return;
	sessions.delete(view);
	session.restoreForUnload();
}
