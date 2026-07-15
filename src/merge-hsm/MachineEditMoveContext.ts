import type { MachineEditAuthority } from "../folder-hsm/types";

export interface MoveAuthorityFolder {
	folderHSM: {
		classifyMoveAuthority(from: string, to: string): MachineEditAuthority;
	} | null;
	getVirtualPath(path: string): string;
}

/** Null means the FolderHSM construction-time feature boundary is off. */
export function classifyFolderMoveAuthority(
	fromFolder: MoveAuthorityFolder | null | undefined,
	toFolder: MoveAuthorityFolder | null | undefined,
	oldPath: string,
	newPath: string,
): MachineEditAuthority | null {
	if (!fromFolder?.folderHSM || fromFolder !== toFolder) return null;
	try {
		return fromFolder.folderHSM.classifyMoveAuthority(
			fromFolder.getVirtualPath(oldPath),
			fromFolder.getVirtualPath(newPath),
		);
	} catch {
		return "unknown";
	}
}

/**
 * Call-scoped move provenance for Obsidian's rename -> link-repair cascade.
 *
 * This state is local and ephemeral. It is never serialized or replicated.
 * Multiple active rename calls are deliberately ambiguous because JavaScript
 * promise continuations can interleave without an async-local context.
 */
export class MachineEditMoveContext {
	private readonly active = new Map<symbol, MachineEditAuthority>();

	current(): MachineEditAuthority | null {
		if (this.active.size === 0) return null;
		if (this.active.size > 1) return "unknown";
		return this.active.values().next().value ?? "unknown";
	}

	async run<T>(
		authority: MachineEditAuthority,
		fn: () => T | Promise<T>,
	): Promise<T> {
		const token = Symbol("machine-edit-move");
		this.active.set(token, authority);
		try {
			return await fn();
		} finally {
			this.active.delete(token);
		}
	}
}

/** Shared call-scoped provenance observed by vault and CM6 integrations. */
export const machineEditMoveContext = new MachineEditMoveContext();
