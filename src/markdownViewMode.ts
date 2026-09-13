import type { Events, MarkdownView, MarkdownViewModeType, WorkspaceLeaf } from "obsidian";

interface ModeRequest {
	mode: MarkdownViewModeType;
	done: Promise<void>;
}

const pendingModes = new WeakMap<WorkspaceLeaf, ModeRequest>();

/** Let native navigation finish after an in-flight mode change, cancelling queued work. */
export function finishMarkdownModeChanges(view: MarkdownView): Promise<void> {
	const request = pendingModes.get(view.leaf);
	pendingModes.delete(view.leaf);
	return request?.done.catch(() => {}) ?? Promise.resolve();
}

/** Include an in-flight restoration when another document takes over the view. */
export function requestedMarkdownMode(view: MarkdownView): MarkdownViewModeType {
	return pendingModes.get(view.leaf)?.mode ?? view.getMode();
}

/** Serialize mode changes without retaining a file path across a pane switch. */
export function setMarkdownViewMode(view: MarkdownView, mode: MarkdownViewModeType): Promise<void> {
	const leaf = view.leaf;
	const previous = pendingModes.get(leaf);
	const request: ModeRequest = { mode, done: Promise.resolve() };
	request.done = (previous?.done.catch(() => {}) ?? Promise.resolve())
		.then(async () => {
			if (pendingModes.get(leaf) !== request) return;
			const currentView = leaf.view;
			if (currentView.getViewType() !== "markdown") return;
			// WorkspaceLeaf.setViewState silently drops requests while a file
			// is opening. Change only the markdown mode through the view API;
			// retaining a file in this request could reopen a departed note.
			await currentView.setState({ mode }, { history: false });
			if (leaf.view === currentView && pendingModes.get(leaf) === request) {
				(currentView.app.workspace as Events).trigger("layout-change");
				currentView.app.workspace.requestSaveLayout();
			}
		})
		.finally(() => {
			if (pendingModes.get(leaf) === request) pendingModes.delete(leaf);
		});
	pendingModes.set(leaf, request);
	return request.done;
}
