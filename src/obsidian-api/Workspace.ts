import { Workspace, MarkdownView } from "obsidian";

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

	public updateOptions() {
		this.workspace.updateOptions();
	}
}
