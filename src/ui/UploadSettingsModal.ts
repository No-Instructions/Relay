import { App, Modal, Setting } from "obsidian";

const MIB = 1024 * 1024;

export class UploadSettingsModal extends Modal {
	constructor(
		app: App,
		private bytes: number,
		private stream: boolean,
		private save: (bytes: number, stream: boolean) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Upload settings");
		const limit = new Setting(this.contentEl)
			.setName("Upload limit (MiB)")
			.setDesc("Files up to this size use the standard uploader. Set to 0 for unlimited.");
		let bytes = this.bytes;
		limit.addText(text => {
			const input = text.inputEl;
			input.type = "number";
			input.min = "0";
			input.step = "any";
			input.setAttribute("aria-label", "Upload limit (MiB)");
			text.setValue(String(bytes / MIB)).onChange(() => {
				bytes = input.valueAsNumber * MIB;
				saveButton.disabled = !Number.isSafeInteger(bytes) || bytes < 0;
			});
		});
		new Setting(this.contentEl)
			.setName("Stream files over this limit")
			.setDesc("Upload larger files in chunks. Turn this off to hold them on this device. The server’s file size limit still applies.")
			.addToggle(toggle => toggle.setValue(this.stream).onChange(value => { this.stream = value; }));
		const actions = new Setting(this.contentEl);
		const error = this.contentEl.createDiv({ attr: { role: "alert" } });
		actions.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()));
		const saveButton = actions.controlEl.createEl("button", { text: "Save", cls: "mod-cta" });
		saveButton.addEventListener("click", async () => {
			saveButton.disabled = true;
			try {
				await this.save(bytes, this.stream);
				this.close();
			} catch {
				error.setText("Couldn’t save the upload settings. Try again.");
				saveButton.disabled = false;
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
