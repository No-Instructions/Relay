import { App, SuggestModal } from "obsidian";
import type { RemoteSharedFolder } from "src/Relay";
import type { RelayManager } from "src/RelayManager";
import type { SharedFolders } from "src/SharedFolder";

export class RemoteFolderSuggestModal extends SuggestModal<RemoteSharedFolder> {
	constructor(
		app: App,
		private sharedFolders: SharedFolders,
		private relayManager: RelayManager,
		private availableFolders: RemoteSharedFolder[],
		private onSelect: (folder: RemoteSharedFolder) => Promise<void>,
	) {
		super(app);
		
		this.setInstructions([
			{
				command: "↑/↓",
				purpose: "Navigate",
			},
			{
				command: "Enter",
				purpose: "Add folder to vault",
			},
			{
				command: "Esc",
				purpose: "Cancel",
			},
		]);
		
		this.setPlaceholder("Search folders...");
	}

	getSuggestions(query: string): RemoteSharedFolder[] {
		const lowerQuery = query.toLowerCase();
		
		return this.availableFolders.filter(folder => {
			const name = (folder.name || "").toLowerCase();
			const relayName = (folder.relay?.name || "").toLowerCase();
			
			return name.includes(lowerQuery) || relayName.includes(lowerQuery);
		}).sort((a, b) => {
			const aText = `${a.relay?.name || "Unknown Relay"} / ${a.name || "Unnamed Folder"}`;
			const bText = `${b.relay?.name || "Unknown Relay"} / ${b.name || "Unnamed Folder"}`;
			return aText.localeCompare(bText);
		});
	}

	renderSuggestion(folder: RemoteSharedFolder, el: HTMLElement): void {
		const text = `${folder.relay?.name || "Unknown Relay"} / ${folder.name || "Unnamed Folder"}`;
		el.textContent = text;
	}

	async onChooseSuggestion(folder: RemoteSharedFolder, evt: MouseEvent | KeyboardEvent) {
		try {
			await this.onSelect(folder);
		} catch (error) {
			console.error("Failed to add folder:", error);
		}
	}
}