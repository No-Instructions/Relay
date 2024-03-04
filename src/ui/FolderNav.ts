import { Workspace } from "obsidian";
import { SharedFolders } from "../SharedFolder";
import { VaultFacade } from "src/obsidian-api/Vault";

export class FolderNavIcon {
	vault: VaultFacade;
	workspace: Workspace;
	sharedFolders: SharedFolders;

	constructor(
		vault: VaultFacade,
		workspace: Workspace,
		sharedFolders: SharedFolders
	) {
		this.vault = vault;
		this.workspace = workspace;
		this.sharedFolders = sharedFolders;

		this.workspace.onLayoutReady(() => this.refresh());
		this.sharedFolders.on(() => this.refresh());
		this.refresh();
	}

	register() {
		return this.workspace.on("layout-change", () => this.refresh());
	}

	refresh() {
		const fileExplorers = this.workspace.getLeavesOfType("file-explorer");

		this.vault.iterateFolders((folder) => {
			fileExplorers.forEach((fileExplorer) => {
				if (folder) {
					const sharedFolder = this.sharedFolders.find((f) => {
						return f.path == folder.path;
					});
					//@ts-expect-error
					const fileItem = fileExplorer.view.fileItems[folder.path];
					if (!fileItem) {
						return;
					}
					const titleEl = fileItem.selfEl;
					let pill = titleEl.querySelector(".obsidian-live-pill");

					if (sharedFolder && !pill) {
						// add a pill
						pill = titleEl.createDiv();
						pill.classList.add("obsidian-live-pill");
						pill.innerHTML = "<span>live</span>";
						titleEl.appendChild(pill);
					} else if (pill && !sharedFolder) {
						// remove a pill
						pill.remove();
					}
				}
			});
		});
	}
}
