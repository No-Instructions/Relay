import { sep } from "path-browserify";
import type { Meta } from "./SyncTypes";
import {
	DEFAULT_IGNORED_FOLDER_NAME,
	pathContainsIgnoredFolderSegment,
} from "./privateFolderIgnore";

export type RenameSyncAction = "ignore" | "remove-sync-metadata" | "upload" | "move-sync-metadata";

export interface IgnoredRemoteEntry {
	path: string;
	guid: string;
	type: string;
}

export function isIgnoredVirtualPath(
	vpath: string,
	ignoredFolderName = DEFAULT_IGNORED_FOLDER_NAME,
): boolean {
	return pathContainsIgnoredFolderSegment(vpath, ignoredFolderName);
}

export function isIgnoredVaultPath(
	vaultPath: string,
	sharedFolderPath: string,
	ignoredFolderName = DEFAULT_IGNORED_FOLDER_NAME,
): boolean {
	if (!isContainedVaultPath(vaultPath, sharedFolderPath)) return false;
	return isIgnoredVirtualPath(
		vaultPath.slice(sharedFolderPath.length + sep.length),
		ignoredFolderName,
	);
}

export function isContainedVaultPath(
	vaultPath: string,
	sharedFolderPath: string,
): boolean {
	return vaultPath.startsWith(sharedFolderPath + sep);
}

export function classifyRenameSyncAction(input: {
	oldInSharedFolder: boolean;
	oldIgnored: boolean;
	newInSharedFolder: boolean;
	newIgnored: boolean;
}): RenameSyncAction {
	const oldSyncable = input.oldInSharedFolder && !input.oldIgnored;
	const newSyncable = input.newInSharedFolder && !input.newIgnored;

	if (oldSyncable && newSyncable) return "move-sync-metadata";
	if (oldSyncable && !newSyncable) return "remove-sync-metadata";
	if (!oldSyncable && newSyncable) return "upload";
	return "ignore";
}

export function collectIgnoredRemoteEntries(
	entries: Iterable<[string, Meta]>,
	ignoredFolderName = DEFAULT_IGNORED_FOLDER_NAME,
): IgnoredRemoteEntry[] {
	return Array.from(entries)
		.filter(([path]) => isIgnoredVirtualPath(path, ignoredFolderName))
		.map(([path, meta]) => ({
			path,
			guid: meta.id,
			type: meta.type,
		}))
		.sort(compareDeepestPathFirst);
}

export function compareDeepestPathFirst(
	a: Pick<IgnoredRemoteEntry, "path">,
	b: Pick<IgnoredRemoteEntry, "path">,
): number {
	const aDepth = a.path.split(/[\\/]+/).filter(Boolean).length;
	const bDepth = b.path.split(/[\\/]+/).filter(Boolean).length;
	if (aDepth !== bDepth) return bDepth - aDepth;
	return a.path.localeCompare(b.path);
}
