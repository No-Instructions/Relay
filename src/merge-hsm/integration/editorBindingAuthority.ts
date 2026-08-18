import type { EditorView } from "@codemirror/view";

export type WholeDocumentEditorKind =
	| "workspace-markdown-view"
	| "canvas-file-node";

export type EditorBindingAuthority = Readonly<{
	kind: WholeDocumentEditorKind;
	owner: object;
}>;

const authorities = new WeakMap<EditorView, EditorBindingAuthority>();

/**
 * Grant whole-document sync authority to one exact CodeMirror view.
 *
 * Callers must own a host surface whose buffer is the complete file. Merely
 * resolving the same TFile, Document, or editorInfoField is not authority:
 * fragment editors inherit those identities from their host.
 */
export function authorizeWholeDocumentEditor(
	editor: EditorView,
	owner: object,
	kind: WholeDocumentEditorKind,
): EditorBindingAuthority {
	const current = authorities.get(editor);
	if (current?.owner === owner && current.kind === kind) {
		return current;
	}

	const authority = Object.freeze({ kind, owner });
	authorities.set(editor, authority);
	return authority;
}

/** Return the positive binding authority for this exact editor, if any. */
export function editorBindingAuthority(
	editor: EditorView,
): EditorBindingAuthority | null {
	return authorities.get(editor) ?? null;
}

/**
 * Revoke an authority only when the caller still owns the current grant.
 * A stale host cannot revoke a later owner's grant for a reused editor.
 */
export function revokeWholeDocumentEditor(
	editor: EditorView,
	authority: EditorBindingAuthority,
): boolean {
	if (authorities.get(editor) !== authority) return false;
	return authorities.delete(editor);
}
