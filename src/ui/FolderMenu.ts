import { App, Menu, Notice, TFile, TFolder } from "obsidian";
import { SharedFolders } from "src/SharedFolder";
import { SharedFolderModal, UnshareFolderModal } from "./FolderSharing";

export class FolderMenu {
	app: App; // xxx this is just so we can create modals?
	sharedFolders: SharedFolders;

	constructor(app: App, sharedFolders: SharedFolders) {
		this.app = app;
		this.sharedFolders = sharedFolders;
	}

	register() {
		return this.app.workspace.on(
			"file-menu",
			this.fileMenuItems.bind(this)
		);
	}

	fileMenuItems(menu: Menu, file: TFile) {
		// Add a menu item to the folder context menu to create a board
		if (file instanceof TFolder) {
			const isShared = this.sharedFolders.some((folder) => {
				if (file.path == folder.path) {
					menu.addItem((item) => {
						item.setTitle("Unshare Folder")
							.setIcon("dot-network")
							.onClick(() =>
								new UnshareFolderModal(
									this.app,
									this.sharedFolders,
									folder
								).open()
							);
					});

					menu.addItem((item) => {
						item.setTitle("Copy ShareLink").onClick(() =>
							navigator.clipboard
								.writeText(`https://ydoc.live/${folder.guid}`)
								.then(() => {
									new Notice("Copied Folder ShareLink");
								})
						);
					});
					return true;
				}
				return false;
			});

			if (!isShared) {
				menu.addItem((item) => {
					item.setTitle("Share Folder")
						.setIcon("dot-network")
						.onClick(() =>
							new SharedFolderModal(
								this.app,
								this.sharedFolders,
								file
							).open()
						);
				});
			}
		}
	}
}
