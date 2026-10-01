import { TFolder, type TAbstractFile } from "obsidian";
import { basename, dirname } from "path-browserify";
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
	effect: CaseConflictEffect;
	/**
	 * Another spelling of that path, named as the user sees it. When there are
	 * several, the first in sort order stands for them all, preferring one
	 * this machine keeps off its disk.
	 */
	other: string;
	label: string;
}

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
		// name for this item, not a second item: every disk holds it once.
		const identity = sharedFolder.syncStore.get(path);
		const variants = sharedFolder.syncStore
			.committedCaseVariants(path)
			.filter(
				(variant) =>
					identity === undefined ||
					sharedFolder.syncStore.getCommittedMeta(variant)?.id !== identity,
			);
		if (variants.length === 0) continue;
		// A variant beside the path is named by its name alone; one under a
		// differently spelled folder by its path in the shared folder.
		const name = (variant: string) =>
			dirname(variant) === dirname(path) ? basename(variant) : variant.slice(1);
		const hidden = variants.filter((variant) => held.holdsWithin("materialize", variant));
		const other = (hidden.length > 0 ? hidden : variants).map(name).sort()[0];
		const effect: CaseConflictEffect =
			held.get("publish", own) || held.get("publish", path)
				? "unsynced"
				: hidden.length > 0
					? "hidden-here"
					: "elsewhere";
		const kind = file instanceof TFolder ? "folder" : "file";
		const folder = basename(path);
		const label = {
			elsewhere: path === own
				? `This ${kind} may not be visible on some machines because it has a case conflict with ${other}`
				: `This ${kind} may not be visible on some machines because the folder ${folder} has a case conflict with ${other}`,
			"hidden-here": path === own
				? `${other} isn't shown on this machine because it has a case conflict with this ${kind}`
				: `The folder ${other} isn't shown on this machine because it has a case conflict with the folder ${folder}`,
			unsynced: path === own
				? `This ${kind} isn't synced because it has a case conflict with ${other}`
				: `This ${kind} isn't synced because the folder ${folder} has a case conflict with ${other}`,
		}[effect];
		return { path, own: path === own, effect, other, label };
	}
	return null;
}
