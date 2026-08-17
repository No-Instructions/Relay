/**
 * Name the kind of embedded sub-editor an editor is, or null if it is not
 * recognizable as one. A sub-editor is an editor opened over a fragment of a
 * file some other view already owns; binding one to the merge machinery
 * renders the whole document into the fragment's buffer, which the spawner
 * then persists into the fragment's span of the note.
 *
 * Two spawners are known:
 *
 * - Live Preview's table widget mounts a per-cell editor inside a
 *   `.table-cell-wrapper` element. The wrapper is only observable once the
 *   editor's DOM is attached, so a null answer means "not detected", never
 *   "proven to be a view's own editor".
 * - Editable embeds scoped by a subpath — the footnotes pane's per-footnote
 *   embeds (`#[^1]`), heading and block embeds — put the embed itself in
 *   editorInfoField, so its `file` matches the note and every identity check
 *   passes. The subpath is set at embed construction, so this arm answers
 *   even while the editor's DOM is detached. Whole-file editable embeds
 *   (canvas file nodes) carry no subpath and are not sub-editors.
 */
export function subEditorKind(
	info: { subpath?: string } | null | undefined,
	dom: { closest(selector: string): unknown },
): string | null {
	if (info?.subpath) return "a subpath-scoped embed editor";
	if (dom.closest(".table-cell-wrapper")) return "an embedded table-cell editor";

	return null;
}
