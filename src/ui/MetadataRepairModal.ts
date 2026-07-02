"use strict";

import { App, Modal } from "obsidian";
import type { MetadataHealth, MetadataRepairResult } from "../MetadataHealth";

/**
 * Explains a locked Obsidian metadata database and offers two recovery
 * actions: a live repair (reopen the database and replace Obsidian's dead
 * connection) or an app reload. Opened by clicking the sidebar notice.
 */
export class MetadataRepairModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private metadataHealth: MetadataHealth,
	) {
		super(app);
	}

	onOpen(): void {
		this.render(null);
	}

	private render(result: MetadataRepairResult | null): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText("Obsidian metadata database is locked");

		const state = this.metadataHealth.state;
		contentEl.createEl("p", {
			text:
				"Obsidian's metadata index database connection was closed by the " +
				"browser (this can happen after suspend/resume) and Obsidian does " +
				"not reopen it. Until it is restored, search, backlinks, " +
				"properties, and tags will not update.",
		});
		if (state.details) {
			contentEl.createEl("p", {
				text: state.details,
				cls: "setting-item-description",
			});
		}

		if (result) {
			const status = contentEl.createEl("p");
			if (result.ok) {
				status.setText(
					`${result.message} Replayed ${result.replayedEntries} cache ` +
						`entries; queued ${result.reindexQueued} files for reindexing.`,
				);
			} else {
				status.setText(`Repair failed: ${result.message}`);
			}
		}

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });

		if (!result?.ok) {
			const repairBtn = buttons.createEl("button", {
				text: this.busy ? "Repairing…" : "Attempt live repair",
				cls: "mod-cta",
			});
			repairBtn.disabled = this.busy;
			repairBtn.addEventListener("click", async () => {
				if (this.busy) return;
				this.busy = true;
				this.render(null);
				let outcome: MetadataRepairResult;
				try {
					outcome = await this.metadataHealth.repair();
				} catch (error) {
					outcome = {
						ok: false,
						message: error instanceof Error ? error.message : String(error),
						replayedEntries: 0,
						reindexQueued: 0,
					};
				}
				this.busy = false;
				this.render(outcome);
			});
		}

		const reloadBtn = buttons.createEl("button", {
			text: "Reload Obsidian",
		});
		reloadBtn.addEventListener("click", () => {
			(this.app as any).commands?.executeCommandById("app:reload");
		});

		const closeBtn = buttons.createEl("button", {
			text: result?.ok ? "Done" : "Close",
		});
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
