import { TAbstractFile, TFolder, Workspace, WorkspaceLeaf } from "obsidian";
import { SharedFolder, SharedFolders } from "../SharedFolder";
import { VaultFacade } from "src/obsidian-api/Vault";
import type { ConnectionState, ConnectionStatus } from "src/HasProvider";
import Pill from "src/components/Pill.svelte";

export class FolderNavigationDecorations {
	vault: VaultFacade;
	workspace: Workspace;
	sharedFolders: SharedFolders;
	folderListener: any;
	mutationObservers: Map<HTMLElement, any>;
	pills: Map<HTMLElement, Pill>;

	constructor(
		vault: VaultFacade,
		workspace: Workspace,
		sharedFolders: SharedFolders
	) {
		this.vault = vault;
		this.pills = new Map<HTMLElement, Pill>();
		this.mutationObservers = new Map<HTMLElement, any>();
		this.workspace = workspace;
		this.sharedFolders = sharedFolders;

		this.workspace.onLayoutReady(() => this.refresh());
		this.folderListener = this.sharedFolders.on(() => this.refresh());
		this.refresh();
	}

	register() {
		return this.workspace.on("layout-change", () => this.refresh());
	}

	folderDecoration(el: any, isSharedFolder: boolean) {
		if (isSharedFolder) {
			el.nextSibling?.addClass("system3-live");
		} else {
			el.nextSibling?.removeClass("system3-live");
		}
	}
	//	if (status === "connected") {
	//		el.nextSibling?.removeClass("system3-connecting");
	//		el.nextSibling?.addClass("system3-live");
	//		el.nextSibling?.addClass("system3-connected");
	//	} else if (status === "connecting") {
	//		el.nextSibling?.removeClass("system3-connected");
	//		el.nextSibling?.addClass("system3-live");
	//		el.nextSibling?.addClass("system3-connecting");
	//	} else if (status === "disconnected" || status === "unknown") {
	//		el.nextSibling?.removeClass("system3-connected");
	//		el.nextSibling?.removeClass("system3-connecting");
	//		el.nextSibling?.addClass("system3-live");
	//	} else {
	//		el.nextSibling?.removeClass("system3-connecting");
	//		el.nextSibling?.removeClass("system3-connected");
	//		el.nextSibling?.removeClass("system3-live");
	//	}
	//}

	docStatus(el: any, status?: ConnectionState) {
		if (status?.status === "connected") {
			el.removeClass("system3-connecting");
			el.addClass("system3-connected");
			el.addClass("system3-live");
		} else if (status?.status === "connecting") {
			el.removeClass("system3-connected");
			el.addClass("system3-connecting");
			el.addClass("system3-live");
		} else if (status?.status === "disconnected") {
			el.addClass("system3-live");
			el.removeClass("system3-connected");
			el.removeClass("system3-connecting");
		} else {
			el.removeClass("system3-connected");
			el.removeClass("system3-connecting");
			el.removeClass("system3-live");
		}
	}

	private getFileExplorerItem(fileExplorer: WorkspaceLeaf, file: string): any;

	private getFileExplorerItem(
		fileExplorer: WorkspaceLeaf,
		file: TAbstractFile
	): any;

	private getFileExplorerItem(
		fileExplorer: WorkspaceLeaf,
		file: TAbstractFile | string
	) {
		// XXX this is a private API
		const path = file instanceof TAbstractFile ? file.path : file;
		//@ts-expect-error
		return fileExplorer.view.fileItems[path];
	}

	removePills(force = false, folder?: TFolder) {
		const sharedFolderPaths = force
			? []
			: this.sharedFolders.map((sharedFolder) => sharedFolder.path);
		const fileExplorers = this.workspace.getLeavesOfType("file-explorer");
		const root = folder
			? folder
			: (this.vault.getAbstractFileByPath("/") as TFolder | null);
		console.warn("remove pills", sharedFolderPaths, fileExplorers, root);
		fileExplorers.forEach((fileExplorer) => {
			if (root) {
				this._removePills(fileExplorer, root, sharedFolderPaths);
			}
		});
	}

	_removePills(
		fileExplorer: WorkspaceLeaf,
		folder: TFolder,
		sharedFolderPaths: string[]
	) {
		const folderItem = this.getFileExplorerItem(fileExplorer, folder);
		if (folderItem) {
			const pill = this.pills.get(folderItem.selfEl);
			if (pill && !sharedFolderPaths.contains(folder.path)) {
				console.warn("removing pill");
				pill.$destroy();
				this.pills.delete(folderItem.selfEl);
			}
		}
		folder.children.forEach((child) => {
			if (child instanceof TFolder) {
				this._removePills(fileExplorer, child, sharedFolderPaths);
			}
		});
	}

