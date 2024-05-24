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

	folderStatus(el: any, status?: ConnectionStatus) {
		if (status === "connected") {
			el.nextSibling?.removeClass("system3-connecting");
			el.nextSibling?.addClass("system3-live");
			el.nextSibling?.addClass("system3-connected");
		} else if (status === "connecting") {
			el.nextSibling?.removeClass("system3-connected");
			el.nextSibling?.addClass("system3-live");
			el.nextSibling?.addClass("system3-connecting");
		} else if (status === "disconnected") {
			el.nextSibling?.removeClass("system3-connected");
			el.nextSibling?.removeClass("system3-connecting");
			el.nextSibling?.addClass("system3-live");
		} else {
			el.nextSibling?.removeClass("system3-connecting");
			el.nextSibling?.removeClass("system3-connected");
			el.nextSibling?.removeClass("system3-live");
		}
	}

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
						if (!this.mutationObservers.has(titleEl)) {
							const observer = new MutationObserver(
								(mutationsList, observer) => {
									for (let mutation of mutationsList) {
										if (mutation.type === "childList") {
											if (titleEl.nextSibling) {
												console.log("observation");
												this.folderStatus(
													titleEl,
													sharedFolder.state.status
												);
												sharedFolder.subscribe(
													titleEl.nextSibling,
													(status) => {
														this.folderStatus(
															titleEl,
															status.status
														);
													}
												);
												pill?.$set({
													status: sharedFolder.state
														.status,
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

						this.folderStatus(titleEl, sharedFolder.state.status);

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
					} else if (pill) {
						this.pills.delete(titleEl);
						pill.$destroy();
						this.removeStatuses(fileExplorer, folder);
						const mutationObserver =
							this.mutationObservers.get(titleEl);
						if (mutationObserver) {
							mutationObserver.disconnect();
							this.mutationObservers.delete(titleEl);
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
		this.mutationObservers.forEach((listener, el) => {
			listener.disconnect();
		});
		this.refresh();
	}
}
