import { sep } from "path-browserify";
import type { Meta } from "./SyncTypes";
import {
	isRelayIgnoreMarkerPath,
	normalizeVirtualPath,
} from "./privateFolderIgnore";

export type RenameSyncAction = "ignore" | "remove-sync-metadata" | "upload" | "move-sync-metadata";

export interface IgnoredRemoteEntry {
	path: string;
	guid: string;
	type: string;
}

export function isIgnoredVirtualPath(
	vpath: string,
	ignoredRoots: Iterable<string>,
): boolean {
	if (isRelayIgnoreMarkerPath(vpath)) return true;
	return findIgnoredRootForVirtualPath(vpath, ignoredRoots) !== null;
}

export function isIgnoredVaultPath(
	vaultPath: string,
	sharedFolderPath: string,
	ignoredRoots: Iterable<string>,
): boolean {
	if (!isContainedVaultPath(vaultPath, sharedFolderPath)) return false;
	return isIgnoredVirtualPath(
		vaultPath.slice(sharedFolderPath.length + sep.length),
		ignoredRoots,
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
	ignoredRoots: Iterable<string>,
): IgnoredRemoteEntry[] {
	return Array.from(entries)
		.filter(([path]) => isIgnoredVirtualPath(path, ignoredRoots))
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

export function findIgnoredRootForVirtualPath(
	vpath: string,
	ignoredRoots: Iterable<string>,
): string | null {
	const normalizedPath = normalizeVirtualPath(vpath);
	const roots = Array.from(ignoredRoots)
		.map((root) => normalizeVirtualPath(root))
		.sort((a, b) => b.length - a.length);

	for (const root of roots) {
		if (!root) {
			return root;
		}
		if (normalizedPath === root || normalizedPath.startsWith(root + "/")) {
			return root;
		}
	}
	return null;
}
