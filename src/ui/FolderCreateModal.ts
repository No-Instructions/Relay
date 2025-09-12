import { App, Modal, Setting } from "obsidian";
import { normalizePath } from "obsidian";
import type { Relay } from "src/Relay";
import type { SharedFolders } from "src/SharedFolder";
import type { RelayManager } from "src/RelayManager";
import { uuidv4 } from "lib0/random";

export class FolderCreateModal extends Modal {
	private folderPath: string = "";
	private isPrivate: boolean = false;
	private createButton: HTMLElement | null = null;

	constructor(
		app: App,
		private sharedFolders: SharedFolders,
		private relayManager: RelayManager,
		private relay: Relay,
		private onSuccess: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Create Shared Folder" });

		// Folder path input
		new Setting(contentEl)
			.setName("Folder path")
			.setDesc("The path where the shared folder will be created")
			.addText((text) => {
				text
					.setPlaceholder("e.g., Notes/Shared")
					.setValue(this.folderPath)
					.onChange((value) => {
						this.folderPath = value.trim();
						this.updateCreateButton();
					});
				text.inputEl.addEventListener("keypress", (e) => {
					if (e.key === "Enter") {
						this.handleCreate();
					}
				});
				// Focus the input
				setTimeout(() => text.inputEl.focus(), 10);
			});

		// Private folder toggle (only for relay version > 0)
		if (this.relay.version > 0) {
			new Setting(contentEl)
				.setName("Private folder")
				.setDesc("Only users you add will have access to this folder")
				.addToggle((toggle) => {
					toggle
						.setValue(this.isPrivate)
						.onChange((value) => {
							this.isPrivate = value;
						});
				});
		}

		// Buttons
		const buttonContainer = contentEl.createDiv("modal-button-container");
		buttonContainer.style.display = "flex";
		buttonContainer.style.justifyContent = "flex-end";
		buttonContainer.style.gap = "8px";
		buttonContainer.style.marginTop = "20px";

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
			cls: "mod-cancel"
		});
		cancelButton.onclick = () => this.close();

		this.createButton = buttonContainer.createEl("button", {
			text: "Create",
			cls: "mod-cta"
		});
		this.createButton.onclick = () => this.handleCreate();
		
		this.updateCreateButton();
	}

	private updateCreateButton() {
		if (this.createButton) {
			const isValid = this.isValidPath(this.folderPath);
			this.createButton.toggleClass("mod-disabled", !isValid);
			(this.createButton as HTMLButtonElement).disabled = !isValid;
		}
	}

	private isValidPath(path: string): boolean {
		if (!path || path.trim() === "") return false;
		
		// Obsidian restricted characters
		const restrictedCharacters = /[\\:*?"<>|]/;
		if (restrictedCharacters.test(path)) return false;

		// Check for invalid path segments
		const segments = path.split("/");
		for (const segment of segments) {
			if (segment === "" || segment === "." || segment === "..") {
				return false;
			}
		}
		
		return true;
	}

	private async handleCreate() {
		if (!this.isValidPath(this.folderPath)) return;

		try {
			const normalizedPath = normalizePath(this.folderPath);
			const folder = this.sharedFolders.find((folder) => folder.path === normalizedPath);

			// If shared folder already exists, but remote does not
			if (folder) {
				const remote = await this.relayManager.createRemoteFolder(
					folder,
					this.relay,
					this.isPrivate
				);
				folder.remote = remote;
				folder.connect();
				this.sharedFolders.notifyListeners();
			} else {
				// Ensure folder exists in vault
				if (this.app.vault.getFolderByPath(normalizedPath) === null) {
					await this.app.vault.createFolder(normalizedPath);
				}

				// Create new shared folder
				const guid = uuidv4();
				const sharedFolder = this.sharedFolders.new(
					normalizedPath,
					guid,
					this.relay.guid,
					true,
				);

				// Create remote folder
				const remote = await this.relayManager.createRemoteFolder(
					sharedFolder,
					this.relay,
					this.isPrivate
				);
				sharedFolder.remote = remote;
				this.sharedFolders.notifyListeners();
			}

			this.onSuccess();
			this.close();
		} catch (error) {
			console.error("Failed to create folder:", error);
			// Could add a notice here for user feedback
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}