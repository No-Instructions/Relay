import { App, Modal } from "obsidian";
import type { DeletionBurstResolution } from "../FolderDeletionGate";

/**
 * The held-burst resolution surface: an anomalous local deletion burst is
 * held at the bridge, and this modal offers exactly two resolutions —
 * replicate the deletions to the group, or restore the files from the
 * group's copy. Closing the modal resolves nothing: the burst stays held
 * (it survives restart from the persisted ledger) and re-surfaces on the
 * next evaluation.
 */
export class DeletionGateModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private folderPath: string,
		private paths: string[],
		private onResolve: (resolution: DeletionBurstResolution) => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl, titleEl } = this;
		titleEl.setText("Confirm shared folder deletions");

		contentEl.createEl("p", {
			text:
				`${this.paths.length} files were deleted locally in the shared ` +
				`folder "${this.folderPath}". These deletions have not been ` +
				`shared with the group yet.`,
		});

		const list = contentEl.createEl("div", {
			cls: "system3-deletion-gate-list",
		});
		list.style.maxHeight = "240px";
		list.style.overflowY = "auto";
		list.style.margin = "0.5em 0";
		list.style.padding = "0.5em";
		list.style.border =
			"1px solid var(--background-modifier-border)";
		list.style.borderRadius = "4px";
		for (const path of this.paths) {
			list.createEl("div", { text: path, cls: "system3-deletion-gate-row" });
		}

		contentEl.createEl("p", {
			text:
				"Delete these files for everyone, or restore them in this " +
				"vault from the shared copy? If you decide later, the " +
				"deletions stay local — even across restarts.",
		});

		const buttons = contentEl.createEl("div");
		buttons.style.display = "flex";
		buttons.style.justifyContent = "flex-end";
		buttons.style.gap = "0.5em";

		const restoreButton = buttons.createEl("button", {
			text: "Restore files",
		});
		restoreButton.addEventListener("click", () => {
			this.resolve("restore");
		});

		const replicateButton = buttons.createEl("button", {
			text: "Delete for everyone",
			cls: "mod-warning",
		});
		replicateButton.addEventListener("click", () => {
			this.resolve("replicate");
		});
	}

	private resolve(resolution: DeletionBurstResolution) {
		if (this.resolved) return;
		this.resolved = true;
		this.onResolve(resolution);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}
