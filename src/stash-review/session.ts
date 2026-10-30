import { TFile, type App } from "obsidian";
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
	discard(): Promise<void>;
}

export function prepareStashReview(document: Document): StashReviewSession | null {
	const hsm = document.hsm, file = document.tfile;
	const fork = hsm?.state.fork;
	const remote = hsm?.getRemoteDoc();
	if (!hsm || !file || !fork || !remote) return null;
	const stash = preservedForkText(hsm.getLocalDoc(), fork);
	if (stash === null) { hsm.send({ type: "DISCARD_LOCAL_FORK" }); return null; }
	const stillHeld = () => hsm.state.fork === fork;
	return {
		sourcePath: file.path, folderName: document.sharedFolder.name,
		stash, current: remote.getText("contents").toString(), stillHeld,
		async discard() {
			if (!stillHeld()) throw new Error("This stash is no longer held.");
			hsm.send({ type: "DISCARD_LOCAL_FORK" });
			if (hsm.state.statePath !== "active.reading.repairing" && stillHeld()) throw new Error("The note must be connected before its stash can be discarded.");
			// The fork clears before the local document finishes rebuilding.
			// Complete the repair and save its content before opening the note,
			// so native Reading view cannot render the old file from disk.
			await hsm.awaitReadRepair();
			await hsm.awaitState(state => state !== "active.reading.repairing");
			if (hsm.hasFork()) throw new Error("The stash could not be discarded.");
			await document.save();
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
	await review.discard();
	return file;
}
