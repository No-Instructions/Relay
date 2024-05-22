import { TFolder, Workspace, WorkspaceLeaf } from "obsidian";
import { SharedFolder, SharedFolders } from "../SharedFolder";
import { VaultFacade } from "src/obsidian-api/Vault";
import type { ConnectionState } from "src/HasProvider";

export class FolderNavigationDecorations {
	vault: VaultFacade;
	workspace: Workspace;
	sharedFolders: SharedFolders;
	folderListener: any;

	constructor(
		vault: VaultFacade,
		workspace: Workspace,
		sharedFolders: SharedFolders
	) {
		this.vault = vault;
		this.workspace = workspace;
		this.sharedFolders = sharedFolders;

		this.workspace.onLayoutReady(() => this.refresh());
		this.folderListener = this.sharedFolders.on(() => this.refresh());
		this.refresh();
	}

	register() {
		return this.workspace.on("layout-change", () => this.refresh());
	}

	folderStatus(el: any, folder?: SharedFolder) {
		if (folder?.state.status === "connected") {
			el.nextSibling?.removeClass("system3-connecting");
			el.nextSibling?.addClass("system3-connected");
		} else if (folder?.state.status === "connecting") {
			el.nextSibling?.removeClass("system3-connected");
			el.nextSibling?.addClass("system3-connecting");
		} else {
			el.nextSibling?.removeClass("system3-connecting");
			el.nextSibling?.removeClass("system3-connected");
		}
	}

	docStatus(el: any, status?: ConnectionState) {
		if (status?.status === "connected") {
			el.removeClass("system3-connecting");
			el.addClass("system3-connected");
		} else if (status?.status === "connecting") {
			el.removeClass("system3-connected");
			el.addClass("system3-connecting");
		} else {
			el.removeClass("system3-connected");
			el.removeClass("system3-connecting");
		}
	}

	removeStatuses(fileExplorer: WorkspaceLeaf, folder: TFolder) {
		//@ts-expect-error
		const folderItem = fileExplorer.view.fileItems[folder.path];
		this.folderStatus(folderItem.selfEl);
		folder.children.forEach((child) => {
			if (child instanceof TFolder) {
				this.removeStatuses(fileExplorer, child);
			} else {
				//@ts-expect-error
				const fileItem = fileExplorer.view.fileItems[child.path];
				if (!fileItem) {
					// likely a rename
					return;
				}
				this.docStatus(fileItem.el);
			}
		});
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
					const folderItem = fileExplorer.view.fileItems[folder.path];
					if (!folderItem) {
						return;
					}
					const titleEl = folderItem.selfEl;
					let pill = titleEl.querySelector(".obsidian-live-pill");

					if (sharedFolder) {
						// The element is not always available if the folder is not expanded
						titleEl.addEventListener("click", () => {
							this.folderStatus(titleEl, sharedFolder);
						});
						sharedFolder.subscribe(titleEl, (status) => {
							this.folderStatus(titleEl, sharedFolder);
						});

						sharedFolder.whenReady().then(() => {
							sharedFolder.docs.forEach((doc) => {
								const docPath = sharedFolder.getPath(doc.path);
								const fileItem =
									//@ts-expect-error
									fileExplorer.view.fileItems[docPath];
								this.docStatus(fileItem.el, doc.state);
								doc.subscribe(fileItem.el, (status) => {
									const fileExplorers =
										this.workspace.getLeavesOfType(
											"file-explorer"
										);
									fileExplorers.forEach((fileExplorer) => {
										const fileItem =
											//@ts-expect-error
											fileExplorer.view.fileItems[
												docPath
											];
										this.docStatus(fileItem.el, status);
									});
								});
							});
						});

						this.folderStatus(titleEl, sharedFolder);

						if (!pill) {
							// TODO move this to a svelte component
							// add a pill
							pill = titleEl.createDiv();
							pill.classList.add("obsidian-live-pill");
							pill.innerHTML = "<span>live</span>";
							titleEl.appendChild(pill);
						}
					} else if (pill) {
						// remove a pill
						pill.remove();
						this.removeStatuses(fileExplorer, folder);
					}
				}
			});
		});
	}

	destroy() {
		this.sharedFolders.off(this.folderListener);
		const fileExplorers = this.workspace.getLeavesOfType("file-explorer");
		for (const fileExplorer of fileExplorers) {
			const root = this.vault.getFolderByPath(this.vault.root);
			if (root) {
				this.removeStatuses(fileExplorer, root);
			}
		}
		this.refresh();
	}
}
