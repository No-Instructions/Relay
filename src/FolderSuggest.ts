import { App, TFolder } from "obsidian";
import { AbstractInputSuggest } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(public inputEl: HTMLInputElement, public app: App) {
		super(app, inputEl);
	}

	getSuggestions(inputStr: string): TFolder[] {
		const lowerCaseInputStr = inputStr.toLowerCase();
		const folders: TFolder[] = [];

		const getAllFoldersRecursively = (folder: TFolder) => {
			if (folder.path.toLowerCase().contains(lowerCaseInputStr)) {
				folders.push(folder);
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

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.inputEl.trigger("input");
		this.close();
	}
}
