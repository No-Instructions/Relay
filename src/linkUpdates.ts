import type { Vault } from "obsidian";
import { curryLog } from "./debug";

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
 * Preference failures are logged so they cannot prevent the plugin loading.
 * Returns whether the preference was confirmed on without an error.
 */
export async function ensureLinkUpdatesOn(vault: Vault): Promise<boolean> {
	try {
		const preference = linkUpdatePreference(vault);
		if (preference !== "unset") return preference === "on";
		const configurable = vault as ConfigurableVault;
		if (!configurable.setConfig) return false;
		configurable.setConfig(LINK_UPDATE_PREFERENCE, true);
		await configurable.saveConfig?.();
		return linkUpdatesAreOn(vault);
	} catch (error) {
		curryLog("[LinkUpdates]", "warn")(
			"Unable to enable automatic link updates", error,
		);
		return false;
	}
}

/**
 * Run a rename with automatic link repair answered as on.
 *
 * The file manager's rename is the vault rename plus a link-update step
 * that reads the preference once, after the move, and asks the user when
 * it is off. A rename that arrived from a peer should repair links and
 * never ask: the preference governs this user's own renames. Answer that
 * one read with "on" for the duration of the call, in memory only, so
 * nothing is written to the vault's configuration and nothing is left
 * behind if the process ends mid-rename.
 */
export async function withLinkUpdatesOn<T>(
	vault: Vault,
	run: () => Promise<T>,
): Promise<T> {
	if (linkUpdatesAreOn(vault)) return run();
	const configurable = vault as ConfigurableVault;
	const original = configurable.getConfig;
	if (typeof original !== "function") return run();
	const hadOwnReader = Object.prototype.hasOwnProperty.call(vault, "getConfig");
	configurable.getConfig = function (this: unknown, key: string) {
		if (key === LINK_UPDATE_PREFERENCE) return true;
		return original.call(this, key);
	};
	try {
		return await run();
	} finally {
		if (hadOwnReader) configurable.getConfig = original;
		else delete configurable.getConfig;
	}
}
