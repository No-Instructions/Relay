import { App, SuggestModal, TFolder, type Instruction } from "obsidian";
import type { SharedFolders } from "src/SharedFolder";
import FolderSuggestion from "../components/FolderSuggestion.svelte";

interface Suggestion {
	folder: string;
	exists: boolean;
	shared: boolean;
}

export class FolderSuggestModal extends SuggestModal<Suggestion> {
	sharedPaths: Set<string>;
	hasRemotes: Set<string>;
	components: FolderSuggestion[] = [];
	constructor(
		app: App,
		private sharedFolders: SharedFolders,
		public onChoose: (folder: string) => void
	) {
		super(app);
		this.sharedPaths = new Set<string>(
			this.sharedFolders.map((folder) => folder.path)
		);
		this.hasRemotes = new Set<string>(
			this.sharedFolders
				.filter((folder) => folder.remote !== undefined)
				.map((folder) => folder.path)
		);
		this.setInstructions([
			{
				command: "↑/↓",
				purpose: "Navigate",
			},
			{
				command: "Enter",
				purpose: "Choose and share folder",
			},
			{
				command: "Esc",
				purpose: "Cancel",
			},
		]);
	}

	sortFn(a: Suggestion, b: Suggestion): number {
		// Always put current input first
		if (a.exists && !b.exists) {
			return -1;
		}
		if (!a.exists && b.exists) {
			return 1;
		}
		// Then put shared folders first
		if (a.shared && !b.shared) {
			return -1;
		}
		if (b.shared && !a.shared) {
			return 1;
		}
		// Then sort by name
		return a.folder.localeCompare(b.folder);
	}

	onClose() {
		super.onClose();
		this.components.forEach((component) => {
			component.$destroy();
		});
	}

	getSuggestions(inputStr: string): Suggestion[] {
		this.components.forEach((component) => {
			component.$destroy();
		});
		const lowerCaseInputStr = inputStr.toLowerCase();
		const folders: Suggestion[] = [];
		const exists = this.app.vault.getAbstractFileByPath(inputStr) !== null;
		if (inputStr.length > 0 && !exists) {
			folders.push({
				folder: inputStr,
				exists: false,
				shared: false,
			});
		}

		const getAllFoldersRecursively = (folder: TFolder) => {
			const shared = this.sharedPaths.has(folder.path);
			const hasRemote = this.hasRemotes.has(folder.path);
			if (
				folder.path.toLowerCase().contains(lowerCaseInputStr) &&
				folder.path.length > 1 &&
				!hasRemote
			) {
				folders.push({
					folder: folder.path,
					exists: true,
					shared: shared,
				});
			}
			if (shared) {
				// We can't share a subfolder of an existing shared folder
				return;
			}
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					getAllFoldersRecursively(child);
				}
			}
		};

		getAllFoldersRecursively(this.app.vault.getRoot());
		return folders.sort(this.sortFn);
	}

	renderSuggestion(suggestion: Suggestion, el: HTMLElement): void {
		el.addClass("mod-complex");
		const component = new FolderSuggestion({
			target: el,
			props: {
				suggestion,
			},
		});
		this.components.push(component);
	}

	onChooseSuggestion(item: Suggestion, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(item.folder);
	}
}
