import { TAbstractFile, TFolder, Workspace, WorkspaceLeaf } from "obsidian";
import { SharedFolder, SharedFolders } from "../SharedFolder";
import { VaultFacade } from "src/obsidian-api/Vault";
import type { ConnectionState } from "src/HasProvider";
import Pill from "src/components/Pill.svelte";

export class FolderNavigationDecorations {
	vault: VaultFacade;
	workspace: Workspace;
	sharedFolders: SharedFolders;
	folderListener: any;
	clickListeners: Map<HTMLElement, any>;
	pills: Map<HTMLElement, Pill>;

	constructor(
		vault: VaultFacade,
		workspace: Workspace,
		sharedFolders: SharedFolders
	) {
		this.vault = vault;
		this.pills = new Map<HTMLElement, Pill>();
		this.clickListeners = new Map<HTMLElement, any>();
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

	private getFileExplorerItem(
		fileExplorer: WorkspaceLeaf,
		file: TAbstractFile
	) {
		// XXX this is a private API
		//@ts-expect-error
		return fileExplorer.view.fileItems[file.path];
	}

	removeStatuses(fileExplorer: WorkspaceLeaf, folder: TFolder) {
		const folderItem = this.getFileExplorerItem(fileExplorer, folder);
		this.folderStatus(folderItem.selfEl);
		folder.children.forEach((child) => {
			if (child instanceof TFolder) {
				this.removeStatuses(fileExplorer, child);
			} else {
				const fileItem = this.getFileExplorerItem(fileExplorer, child);
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
					const folderItem = this.getFileExplorerItem(
						fileExplorer,
						folder
					);
					if (!folderItem) {
						return;
					}
					const titleEl = folderItem.selfEl;
					let pill = this.pills.get(titleEl);

					if (sharedFolder) {
						// The element is not always available if the folder is not expanded,
						// so we add a click event listener to update the status if the folder is expanded.
						const clickListener = () => {
							this.folderStatus(titleEl, sharedFolder);
						};
						titleEl.addEventListener("click", clickListener);
						this.clickListeners.set(titleEl, clickListener);

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
							pill = new Pill({
								target: titleEl,
							});
							this.pills.set(titleEl, pill);
						}
					} else if (pill) {
						this.pills.delete(titleEl);
						pill.$destroy();
						this.removeStatuses(fileExplorer, folder);
						const clickListener = this.clickListeners.get(titleEl);
						if (clickListener) {
							titleEl.removeEventListener("click", clickListener);
						}
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
		this.clickListeners.forEach((listener, el) => {
			el.removeEventListener("click", listener);
		});
		this.refresh();
	}
}
