import { App, Menu, Notice, TFile, TFolder } from "obsidian";
import { SharedFolders } from "src/SharedFolder";
import { SharedFolderModal, UnshareFolderModal } from "./FolderSharing";
import type { LoginManager } from "src/LoginManager";

export class FolderMenu {
	app: App;
	sharedFolders: SharedFolders;
	loginManager: LoginManager;

	constructor(
		app: App,
		loginManager: LoginManager,
		sharedFolders: SharedFolders
	) {
		this.app = app;
		this.sharedFolders = sharedFolders;
		this.loginManager = loginManager;
	}

	register() {
		return this.app.workspace.on(
			// @ts-ignore
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
						item.setTitle("Copy Share Key").onClick(() =>
							navigator.clipboard
								.writeText(`${folder.guid}`)
								.then(() => {
									new Notice("Copied Folder Share Key");
								})
						);
					});
					return true;
				}
				return false;
			});

			if (!isShared && this.loginManager.loggedIn) {
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