	removeStatuses(force = false, folder?: TFolder) {
		const sharedFolderPaths = force
			? []
			: this.sharedFolders.map((sharedFolder) => sharedFolder.path);
		const fileExplorers = this.workspace.getLeavesOfType("file-explorer");
		const root = folder
			? folder
			: (this.vault.getAbstractFileByPath("/") as TFolder | null);
		fileExplorers.forEach((fileExplorer) => {
			if (root) {
				this._removeStatuses(fileExplorer, root, sharedFolderPaths);
			}
		});
	}

	_removeStatuses(
		fileExplorer: WorkspaceLeaf,
		folder: TFolder,
		sharedFolderPaths: string[]
	) {
		const folderItem = this.getFileExplorerItem(fileExplorer, folder);
		if (folderItem) {
			const decorate = sharedFolderPaths.contains(folder.path);
			if (decorate) {
				console.warn("decorate", folder.path);
			}
			this.folderDecoration(folderItem.selfEl, decorate);
		}
		folder.children.forEach((child) => {
			if (child instanceof TFolder) {
				this._removeStatuses(fileExplorer, child, sharedFolderPaths);
			} else {
				const fileItem = this.getFileExplorerItem(fileExplorer, child);
				this.docStatus(fileItem.el);
			}
		});
	}

	refresh() {
		console.warn("foldernav refresh");
		const fileExplorers = this.workspace.getLeavesOfType("file-explorer");
		const sharedFolders = this.sharedFolders.items();

		sharedFolders.forEach((sharedFolder) => {
			console.warn("shared folder", sharedFolder.path);
			const folder = this.vault.getAbstractFileByPath(
				sharedFolder.path
			) as TFolder | null;
			if (!folder) {
				return;
			}

			fileExplorers.forEach((fileExplorer) => {
				const folderItem = this.getFileExplorerItem(
					fileExplorer,
					folder
				);
				if (!folderItem) {
					return;
				}
				const titleEl = folderItem.selfEl;
				let pill = this.pills.get(titleEl);

				if (!pill) {
					pill = new Pill({
						target: titleEl,
						props: {
							status: sharedFolder.state.status,
						},
					});
					sharedFolder.subscribe(titleEl, (status) => {
						pill?.$set({ status: status.status });
					});
					this.pills.set(titleEl, pill);
				}

				if (!this.mutationObservers.has(titleEl)) {
					const observer = new MutationObserver(
						(mutationsList, observer) => {
							for (let mutation of mutationsList) {
								if (mutation.type === "childList") {
									if (titleEl.nextSibling) {
										console.log("observation");
										this.folderDecoration(titleEl, true);
										pill?.$set({
											status: sharedFolder.state.status,
										});
										observer.disconnect();
									}
								}
							}
						}
					);
					observer.observe(titleEl.parentElement, {
						childList: true,
						subtree: true,
					});
					this.mutationObservers.set(titleEl, observer);
				}

				this.folderDecoration(titleEl, true);

				sharedFolder.whenReady().then(() => {
					sharedFolder.docs.forEach((doc) => {
						const docPath = sharedFolder.getPath(doc.path);
						const fileItem = this.getFileExplorerItem(
							fileExplorer,
							docPath
						);
						this.docStatus(fileItem.el, doc.state);
						doc.subscribe(fileItem.el, (status) => {
							const fileExplorers =
								this.workspace.getLeavesOfType("file-explorer");
							fileExplorers.forEach((fileExplorer) => {
								const fileItem = this.getFileExplorerItem(
									fileExplorer,
									docPath
								);
								this.docStatus(fileItem.el, status);
							});
						});
					});
				});
			});
		});
		console.warn("cleanup");
		this.removePills();
		this.removeStatuses();
	}

	destroy() {
		this.sharedFolders.off(this.folderListener);
		const fileExplorers = this.workspace.getLeavesOfType("file-explorer");
		this.removePills(true);
		this.removeStatuses(true);
		this.mutationObservers.forEach((listener, el) => {
			listener.disconnect();
		});
		this.pills.forEach((pill) => {
			pill.$destroy();
		});
		this.refresh();
	}
}
