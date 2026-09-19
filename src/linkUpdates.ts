import type { Vault } from "obsidian";

/** Obsidian's preference for repairing internal links on every rename. */
const LINK_UPDATE_PREFERENCE = "alwaysUpdateLinks";

type ConfigurableVault = Vault & {
	getConfig?: (key: string) => unknown;
	setConfig?: (key: string, value: unknown) => void;
	saveConfig?: () => Promise<void> | void;
};

/** Whether Obsidian repairs internal links on every rename without asking. */
export function linkUpdatesAreOn(vault: Vault): boolean {
	const configurable = vault as ConfigurableVault;
	return configurable.getConfig?.(LINK_UPDATE_PREFERENCE) === true;
}

/**
 * Turn Obsidian's automatic internal-link repair on.
 *
 * A rename that arrives from a peer repairs links inside the shared folder
 * through sync, but links from this vault's other notes are repaired only
 * by Obsidian, and only when the vault always updates links. Left unset,
 * Obsidian asks at every rename that has referrers, and a prompt raised by
 * a rename this user did not make is one nobody expects. Relay turns the
 * preference on; a vault that opts out keeps whatever it has, and peer
 * renames then move files without touching links.
 *
 * Returns whether the preference is on afterwards.
 */
export async function ensureLinkUpdatesOn(vault: Vault): Promise<boolean> {
	if (linkUpdatesAreOn(vault)) return true;
	const configurable = vault as ConfigurableVault;
	if (!configurable.setConfig) return false;
	configurable.setConfig(LINK_UPDATE_PREFERENCE, true);
	await configurable.saveConfig?.();
	return linkUpdatesAreOn(vault);
}
