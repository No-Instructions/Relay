import { App, TFolder } from "obsidian";
import { AbstractInputSuggest } from "obsidian";
import type { SharedFolders } from "src/SharedFolder";

export class FolderSuggest extends AbstractInputSuggest<string> {
	sharedPaths: Set<string>;

	constructor(
		public app: App,
		private sharedFolders: SharedFolders,
		public inputEl: HTMLInputElement,
	) {
		super(app, inputEl);
		this.sharedPaths = new Set<string>(
			this.sharedFolders.map((folder) => folder.path),
		);
	}

	getSuggestions(inputStr: string): string[] {
		const lowerCaseInputStr = inputStr.toLowerCase();
		const folders: string[] = [];

		const getAllFoldersRecursively = (folder: TFolder) => {
			const shared = this.sharedPaths.has(folder.path);
			if (shared) {
				return;
			}
			if (folder.path.toLowerCase().contains(lowerCaseInputStr)) {
				folders.push(folder.path);
			}
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					getAllFoldersRecursively(child);
				}
			}
		};

		getAllFoldersRecursively(this.app.vault.getRoot());
		return folders;
	}

	renderSuggestion(folder: string, el: HTMLElement): void {
		el.setText(folder);
	}

	selectSuggestion(folder: string): void {
		this.inputEl.value = folder;
		this.inputEl.trigger("input");
		this.close();
	}
}
