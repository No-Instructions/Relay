import { App, TFolder } from "obsidian";
import { AbstractInputSuggest } from "obsidian";
import type { SharedFolders } from "src/SharedFolder";

export class FolderSuggest extends AbstractInputSuggest<string> {
	sharedPathsWithRelay: Set<string>;

	constructor(
		public app: App,
		private sharedFolders: SharedFolders,
		public inputEl: HTMLInputElement,
	) {
		super(app, inputEl);
		this.sharedPathsWithRelay = new Set<string>(
			this.sharedFolders
				.filter((folder) => !!folder.relayId)
				.map((folder) => folder.path),
		);
	}

	getSuggestions(inputStr: string): string[] {
		const lowerCaseInputStr = inputStr.toLowerCase();
		const folders: string[] = [];

		const getAllFoldersRecursively = (folder: TFolder) => {
			const sharedWithRelay = this.sharedPathsWithRelay.has(folder.path);
			if (sharedWithRelay) {
				return;
			}
			// Exclude root folder (empty path, "/", or ".")
			if (folder.path !== "" && 
				folder.path !== "/" && 
				folder.path !== "." &&
				folder.path.toLowerCase().contains(lowerCaseInputStr)) {
				folders.push(folder.path);
			}
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					getAllFoldersRecursively(child);
				}
			}
		};

		getAllFoldersRecursively(this.app.vault.getRoot());
		
		// Filter out any remaining root-like paths
		const existingFolders = folders.filter(path => 
			path !== "" && 
			path !== "/" && 
			path !== "." &&
			path.trim().length > 0
		);
		
		// If user typed something and it's not an exact match, add create option
		const userInput = inputStr.trim();
		if (userInput && !existingFolders.includes(userInput)) {
			// Add create option at the beginning
			return [`[Create] ${userInput}`, ...existingFolders];
		}
		
		return existingFolders;
	}

	renderSuggestion(folder: string, el: HTMLElement): void {
		if (folder.startsWith("[Create] ")) {
			const folderName = folder.substring(9);
			el.createEl("span", { text: "Create: ", cls: "suggestion-prefix" });
			el.createEl("span", { text: folderName, cls: "suggestion-content" });
			el.style.fontStyle = "italic";
			el.style.color = "var(--text-muted)";
		} else {
			el.setText(folder);
		}
	}

	selectSuggestion(folder: string): void {
		// If it's a create option, extract the actual folder name
		if (folder.startsWith("[Create] ")) {
			const folderName = folder.substring(9);
			this.inputEl.value = folderName;
		} else {
			this.inputEl.value = folder;
		}
		this.inputEl.trigger("input");
		this.close();
	}
}
