"use strict";

import type { LocalMove } from "./PublicAPI";

/**
 * What a shared folder decided about one vault rename: the move this client
 * made, none when the rename moves nothing (no path change, or a shared
 * folder's own rename reaching a descendant), or null when the rename is
 * Relay's own work: a rejection it is restoring, or the echo of a restore or
 * a server move.
 */
export type RenameDecision = LocalMove[] | null;

export function localMoves(
	oldPath: string,
	newPath: string,
	kind: LocalMove["kind"],
): LocalMove[] {
	return [{ oldPath, newPath, kind }];
}

/**
 * A rename between two shared folders is one move, made of a removal from
 * the source and an addition to the destination. It is a local move only
 * when neither half is Relay's own work.
 */
export function crossFolderMoves(
	from: RenameDecision,
	to: RenameDecision,
): LocalMove[] {
	if (from === null || to === null) return [];

	return from.length > 0 ? from : to;
}

/** A vault file or folder, as far as descendant tracking needs it. */
export interface RenamedNode {
	path: string;
	children?: RenamedNode[];
}

/**
 * Descendants of folder renames, awaiting their own vault rename. Obsidian
 * renames a folder first and each descendant afterwards, one callback each;
 * a descendant's move is local exactly when its folder's was.
 */
export type PendingDescendants = Map<RenamedNode, { oldPath: string; local: boolean }>;

/**
 * Record a renamed folder's descendants, during the folder's own rename
 * callback. A descendant usually still carries its old path then, but one may
 * already carry its new path (Obsidian can re-index a folder note first), so
 * each expected old path is derived from the folder's.
 */
export function expectDescendants(
	pending: PendingDescendants,
	folder: RenamedNode,
	oldPath: string,
	local: boolean,
): void {
	const relative = (path: string): string | undefined => {
		for (const prefix of [folder.path, oldPath]) {
			if (path.startsWith(prefix + "/")) return path.slice(prefix.length);
		}
		return undefined;
	};
	const walk = (node: RenamedNode): void => {
		for (const child of node.children ?? []) {
			const rest = relative(child.path);
			if (rest !== undefined) pending.set(child, { oldPath: oldPath + rest, local });
			walk(child);
		}
	};
	walk(folder);
}

/** Whether a rename belongs to a folder rename and, if so, whether that was local. */
export function takeDescendant(
	pending: PendingDescendants,
	file: RenamedNode,
	oldPath: string,
): boolean | undefined {
	const expected = pending.get(file);
	if (expected?.oldPath !== oldPath) return undefined;

	pending.delete(file);
	return expected.local;
}
