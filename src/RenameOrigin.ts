import { around } from "monkey-around";
import type { Vault, TAbstractFile } from "obsidian";
import type { RenameOrigin } from "./PublicAPI";

export class RenameOrigins {
	private pending = new Map<
		string,
		{ oldPath: string; newPath: string; count: number }
	>();

	get(oldPath: string, newPath: string): RenameOrigin {
		for (const move of this.pending.values()) {
			if (oldPath === move.oldPath && newPath === move.newPath) return "relay";
			if (
				oldPath.startsWith(move.oldPath + "/") &&
				newPath === move.newPath + oldPath.slice(move.oldPath.length)
			) return "relay";
		}
		return "client";
	}

	async relayRename(
		file: TAbstractFile,
		newPath: string,
		rename: () => Promise<void>,
	): Promise<void> {
		const key = JSON.stringify([file.path, newPath]);
		const move = this.pending.get(key) ?? { oldPath: file.path, newPath, count: 0 };
		move.count++;
		this.pending.set(key, move);
		try {
			await rename();
		} finally {
			move.count--;
			if (!move.count) this.pending.delete(key);
		}
	}
}

const origins = new WeakMap<Vault, RenameOrigins>();

export function getRenameOrigins(vault: Vault): RenameOrigins {
	let tracker = origins.get(vault);
	if (!tracker) {
		tracker = new RenameOrigins();
		origins.set(vault, tracker);
	}
	return tracker;
}

/** FileManager may resolve before a queued Vault.rename has run. */
export async function renameFromRelay(
	vault: Vault,
	file: TAbstractFile,
	newPath: string,
	renameFile: () => Promise<void>,
): Promise<void> {
	if (file.path === newPath) return renameFile();

	let complete!: () => void;
	let fail!: (error: unknown) => void;
	const renamed = new Promise<void>((resolve, reject) => {
		complete = resolve;
		fail = reject;
	});
	let started = false;
	const unpatch = around(vault, {
		rename: (next) => function (this: Vault, target: TAbstractFile, path: string) {
			if (target !== file || path !== newPath || started) {
				return next.call(this, target, path);
			}

			started = true;
			const operation = getRenameOrigins(vault).relayRename(target, path, () =>
				next.call(this, target, path),
			);
			operation.then(complete, fail);
			return operation;
		},
	});
	try {
		await Promise.all([Promise.resolve().then(renameFile), renamed]);
	} finally {
		unpatch();
	}
}
