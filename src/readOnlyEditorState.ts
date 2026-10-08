import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const accessModeCompartment = new Compartment();
const ownedEditors = new WeakMap<EditorView, Set<EditorView>>();
const editorOwners = new WeakMap<EditorView, EditorView>();

function extensions(readOnly: boolean) {
	return readOnly
		? [
				// Both facets take their highest-precedence value, and the host
				// editor declares its own ahead of plugin extensions (a nested
				// table-cell editor declares readOnly false); the read-only
				// answer has to outrank them. CodeMirror refuses input on
				// readOnly, so that is the one that keeps keystrokes out.
				Prec.highest(EditorView.editable.of(false)),
				Prec.highest(EditorState.readOnly.of(true)),
				EditorView.theme({
					".cm-cursorLayer": { display: "none" },
					".cm-content": { caretColor: "transparent" },
				}),
			]
		: [];
}

function configureOne(editor: EditorView, readOnly: boolean): void {
	const current = accessModeCompartment.get(editor.state);
	if ((Array.isArray(current) && current.length > 0) === readOnly) return;
	editor.dispatch({
		effects: accessModeCompartment.reconfigure(extensions(readOnly)),
	});
}

export function configureAccessMode(
	owner: EditorView,
	readOnly: boolean,
): void {
	configureOne(owner, readOnly);
	for (const child of ownedEditors.get(owner) ?? [])
		configureOne(child, readOnly);
}

export function registerOwnedEditor(
	owner: EditorView,
	child: EditorView,
): void {
	unregisterOwnedEditor(child);
	let children = ownedEditors.get(owner);
	if (!children) ownedEditors.set(owner, (children = new Set()));
	children.add(child);
	editorOwners.set(child, owner);
	// Runs after the current CM6 update, which may be the one registering
	// this editor. The owner is re-read because the editor may have been rebound.
	queueMicrotask(() => {
		if (editorOwners.get(child) !== owner) return;
		if (
			typeof owner.state?.facet === "function" &&
			typeof child.state?.facet === "function"
		) {
			configureOne(
				child,
				owner.state.readOnly || !owner.state.facet(EditorView.editable),
			);
		}
	});
}

export function unregisterOwnedEditor(child: EditorView): void {
	const owner = editorOwners.get(child);
	if (!owner) return;
	ownedEditors.get(owner)?.delete(child);
	editorOwners.delete(child);
}
