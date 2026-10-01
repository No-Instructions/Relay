import { TFolder, type TAbstractFile } from "obsidian";
import { basename, dirname } from "path-browserify";
import { canonicalSpelling } from "./casePaths";
import type { SharedFolder } from "./SharedFolder";

/**
 * What the conflict does on this machine:
 * - `elsewhere`: this machine holds every spelling; a case-insensitive one
 *   holds only one of them.
 * - `hidden-here`: this machine keeps the other spelling off its disk.
 * - `unsynced`: this machine keeps this item out of the shared folder.
 */
export type CaseConflictEffect = "elsewhere" | "hidden-here" | "unsynced";

export interface CaseConflictState {
	/** The virtual path whose spelling conflicts: the item's own, or a folder above it. */
	path: string;
	/** Whether the conflicting path is the item itself rather than a folder above it. */
	own: boolean;
	/** What the conflicting path is. */
	kind: "file" | "folder";
	effect: CaseConflictEffect;
	/**
	 * Another spelling of that path, named as the user sees it. When there are
	 * several, the first in sort order stands for them all, preferring one
	 * this machine keeps off its disk.
	 */
	other: string;
	/** That spelling's virtual path. */
	otherPath: string;
	/** The one line the banner says and the pill's tooltip repeats. */
	label: string;
}

const isNote = (file: TAbstractFile) =>
	!(file instanceof TFolder) && file.path.toLowerCase().endsWith(".md");

/** What to call a file in a sentence: a note when it is one. */
const itemWord = (kind: "file" | "folder", note: boolean) =>
	kind === "folder" ? "folder" : note ? "note" : "file";

/**
 * Shared decision for the file explorer and the open-file banner. An item is
 * marked by its own conflict first, else by the nearest folder above it
 * whose spelling conflicts.
 */
export function caseConflictState(
	sharedFolder: SharedFolder,
	file: TAbstractFile,
): CaseConflictState | null {
	if (!sharedFolder.ready || !sharedFolder.checkPath(file.path)) return null;
	const own = sharedFolder.getVirtualPath(file.path);
	const held = sharedFolder.heldCasePaths;
	for (let path = own; path !== "/"; path = dirname(path)) {
		// Another path that membership keeps for the same identity is a second
		// name for this item, not a second item: every disk holds it once. So
		// is this path in another composition: Obsidian reports composed
		// paths for a name another device published decomposed.
		const identity = sharedFolder.syncStore.get(path);
		const canonical = canonicalSpelling(path);
		const variants = sharedFolder.syncStore
			.committedCaseVariants(path)
			.filter(
				(variant) =>
					canonicalSpelling(variant) !== canonical &&
					(identity === undefined ||
						sharedFolder.syncStore.getCommittedMeta(variant)?.id !== identity),
			);
		if (variants.length === 0) continue;
		// A variant beside the path is named by its name alone; one under a
		// differently spelled folder by its path in the shared folder.
		const name = (variant: string) =>
			dirname(variant) === dirname(path) ? basename(variant) : variant.slice(1);
		const hidden = variants.filter((variant) => held.holdsWithin("materialize", variant));
		const otherPath = (hidden.length > 0 ? hidden : variants)
			.sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0))[0];
		const other = name(otherPath);
		const effect: CaseConflictEffect =
			held.get("publish", own) || held.get("publish", path)
				? "unsynced"
				: hidden.length > 0
					? "hidden-here"
					: "elsewhere";
		const isOwn = path === own;
		const kind = isOwn && !(file instanceof TFolder) ? "file" : "folder";
		// The item the conflict is about, and the open item when it sits inside a conflicting folder.
		const item = itemWord(kind, isOwn && isNote(file));
		const self = itemWord(file instanceof TFolder ? "folder" : "file", isNote(file));
		const beside = dirname(otherPath) === dirname(path);
		const twin =
			effect === "elsewhere"
				? `another ${item}${isOwn && kind === "file" && beside ? " in this folder" : ""}`
				: `a different ${item} on the server`;
		const label = isOwn
			? `This ${item} has the same name as ${twin}`
			: `This ${self}'s folder has the same name as ${twin}`;
		return { path, own: isOwn, kind, effect, other, otherPath, label };
	}
	return null;
}

/** Runs of a name, marking the characters that differ from the other spelling. */
export function caseDiff(name: string, against: string): { text: string; differs: boolean }[] {
	const a = [...canonicalSpelling(name)];
	const b = [...canonicalSpelling(against)];
	const runs: { text: string; differs: boolean }[] = [];
	a.forEach((char, i) => {
		const differs = a.length === b.length && char !== b[i];
		const last = runs[runs.length - 1];
		if (last && last.differs === differs) last.text += char;
		else runs.push({ text: char, differs });
	});
	return runs;
}

export interface CaseConflictRow {
	/** One spelling, and the other to mark the letters that differ. */
	name: string;
	against: string;
	/** Its virtual path, the target of a rename. */
	path: string;
	/** Where it is on this machine. */
	status: string;
	/** This spelling is the folder the open item sits in. */
	containsThis: boolean;
}

/**
 * What the "more info" modal says: both spellings and where each one is,
 * why they conflict, the fix, and a rename for either. It never names the
 * open file beyond the spelling itself.
 */
export interface CaseConflictExplanation {
	title: string;
	rows: CaseConflictRow[];
	body: string;
	fix: string;
	docs: { label: string; url: string };
	/** Rename either spelling; the first is this machine's. */
	actions: { label: string; path: string; kind: "file" | "folder" }[];
}

const DOCS_URL = "https://docs.relay.md/";

export function explainCaseConflict(
	state: CaseConflictState,
	file: TAbstractFile,
	options: { mobile: boolean },
): CaseConflictExplanation {
	const { path, own, kind, effect, other, otherPath } = state;
	const item = itemWord(kind, own && isNote(file));
	const plural = `${item}s`;
	const here = options.mobile ? "On this device" : "On this computer";
	const subject = basename(path);
	const rows: CaseConflictRow[] = [
		{
			name: subject,
			against: other,
			path,
			status: effect === "unsynced" ? "Not syncing" : here,
			containsThis: !own,
		},
		{
			name: other,
			against: subject,
			path: otherPath,
			status: effect === "elsewhere" ? here : "Not downloaded",
			containsThis: false,
		},
	];
	// A machine holding both spellings is case-sensitive; one that holds back a
	// spelling, or keeps its own out of the folder, could not store both.
	const body =
		effect === "elsewhere"
			? `These names differ only in capitalization. Some file systems are case-insensitive (often on Windows or macOS), so your collaborators may not be able to download both ${plural}.`
			: `These names differ only in capitalization. Your file system is case-insensitive, so it can't store both of these ${plural}.`;
	return {
		title: "Name conflict",
		rows,
		body,
		fix: `To fix it, rename either ${item}.`,
		docs: { label: "Learn more about name conflicts", url: DOCS_URL },
		actions: [
			{ label: `Rename this ${item}`, path, kind },
			{ label: `Rename ${other}`, path: otherPath, kind },
		],
	};
}

/** Opens the explanation of a case conflict for an item in a shared folder. */
export type ExplainCaseConflict = (folder: SharedFolder, file: TAbstractFile) => void;
