import { App, Modal, Setting } from "obsidian";
import type { AttachmentTransfer, AttachmentTransfers } from "../AttachmentTransfers";

export function openUploadSettings(app: App, transfers: AttachmentTransfers, key?: string): void {
	if (key === undefined || transfers.isBlockedByUploadLimit(key)) {
		const file = key === undefined ? undefined : transfers.rows.get(key);
		new UploadSettingsModal(app, transfers.uploadLimit, bytes => transfers.setUploadLimit(bytes), file).open();
	}
}

const MIB = 1024 * 1024;

export class UploadSettingsModal extends Modal {
	constructor(
		app: App,
		private bytes: number,
		private save: (bytes: number) => Promise<void>,
		private file?: Pick<AttachmentTransfer, "path" | "total">,
	) {
		super(app);
	}

	onOpen(): void {
		this.containerEl.addClass("relay-upload-limit-container");
		this.setTitle("Upload limit");
		if (this.file?.total !== undefined) {
			const name = this.file.path.split("/").pop() ?? this.file.path;
			const limitMiB = Math.ceil(this.file.total / (MIB / 2)) / 2;
			new Setting(this.contentEl)
				.setName(name)
				.setDesc(`${this.file.total.toLocaleString()} bytes · Fits at ${limitMiB} MiB`);
		}
		const limit = new Setting(this.contentEl)
			.setName("Upload limit (MiB)")
			.setDesc("Obsidian loads the whole file into memory when uploading. If this device runs out of memory, Obsidian can crash. Set to 0 for unlimited.");
		let bytes = this.bytes;
		limit.addText(text => {
			const input = text.inputEl;
			input.type = "number";
			input.inputMode = "decimal";
			input.min = "0";
			input.step = "any";
			input.setAttribute("aria-label", "Upload limit (MiB)");
			text.setValue(String(bytes / MIB)).onChange(() => {
				bytes = input.valueAsNumber * MIB;
				saveButton.disabled = !Number.isSafeInteger(bytes) || bytes < 0;
			});
		});
		const actions = new Setting(this.contentEl);
		const error = this.contentEl.createDiv({ attr: { role: "alert" } });
		actions.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()));
		const saveButton = actions.controlEl.createEl("button", { text: "Save", cls: "mod-cta" });
		saveButton.addEventListener("click", async () => {
			saveButton.disabled = true;
			const input = limit.controlEl.querySelector("input")!;
			input.disabled = true;
			try {
				await this.save(bytes);
				this.close();
			} catch {
				error.setText("Couldn’t save the upload limit. Try again.");
				input.disabled = false;
				saveButton.disabled = false;
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
