import type { Vault } from "obsidian";

/** Obsidian's preference for repairing internal links on every rename. */
const LINK_UPDATE_PREFERENCE = "alwaysUpdateLinks";

type ConfigurableVault = Vault & {
	config?: Record<string, unknown>;
	getConfig?: (key: string) => unknown;
	setConfig?: (key: string, value: unknown) => void;
	saveConfig?: () => Promise<void> | void;
};

export type LinkUpdatePreference = "on" | "off" | "unset" | "unknown";

/** Whether Obsidian repairs internal links on every rename without asking. */
export function linkUpdatesAreOn(vault: Vault): boolean {
	const configurable = vault as ConfigurableVault;
	return configurable.getConfig?.(LINK_UPDATE_PREFERENCE) === true;
}

/**
 * How the vault stands on automatic link repair. Obsidian keeps only the
 * preferences a user chose in its loaded config object and answers the
 * default for every other key, so the object alone separates a vault that
 * never chose from one that turned link repair off.
 */
export function linkUpdatePreference(vault: Vault): LinkUpdatePreference {
	const configurable = vault as ConfigurableVault;
	const config = configurable.config;
	if (!config || typeof config !== "object" || !configurable.getConfig) {
		return "unknown";
	}
	if (!Object.prototype.hasOwnProperty.call(config, LINK_UPDATE_PREFERENCE)) {
		return "unset";
	}
	return linkUpdatesAreOn(vault) ? "on" : "off";
}

/**
 * Turn automatic link repair on for a vault that never chose.
 *
 * A rename that arrives from a peer repairs links inside the shared folder
 * through sync, but links from this vault's other notes are repaired only
 * by Obsidian, and only when the vault always updates links. Left unset,
 * Obsidian asks at every rename that has referrers, and a prompt raised by
 * a rename this user did not make is one nobody expects. Turning the
 * preference on is what the prompt's own "Always update" answer does. A
 * vault that turned it off keeps that choice; peer renames there move
 * files without touching links and never prompt.
 *
 * Returns whether the preference is on afterwards.
 */
export async function ensureLinkUpdatesOn(vault: Vault): Promise<boolean> {
	const preference = linkUpdatePreference(vault);
	if (preference !== "unset") return preference === "on";
	const configurable = vault as ConfigurableVault;
	if (!configurable.setConfig) return false;
	configurable.setConfig(LINK_UPDATE_PREFERENCE, true);
	await configurable.saveConfig?.();
	return linkUpdatesAreOn(vault);
}
