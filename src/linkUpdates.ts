import type { Vault } from "obsidian";
import { curryLog } from "./debug";
import { getPatcher } from "./Patcher";

/** Obsidian's preference for repairing internal links on every rename. */
const LINK_UPDATE_PREFERENCE = "alwaysUpdateLinks";

type ConfigurableVault = Vault & {
	config?: Record<string, unknown>;
	getConfig?: (key: string) => unknown;
	setConfig?: (key: string, value: unknown) => void;
	saveConfig?: () => Promise<void> | void;
};

interface LinkUpdateOverride {
	unpatch: () => void;
	depth: number;
	reads: number;
}

const linkUpdateOverrides = new WeakMap<Vault, LinkUpdateOverride>();

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
 * This chooses automatic repair as the default for the user's own renames,
 * including in vaults with no shared folder. It changes Obsidian's stored
 * preference and survives plugin removal. An explicit choice is preserved.
 * The stored on value also avoids depending on the temporary reader override
 * on unverified hosts. On the verified desktop host, peer renames already
 * repair links through that override, including links outside shared folders.
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
 * The file manager repairs links after moving the file and asks when the
 * preference is off. Answer its reads as on until all overlapping server
 * renames settle, without writing the vault's configuration. The stored
 * preference still governs this user's own renames outside that window.
 *
 * Prompt-free repair with this override was observed on Obsidian 1.13.4
 * desktop in an end-to-end check. The private API is assumed to read the
 * preference before renameFile settles; other host versions are unverified.
 * Warn if no preference read occurs during a call. With overlapping calls,
 * reads are counted for the vault; they cannot be attributed to one rename.
 */
export async function withLinkUpdatesOn<T>(
	vault: Vault,
	run: () => Promise<T>,
): Promise<T> {
	const configurable = vault as ConfigurableVault;
	let state = linkUpdateOverrides.get(vault);
	if (!state) {
		const original = configurable.getConfig;
		if (typeof original !== "function") return run();
		if (original.call(vault, LINK_UPDATE_PREFERENCE) === true) return run();
		const installed: LinkUpdateOverride = {
			unpatch: () => {},
			depth: 0,
			reads: 0,
		};
		installed.unpatch = getPatcher().patch(configurable, {
			getConfig: (next: (key: string) => unknown) => function (this: unknown, key: string) {
				if (key === LINK_UPDATE_PREFERENCE) {
					installed.reads++;
					return true;
				}
				return next.call(this, key);
			},
		});
		linkUpdateOverrides.set(vault, installed);
		state = installed;
	}
	state.depth++;
	const readsAtStart = state.reads;
	try {
		return await run();
	} finally {
		if (--state.depth === 0) {
			state.unpatch();
			linkUpdateOverrides.delete(vault);
		}
		if (state.reads === readsAtStart) {
			curryLog("[LinkUpdates]", "warn")(
				"No link-update preference read observed during rename; the file may have no referrers or the host may read outside the rename promise",
			);
		}
	}
}
