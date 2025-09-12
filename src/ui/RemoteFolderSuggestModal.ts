import { App } from "obsidian";
import type { RemoteSharedFolder } from "../Relay";
import RemoteFolderSuggest from "../components/RemoteFolderSuggest.svelte";
import { GenericSuggestModal } from "./GenericSuggestModal";

export class RemoteFolderSuggestModal extends GenericSuggestModal<RemoteSharedFolder> {
	constructor(
		app: App,
		availableFolders: RemoteSharedFolder[],
		onSelect: (folder: RemoteSharedFolder) => void,
	) {
		super(
			app,
			RemoteFolderSuggest,
			{
				availableFolders,
				placeholder: "Search folders...",
			},
			onSelect,
		);
	}
}
