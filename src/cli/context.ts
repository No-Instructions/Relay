import { suggest } from "./suggest";
import { FileSystemAdapter } from "obsidian";
import { FeatureFlagDefaults, type FeatureFlags } from "../flags";
import type Live from "../main";
import type { MetadataHealthState } from "../MetadataHealth";
import type { RelayDebugAPI } from "../RelayDebugAPI";
import type { NamespacedSettings } from "../SettingsStorage";
import type { CliContext } from "./types";

export interface CliContextDeps {
	flags: NamespacedSettings<FeatureFlags>;
	debugging: { get(): boolean; set(on: boolean): Promise<void> };
	metadataHealth: () => { state: MetadataHealthState } | null;
	debugAPI: RelayDebugAPI;
}

/** Bind the command context to the live plugin. Reads stay live through getters. */
export function buildCliContext(plugin: Live, deps: CliContextDeps): CliContext {
	const { debugAPI } = deps;
	return {
		suggest,
		localState: {
			path: (guid) => plugin.sharedFolders.items().find((folder) => folder.guid === guid)?.path ?? null,
			remoteDeleted: (guid) => {
				const folder = plugin.sharedFolders.items().find((folder) => folder.guid === guid);
				if (folder) { folder.remote = undefined; plugin.sharedFolders.notifyListeners(); }
			},
		},
		version: plugin.version || plugin.manifest.version,
		vault: {
			get name() { return plugin.app.vault.getName(); },
			get path() {
				const adapter = plugin.app.vault.adapter;
				return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
			},
			hasFolder: (path) => plugin.app.vault.getFolderByPath(path) !== null,
			createFolder: async (path) => {
				await plugin.app.vault.createFolder(path);
			},
		},
		login: {
			get loggedIn() {
				return plugin.loginManager.loggedIn;
			},
			get user() {
				const user = plugin.loginManager.user;
				return user ? { id: user.id, name: user.name, email: user.email } : undefined;
			},
		},
		relayManager: plugin.relayManager,
		sharedFolders: {
			items: () => plugin.sharedFolders.items(),
			init: (path, remote) => plugin.sharedFolders.init(path, remote),
			clone: (path, guid, relayId) =>
				plugin.sharedFolders.clone(path, guid, relayId),
			delete: (folder) => plugin.sharedFolders.delete(folder as unknown as Parameters<typeof plugin.sharedFolders.delete>[0]),
			notifyListeners: () => plugin.sharedFolders.notifyListeners(),
		},
		folderStatus: (folder) => {
			const panel = debugAPI.getSyncPanelStatus(folder.guid);
			return {
				label: panel.snapshot.label,
				queued: panel.queue.total,
				failures: panel.snapshot.failureCount,
				actionable: panel.actionableFiles.map((file) => ({
					category: file.category,
					path: file.path,
					label: file.label,
				})),
			};
		},
		backgroundSync: {
			pause: () => plugin.backgroundSync.pause(),
			resume: () => plugin.backgroundSync.resume(),
			paused: () => plugin.backgroundSync.paused,
		},
		notes: {
			listConflicts: () => debugAPI.listAllConflicts(),
		},
		flags: {
			get: () => ({ ...FeatureFlagDefaults, ...deps.flags.get() }),
			set: (name, value) => deps.flags.update((current) => ({ ...current, [name]: value })),
		},
		debugging: {
			enabled: () => deps.debugging.get(),
			set: (on) => deps.debugging.set(on),
		},
		metadataHealth: () => {
			const health = deps.metadataHealth();
			return health ? { status: health.state.status, message: health.state.message } : null;
		},
	};
}
