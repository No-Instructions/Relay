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

export { ConflictNoteSession, closeSession, openSession, restoreBeforeUnload, sessionOf } from "./session";
export type { SessionSnapshot } from "./session";

/** A conflict dropped by a change the session did not make tells the session so. */
const lostWatch = EditorView.updateListener.of((u) => {
	const before = u.startState.field(conflictField, false);
	if (!before || u.state.field(conflictField, false)) return;
	if (u.transactions.some((tr) => tr.effects.some((e) => e.is(setConflict)))) return;
	before.session.lost();
});

/** The editor extension: joins the extensions every live editor gets. */
export const conflictNoteExtension: Extension = [conflictField, hoverField, previewField, conflictHistory, rendering, situationBox, lostWatch];
