import type { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { recordHSMEntry } from "../../debug";

const objectIds = new WeakMap<object, string>();
let nextObjectId = 1;

export function diagnosticObjectId(value: object | null | undefined): string | null {
	if (!value) return null;
	let id = objectIds.get(value);
	if (!id) {
		id = `object-${nextObjectId++}`;
		objectIds.set(value, id);
	}
	return id;
}

export function recordEditorIdentity(
	editor: EditorView,
	stage: string,
	details: Record<string, unknown> = {},
): Record<string, unknown> & { editorId: string; path: string | null; length: number } {
	let path: string | null = null;
	try {
		path = editor.state.field(editorInfoField, false)?.file?.path ?? null;
	} catch {
		// Construction can precede editorInfoField installation.
	}
	const snapshot = {
		editorId: diagnosticObjectId(editor)!,
		path,
		length: editor.state.doc.length,
	};
	recordHSMEntry({
		ns: "editorIdentityDiagnostic",
		ts: new Date().toISOString(),
		event: "EDITOR_IDENTITY",
		stage,
		...snapshot,
		...details,
	});
	return { ...snapshot, ...details };
}
