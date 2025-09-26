import { App } from "obsidian";
import FolderSuggest from "../components/FolderSuggest.svelte";
import { GenericSuggestModal } from "./GenericSuggestModal";
import type { SharedFolders } from "../SharedFolder";

export class FolderSuggestModal extends GenericSuggestModal<string> {
	constructor(
		app: App,
		placeholder: string = "Choose or create folder...",
		blockedPaths: Set<string> = new Set(),
		sharedFolders: SharedFolders,
		onSelect: (folderPath: string) => void,
	) {
		super(
			app,
			FolderSuggest,
			{
				app,
				placeholder,
				blockedPaths,
				sharedFolders,
			},
			onSelect,
		);
	}
}
