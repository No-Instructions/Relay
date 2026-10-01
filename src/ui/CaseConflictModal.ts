import { Modal, Platform, normalizePath, type App, type TAbstractFile } from "obsidian";
import { basename, dirname, join } from "path-browserify";
import CaseConflictExplanationView from "../components/CaseConflictExplanation.svelte";
import {
	caseConflictState,
	explainCaseConflict,
	type CaseConflictExplanation,
} from "../caseConflictState";
import type { SharedFolder } from "../SharedFolder";
import { RenamePrompt } from "./RenamePrompt";
import { mountComponent, type MountedComponent } from "./svelteHost.svelte";

/**
 * The "more info" behind a NAME CONFLICT pill or banner: both spellings
 * with the letters that differ marked and where each one is, why they
 * conflict, the fix, and a rename for either spelling. Cancelling a rename
 * returns here while the conflict stands.
 */
export class CaseConflictModal extends Modal {
	private content?: MountedComponent;

	constructor(
		app: App,
		private folder: SharedFolder,
		private file: TAbstractFile,
		private explanation: CaseConflictExplanation,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl, titleEl, modalEl, explanation } = this;
		modalEl.addClass("relay-case-conflict-modal");
		titleEl.setText(explanation.title);
		this.content = mountComponent(CaseConflictExplanationView, {
			target: contentEl,
			props: { explanation },
		});
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		explanation.actions.forEach((action, index) => {
			const button = buttons.createEl("button", {
				text: action.label,
				cls: index === 0 ? "mod-cta" : "",
			});
			button.addEventListener("click", () => void this.rename(action.path, action.kind));
		});
		const close = buttons.createEl("button", { text: "Close" });
		close.addEventListener("click", () => this.close());
	}

	private async rename(vpath: string, kind: "file" | "folder"): Promise<void> {
		this.close();
		const renamed = await renameSpelling(this.app, this.folder, vpath, kind);
		if (!renamed) openCaseConflictExplanation(this.app, this.folder, this.file);
	}

	onClose() {
		this.content?.destroy();
		this.content = undefined;
		this.contentEl.empty();
	}
}

/**
 * Renames one spelling of a conflicting path after asking for the new name.
 * A spelling on this disk is renamed in the vault, as Obsidian would; one
 * this machine keeps off its disk is renamed in the shared folder, which
 * every machine then follows. Returns false when the prompt is cancelled.
 */
export async function renameSpelling(
	app: App,
	folder: SharedFolder,
	vpath: string,
	kind: "file" | "folder",
): Promise<boolean> {
	const current = basename(vpath);
	const next = await new RenamePrompt(app, { name: current, kind }).prompt();
	if (next === null) return false;
	const extension = current.includes(".") ? current.slice(current.lastIndexOf(".")) : "";
	const name = kind === "file" && extension && !next.includes(".") ? `${next}${extension}` : next;
	const newVPath = join(dirname(vpath), name);
	const target = app.vault.getAbstractFileByPath(normalizePath(folder.getPath(vpath)));
	if (target) {
		await app.fileManager.renameFile(target, normalizePath(folder.getPath(newVPath)));
	} else {
		folder.syncStore.move(vpath, newVPath);
	}
	return true;
}

/**
 * Opens the explanation for an item a pill or banner marks, as the
 * conflict stands at that moment. Nothing opens for an item without one.
 */
export function openCaseConflictExplanation(
	app: App,
	folder: SharedFolder,
	file: TAbstractFile,
): boolean {
	const state = caseConflictState(folder, file);
	if (!state) return false;
	new CaseConflictModal(
		app,
		folder,
		file,
		explainCaseConflict(state, file, { mobile: Platform.isMobile }),
	).open();
	return true;
}
