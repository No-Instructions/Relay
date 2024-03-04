import { Modal, TFolder, App, Notice } from "obsidian";
import { randomUUID } from "crypto";
import { SharedFolder, SharedFolders } from "../SharedFolder";

export class SharedFolderModal extends Modal {
	sharedFolders: SharedFolders;
	folder: TFolder;

	constructor(app: App, sharedFolders: SharedFolders, folder: TFolder) {
		super(app);
		this.sharedFolders = sharedFolders;
		this.folder = folder;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		modalEl.addClass("obsidian-live-modal");
		contentEl.empty();
		const sharedFolder = this.sharedFolders.find(
			(sharedFolder) => this.folder.path == sharedFolder.path
		);
		if (sharedFolder) {
			contentEl.createEl("h2", { text: "SharedFolder already exists" });
			contentEl.createEl("p", {
				text: "This folder is already shared.",
			});
			const button = contentEl.createEl("button", {
				text: "OK",
				attr: { class: "btn btn-ok" },
			});
			button.onClickEvent((ev) => {
				this.close();
			});
		} else {
			contentEl.createEl("h2", { text: "Share Settings" });
			contentEl.createEl("form", "form-live", (form) => {
				const randomGuid = randomUUID();
				contentEl.createEl("p", {
					text: "A new share-link has been generated for a new workspace. If you want to join an existing live workspace, enter the share link below.",
				});

				form.createEl("input", {
					type: "text",
					attr: {
						name: "ShareLink",
						id: "shareLink-guid",
					},
					value: `https://ydoc.live/${randomGuid}`,
				});

				form.createEl("button", {
					text: "Create",
					type: "submit",
				});

				const getGuid = function (url: string) {
					const url_ = new URL(url);
					return url_.pathname.slice(1);
				};
				form.onsubmit = async (e) => {
					e.preventDefault();

					const shareLink = form.querySelector(
						'input[id="shareLink-guid"]'
						// @ts-expect-error, not typed
					)?.value;
					let guid: string = randomGuid;
					if (shareLink) {
						try {
							guid = getGuid(shareLink);
						} catch (err) {
							new Notice(err);
						}
					} else {
						guid = randomGuid;
					}

					const path = this.folder.path;
					this.sharedFolders.new(path, guid);
					this.close();
				};
			});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class UnshareFolderModal extends Modal {
	sharedFolders: SharedFolders;
	folder: SharedFolder;

	constructor(app: App, sharedFolders: SharedFolders, folder: SharedFolder) {
		super(app);
		this.sharedFolders = sharedFolders;
		this.folder = folder;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		modalEl.addClass("obsidian-live-modal");
		contentEl.empty();
		const sharedFolder = this.sharedFolders.find(
			(sharedFolder) => this.folder.path == sharedFolder.path
		);
		if (sharedFolder) {
			contentEl.createEl("h2", { text: "Unshare Folder" });
			contentEl.createEl("p", {
				text: "Are you sure you want to unshare this folder?",
			});
			const button = contentEl.createEl("button", {
				text: "Unshare Folder",
				attr: { class: "btn btn-danger" },
			});
			button.onClickEvent((ev) => {
				this.sharedFolders.delete(sharedFolder);
				this.folder.docs.forEach((doc) => {
					doc.disconnect();
					doc.destroy();
				});
				this.folder.destroy();
				this.close();
			});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
