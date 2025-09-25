import { App } from "obsidian";
import FolderSuggest from "../components/FolderSuggest.svelte";
import { GenericSuggestModal } from "./GenericSuggestModal";

export class FolderSuggestModal extends GenericSuggestModal<string> {
	constructor(
		app: App,
		placeholder: string = "Choose or create folder...",
		blockedPaths: Set<string> = new Set(),
		onSelect: (folderPath: string) => void,
	) {
		super(
			app,
			FolderSuggest,
			{
				app,
				placeholder,
				blockedPaths,
			},
			onSelect,
		);
	}
}
