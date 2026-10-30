import { Notice, TFile, type App } from "obsidian";
import { isDocument, type Document } from "../Document";
import type { SharedFolders } from "../SharedFolder";
import { preservedForkText } from "../merge-hsm/snapshots";

/** Captured review content and its lifecycle; the editor only presents it. */
export interface StashReviewSession {
	sourcePath: string;
	folderName: string;
	stash: string;
	current: string;
	stillHeld(): boolean;
	subscribe(listener: () => void): () => void;
	discard(): Promise<void>;
}

export function prepareStashReview(document: Document): StashReviewSession | null {
	const hsm = document.hsm, file = document.tfile;
	const fork = hsm?.state.fork;
	const current = hsm?.getReadModeText();
	if (!hsm || !file || !fork || current == null) return null;
	const stash = preservedForkText(hsm.getLocalDoc(), fork);
	if (stash === null) {
		new Notice("The stashed edits could not be opened. They have been kept.");
		return null;
	}
	const stillHeld = () => hsm.state.fork === fork;
	return {
		sourcePath: file.path, folderName: document.sharedFolder.name,
		stash, current, stillHeld,
		subscribe: listener => hsm.stateChanges.subscribe(listener),
		async discard() {
			if (!stillHeld()) throw new Error("This stash is no longer held.");
			hsm.send({ type: "DISCARD_LOCAL_FORK" });
			if (hsm.state.statePath !== "active.reading.repairing" && stillHeld()) throw new Error("The stash cannot be discarded in the note's current state. Reopen the note and try again.");
			// Wait for the durable release of the retained snapshot. The note's
			// normal sync and save paths already hold the current content.
			await hsm.awaitReadRepair();
			await hsm.awaitState(state => state !== "active.reading.repairing");
			if (hsm.hasFork()) throw new Error("The stash could not be discarded.");
		},
	};
}

export function findStashReview(app: App, folders: SharedFolders, path: string): StashReviewSession | null {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return null;
	const document = folders.lookup(path)?.getFile(file);
	return document && isDocument(document) ? prepareStashReview(document) : null;
}

interface NativeAvailablePath {
	getAvailablePath(basePath: string, extension: string): string;
}

/** The copy is durable even when releasing the original stash fails. */
export class StashCopySavedError extends Error {
	constructor(readonly file: TFile, cause: unknown) {
		super(`Saved a copy as ${file.path}, but the stash could not be discarded.${cause instanceof Error ? ` ${cause.message}` : ""}`);
	}
}

/** Use Obsidian's Duplicate operations beside the original, with the stash as content. */
export async function saveStashCopy(app: App, review: StashReviewSession): Promise<TFile> {
	if (!review.stillHeld()) throw new Error("This stash is no longer held.");
	const source = app.vault.getAbstractFileByPath(review.sourcePath);
	if (!(source instanceof TFile)) throw new Error("The original note is no longer available.");
	const base = source.path.slice(0, -(source.extension.length + 1));
	const path = (app.vault as unknown as NativeAvailablePath).getAvailablePath(base, source.extension);
	const file = await app.vault.copy(source, path);
	// Duplicate copies the current file; the review's captured stash is the copy's content.
	await app.vault.modify(file, review.stash);
	try { await review.discard(); }
	catch (error) { throw new StashCopySavedError(file, error); }
	return file;
}
