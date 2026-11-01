import { EditorView } from "@codemirror/view";
import type { MarkdownView } from "obsidian";

/** A temporary document shown in a note's editor, separate from its saved text. */
export interface NoteEditorSession {
	liveText(): string;
	restoreForUnload(): void;
	editorUpdated(): void;
}

const active = new Set<NoteEditorSession>();
const views = new WeakMap<MarkdownView, NoteEditorSession>();
const editors = new WeakMap<EditorView, NoteEditorSession>();

export function sessionOf(view: MarkdownView): NoteEditorSession | undefined { return views.get(view); }
export function sessionOfEditor(editor: EditorView): NoteEditorSession | undefined { return editors.get(editor); }

/** Register ownership before installing a temporary document in the editor. */
export function ownEditorSession(view: MarkdownView, editor: EditorView, session: NoteEditorSession): () => void {
	views.get(view)?.restoreForUnload();
	active.add(session);
	views.set(view, session);
	editors.set(editor, session);
	return () => {
		active.delete(session);
		if (views.get(view) === session) views.delete(view);
		if (editors.get(editor) === session) editors.delete(editor);
	};
}

/** Restore the live note before native saving or Relay captures an unloading editor. */
export function restoreBeforeUnload(view: MarkdownView): void { views.get(view)?.restoreForUnload(); }

/** The merge engine reads the live note even while its editor shows a comparison. */
export function liveEditorText(editor: EditorView): string {
	return editors.get(editor)?.liveText() ?? editor.state.doc.toString();
}

/** Restore all temporary documents before plugin hooks and extensions unload. */
export function restoreEditorSessions(): void {
	for (const session of [...active]) session.restoreForUnload();
}

/** Host reconfiguration can remove per-session compartments without unloading the note. */
export const noteEditorSessionExtension = EditorView.updateListener.of(update => {
	editors.get(update.view)?.editorUpdated();
});
