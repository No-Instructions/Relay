/**
 * A conflict resolved inside the note, in Obsidian's own editor. The editor
 * extension carries the state, the tints, the pills and the situation box; a
 * session per view installs the pick document and takes it out again.
 */

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { conflictField, conflictHistory, hoverField, previewField, setConflict } from "./fields";
import { rendering } from "./render";
import { situationBox } from "./situation";
import { sessionOfEditor } from "./session";

export { ConflictNoteSession, closeSession, openSession, restoreBeforeUnload, sessionOf } from "./session";
export type { SessionSnapshot } from "./session";

/** A conflict dropped by a change the session did not make tells the session so. */
const lostWatch = EditorView.updateListener.of((u) => {
	const before = u.startState.field(conflictField, false);
	const after = u.state.field(conflictField, false);
	if (after && u.docChanged) after.session.changed?.(u.state.doc);
	if (!before) {
		if (!after && u.docChanged) {
			sessionOfEditor(u.view)?.updateAfterRebuild(u.startState.doc, u.state.doc, u.transactions.some((tr) => tr.isUserEvent("set")));
		}
		return;
	}
	if (after) return;
	if (u.transactions.some((tr) => tr.effects.some((e) => e.is(setConflict)))) return;
	// A host population supplies the note's baseline; an ordinary edit may
	// still contain the temporary pick layout and must not become save data.
	before.session.lost(u.transactions.some((tr) => tr.isUserEvent("set")) ? u.state.doc : undefined);
});

/** The editor extension: joins the extensions every live editor gets. */
export const conflictNoteExtension: Extension = [conflictField, hoverField, previewField, conflictHistory, rendering, situationBox, lostWatch];
