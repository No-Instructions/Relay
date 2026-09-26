import type { DataAdapter, TAbstractFile, Vault } from "obsidian";
import { dirname, join, sep } from "path-browserify";

export interface OccupiedVaultPath {
	path: string;
	kind: "case-alias" | "unindexed" | "indexed";
}

function pathPrefixes(root: string, target: string): string[] {
	if (!target.startsWith(root + sep)) {
		throw new Error(`Path is not under the shared folder: ${target}`);
	}
	const parts = target.slice(root.length + 1).split(sep);
	const prefixes: string[] = [root];
	let prefix = root;
	for (const part of parts) {
		prefix = join(prefix, part);
		prefixes.push(prefix);
	}
	return prefixes;
}

/** Detect a physical path reached through different casing, including an ancestor. */
export async function findCaseAliasOnDisk(
	adapter: DataAdapter,
	root: string,
	target: string,
): Promise<string | null> {
	for (const prefix of pathPrefixes(root, target)) {
		if (!(await adapter.exists(prefix))) return null;
		if (!(await adapter.exists(prefix, true))) return prefix;
	}
	return null;
}

/**
 * A remote create or rename may use a spelling absent from Obsidian's exact
 * path index while the filesystem resolves it to an existing object. Leave
 * that object alone. A rename of the same file that only changes casing is
 * delegated to Obsidian's FileManager, which handles that operation.
 */
export async function findOccupiedVaultPath(
	vault: Pick<Vault, "adapter" | "getAbstractFileByPath">,
	root: string,
	target: string,
	source?: TAbstractFile,
): Promise<OccupiedVaultPath | null> {
	const prefixes = pathPrefixes(root, target);
	const caseRename =
		source !== undefined &&
		source.path !== target &&
		dirname(source.path) === dirname(target) &&
		source.path.toLowerCase() === target.toLowerCase();
	for (const prefix of prefixes) {
		const final = prefix === target;
		const indexed = vault.getAbstractFileByPath(prefix);
		if (final && indexed && indexed !== source) {
			return { path: prefix, kind: "indexed" };
		}
		if (!(await vault.adapter.exists(prefix))) {
			return indexed ? { path: prefix, kind: "indexed" } : null;
		}
		const exact = await vault.adapter.exists(prefix, true);
		if (!exact) {
			if (caseRename && final) continue;
			return { path: prefix, kind: "case-alias" };
		}
		// An exact parent can be on disk before Obsidian indexes the directory.
		if (!indexed && final) return { path: prefix, kind: "unindexed" };
	}
	return null;
}
