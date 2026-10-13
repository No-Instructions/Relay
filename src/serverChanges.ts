import type { Vault } from "obsidian";

/**
 * Server changes a vault is applying right now. A move Obsidian carries out
 * for a server rename is one, together with the link repairs it runs for
 * it, which reach notes in every shared folder of the vault. A machine edit
 * Obsidian makes in that window derives from the server's change, and the
 * vault where the change was made publishes the same edit.
 */
const serverChangesInFlight = new WeakMap<Vault, number>();

/**
 * Mark the start of applying a server change to the vault. The returned
 * function marks its end; calling it again does nothing.
 */
export function beginServerChange(vault: Vault): () => void {
	serverChangesInFlight.set(vault, (serverChangesInFlight.get(vault) ?? 0) + 1);
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		serverChangesInFlight.set(vault, (serverChangesInFlight.get(vault) ?? 1) - 1);
	};
}

/** Whether a server change is being applied to the vault. */
export function applyingServerChange(vault: Vault): boolean {
	return (serverChangesInFlight.get(vault) ?? 0) > 0;
}
