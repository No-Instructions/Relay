import { App, Modal, Setting, setIcon } from "obsidian";
import type { AttachmentTransfer, AttachmentTransfers } from "../AttachmentTransfers";

export function openUploadSettings(app: App, transfers: AttachmentTransfers, key?: string): void {
	if (key === undefined || transfers.isBlockedByUploadLimit(key)) {
		const file = key === undefined ? undefined : transfers.rows.get(key);
		new UploadSettingsModal(app, transfers.uploadLimit, bytes => transfers.setUploadLimit(bytes), file).open();
	}
}

const MIB = 1024 * 1024;

function limitInputValue(bytes: number): string {
	const mib = bytes / MIB;
	const rounded = Number(mib.toFixed(6));
	return String(Math.round(rounded * MIB) === bytes ? rounded : Number(mib.toFixed(7)));
}

export class UploadSettingsModal extends Modal {
	constructor(
		app: App,
		private bytes: number,
		private save: (bytes: number) => Promise<void>,
		private file?: Pick<AttachmentTransfer, "path" | "total">,
	) {
		super(app);
	}

	private renderFile(): ((limit: number | undefined) => void) | undefined {
		if (this.file?.total === undefined) return;
		const total = this.file.total;
		const name = this.file.path.split("/").pop() ?? this.file.path;
		const sizeMiB = total / MIB;
		const rounded = Number(sizeMiB.toFixed(2));
		let size = rounded.toLocaleString();
		if (rounded === 0 && sizeMiB > 0) size = `<${(0.01).toLocaleString()}`;
		else if (rounded === this.bytes / MIB && sizeMiB > rounded) size = `>${size}`;
		const row = new Setting(this.contentEl).setName(name).setClass("relay-upload-file-row");
		const details = row.descEl;
		details.createDiv({ text: `File size: ${size} MiB` });
		const suggested = Math.ceil(sizeMiB * 2) / 2;
		if (suggested !== sizeMiB) {
			details.createDiv({ text: `Suggested limit: ${suggested.toLocaleString()} MiB` });
		}
		const indicator = row.controlEl.createSpan({ cls: "relay-upload-file-status", attr: { role: "status" } });
		return limit => {
			const ready = limit === 0 || (limit !== undefined && total <= limit);
			const label = limit === undefined ? "Invalid limit" : ready ? "Can upload" : "Over limit";
			if (indicator.textContent === label) return;
			indicator.empty();
			indicator.classList.toggle("is-ready", ready);
			const icon = indicator.createSpan({ attr: { "aria-hidden": "true" } });
			setIcon(icon, ready ? "check" : "alert-triangle");
			indicator.createSpan({ text: label });
		};
	}

	onOpen(): void {
		this.containerEl.addClass("relay-upload-limit-container");
		this.setTitle("Upload limit");
		const updateStatus = this.renderFile();
		const limit = new Setting(this.contentEl)
			.setName("Upload limit (MiB)")
			.setDesc("Applies to all Relay folders in this vault on this device. 0 disables the limit. Uploads load the entire file into memory. Obsidian can crash if memory is insufficient.");
		let bytes = this.bytes;
		updateStatus?.(bytes);
		limit.addText(text => {
			const input = text.inputEl;
			input.type = "number";
			input.inputMode = "decimal";
			input.min = "0";
			input.step = "any";
			input.setAttribute("aria-label", "Upload limit (MiB)");
			text.setValue(limitInputValue(bytes)).onChange(() => {
				const mib = input.valueAsNumber;
				bytes = Math.round(mib * MIB);
				const valid = Number.isSafeInteger(bytes) && (bytes > 0 || mib === 0);
				saveButton.disabled = !valid;
				updateStatus?.(valid ? bytes : undefined);
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
				error.setText("Upload limit could not be saved.");
				input.disabled = false;
				saveButton.disabled = false;
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
