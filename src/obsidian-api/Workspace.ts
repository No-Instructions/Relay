import { Workspace, MarkdownView, type Constructor, View } from "obsidian";

export class WorkspaceFacade {
	workspace: Workspace;

	constructor(workspace: Workspace) {
		this.workspace = workspace;
	}

	public iterateMarkdownViews(fn: (leaf: MarkdownView) => void) {
		this.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				fn(leaf.view);
			}
		});
	}

	public getActiveViewOfType<T extends View>(type: Constructor<T>): T | null {
		return this.workspace.getActiveViewOfType<T>(type);
	}

	public updateOptions() {
		this.workspace.updateOptions();
	}
}
