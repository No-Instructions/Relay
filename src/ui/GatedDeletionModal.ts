"use strict";

import { App, Modal } from "obsidian";
import type {
	DecisionModalActions,
	DecisionModalHandle,
	GatedFolderView,
} from "./GatedDeletionController";

/**
 * The decision modal for one folder's gated deletion burst
 * (specs/surfacing gated deletions.md). A standard confirmation dialog: the
 * title asks the question, one line states what happened, one line states
 * what each action does, and the held paths sit behind a collapsed
 * disclosure so the dialog's size does not depend on the burst. "Decide
 * later", Escape, and click-away all choose neither and leave the burst
 * gated. The controller owns the queue and the send/restore wiring; this
 * shell only renders the burst and reports the choice.
 */
function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = Math.floor((max - 1) / 2);
	return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`;
}

export class GatedDeletionModal extends Modal {
	private resolvedByController = false;
	/** Disclosure state survives live-burst re-renders. */
	private listExpanded = false;

	constructor(
		app: App,
		private readonly view: GatedFolderView,
		private readonly actions: DecisionModalActions,
	) {
		super(app);
	}

	/** Open the modal and hand the controller a handle to drive it. */
	openHandle(): DecisionModalHandle {
		this.open();
		return {
			refresh: () => this.render(),
			close: () => {
				this.resolvedByController = true;
				this.close();
			},
		};
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolvedByController) {
			this.actions.dismiss();
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("system3-gated-deletions-modal");

		const paths = this.view.heldPaths();
		const count = paths.length;
		const noun = count === 1 ? "file" : "files";

		// Long folder names truncate in the middle — both ends of a name
		// carry the distinguishing parts — and the title never runs under
		// the modal's close control (see the modal's title padding).
		const name = truncateMiddle(this.view.name, 36);
		this.titleEl.setText(`Delete ${count} ${noun} from "${name}"?`);

		contentEl.createEl("p", {
			text:
				`${count === 1 ? "This file was" : "These files were"} deleted ` +
				`on this device. Relay paused syncing the change until you ` +
				`confirm.`,
		});

		// Consequence copy uses the buttons' exact vocabulary, one job each.
		const consequences = contentEl.createEl("p", {
			cls: "system3-gated-deletions-consequences",
		});
		consequences.createEl("strong", { text: "Restore files" });
		consequences.appendText(
			` copies ${count === 1 ? "it" : "them"} back from the server. `,
		);
		consequences.createEl("strong", { text: "Delete everywhere" });
		consequences.appendText(
			` removes ${count === 1 ? "it" : "them"} for all members.`,
		);

		const details = contentEl.createEl("details", {
			cls: "system3-gated-deletions-details",
		});
		details.toggleAttribute("open", this.listExpanded);
		details.addEventListener("toggle", () => {
			this.listExpanded = details.open;
		});
		details.createEl("summary", { text: `Show ${count} ${noun}` });
		const list = details.createDiv({
			cls: "system3-gated-deletions-list",
		});
		for (const path of paths) {
			const row = list.createDiv({ cls: "system3-gated-deletions-path" });
			const slash = path.lastIndexOf("/");
			if (slash >= 0) {
				row.createSpan({
					cls: "system3-gated-deletions-path-dir",
					text: path.slice(0, slash + 1),
				});
				row.createSpan({
					cls: "system3-gated-deletions-path-name",
					text: path.slice(slash + 1),
				});
			} else {
				row.createSpan({
					cls: "system3-gated-deletions-path-name",
					text: path,
				});
			}
		}

		// Closing the modal — X, Escape, click-away — is the deferral: it
		// routes through onClose → dismiss and keeps the burst gated.
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const deleteButton = buttons.createEl("button", {
			text: "Delete everywhere",
			cls: "mod-warning",
		});
		deleteButton.addEventListener("click", () =>
			this.actions.deleteEverywhere(),
		);
		const restoreButton = buttons.createEl("button", {
			text: "Restore files",
			cls: "mod-cta",
		});
		restoreButton.addEventListener("click", () =>
			this.actions.restoreFiles(),
		);
	}
}
