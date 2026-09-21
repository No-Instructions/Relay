import type { SyncParticipant } from "../background-sync/SyncParticipant";
import { FeatureFlagDefaults, type FeatureFlags } from "../flags";
import type Live from "../main";
import type { MetadataHealthState } from "../MetadataHealth";
import type { RelayDebugAPI } from "../RelayDebugAPI";
import type { NamespacedSettings } from "../SettingsStorage";
import type { CliContext, CliRelayManager } from "./types";

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
		version: plugin.version || plugin.manifest.version,
		vault: {
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
		relayManager: plugin.relayManager as unknown as CliRelayManager,
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
		timers: plugin.timeProvider,
		notes: {
			listConflicts: () => debugAPI.listAllConflicts(),
			conflictInfo: (path) => debugAPI.getConflictInfo(path),
			decideBlock: (path, conflictId, blockId, decision) =>
				debugAPI.decideConflictBlock(path, conflictId, blockId, decision),
			resolveContents: (path, conflictId, contents) =>
				debugAPI.resolveConflict(path, conflictId, contents),
			state: async (path) => {
				const snapshot = await debugAPI.getHsmStateSnapshot(path);
				return {
					statePath: snapshot.statePath,
					hasConflict: snapshot.hasConflict,
					hasLCA: snapshot.hasLCA,
					diskMatchesIdb: snapshot.diskMatchesIdb,
				};
			},
			// The machine requests a background sync as it settles; join that
			// work so the answer can say whether the server has the result.
			converge: async (path) => {
				const lookup = debugAPI.lookupDocument(path);
				if (!lookup) return false;
				await lookup.folder.backgroundSync.enqueueSync(
					lookup.doc as unknown as SyncParticipant,
				);
				return true;
			},
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
