import { SERVER_TREE, relayRow, RELAY_OPTION, REMOTE_FOLDER_OPTION } from "./server";
import { FeatureFlagSchema, isKeyOfFeatureFlags, type FeatureFlags } from "../flags";
import type { Relay, RemoteSharedFolder } from "../Relay";
import { SyncSettingsManager, type SyncFlags } from "../SyncSettings";
import { kv, table, markdownText } from "./format";
import { flattenCommands } from "./tree";
import { flag, folderPath, optional, required } from "./params";
import {
	pick,
	resolveRelay,
	resolveRemoteFolder,
	resolveSharedFolder,
	rolesOnFolder,
	rolesOnRelay,
} from "./resolve";
import {
	CliError,
	type CliCommand,
	type CliOption,
	type CliContext,
	type CliResult,
	type CliSharedFolder,
} from "./types";

const FOLDER_OPTION: Record<string, CliOption> = {
	folder: { value: "<path|name|guid>", description: "Local folder", required: true },
};
const FOLDER_FILTER = { folder: { ...FOLDER_OPTION.folder, description: "Local folder (default: all)", required: false } };
/** File-type categories come from the sync settings schema, never a local list. */
const SYNC_CATEGORIES: (keyof SyncFlags)[] = SyncSettingsManager.categories.map((c) => c.key);

function inVault(ctx: CliContext, remote: RemoteSharedFolder): CliSharedFolder | undefined {
	return ctx.sharedFolders.items().find((folder) => folder.guid === remote.guid);
}

function folderRow(ctx: CliContext, folder: CliSharedFolder) {
	const status = ctx.folderStatus(folder);
	return {
		path: folder.path,
		guid: folder.guid,
		relay: folder.remote?.relay?.name ?? null,
		relayGuid: folder.remote?.relay?.guid ?? null,
		name: folder.remote?.name ?? null,
		private: folder.remote?.private ?? null,
		connected: folder.connected,
		status: status.label,
		queued: status.queued,
		failures: status.failures,
		actionable: status.actionable,
	};
}

function relayLabel(folder: CliSharedFolder): string {
	return folder.remote?.relay?.name ?? "tracked";
}

function fileTypes(folder: CliSharedFolder) {
	const categories = folder.syncSettingsManager.getCategories();
	return SYNC_CATEGORIES.map((key) => {
		const category = categories[key];
		return {
			key,
			name: category.name,
			enabled: category.enabled,
			requiresStorage: category.requiresStorage,
			canToggle: category.canToggle,
		};
	});
}

function noStorage(ctx: CliContext, folder: CliSharedFolder): boolean {
	const relayGuid = folder.remote?.relay?.guid;
	if (!relayGuid) return false;
	const relay = ctx.relayManager.relays.values().find((r) => r.guid === relayGuid);
	return relay?.storageQuota?.quota === 0;
}

function requireDisjointFolder(ctx: CliContext, path: string, reused?: CliSharedFolder): void {
	const conflicts = ctx.sharedFolders.items().filter((folder) => {
		if (folder === reused) return false;
		const existing = folderPath(folder.path);
		return path === existing || path.startsWith(`${existing}/`) || existing.startsWith(`${path}/`);
	});
	if (conflicts.length > 0) {
		throw new CliError("nested_folder", `${path} overlaps an existing Shared Folder`, {
			candidates: conflicts.map((folder) => ({ name: folder.path, guid: folder.guid })),
		});
	}
}

async function ensureVaultFolder(ctx: CliContext, path: string): Promise<void> {
	if (!ctx.vault.hasFolder(path)) await ctx.vault.createFolder(path);
}

async function attachRemote(
	ctx: CliContext,
	folder: CliSharedFolder,
	relay: Relay,
	isPrivate: boolean,
): Promise<RemoteSharedFolder> {
	const name = folder.path.split("/").pop() || folder.path;
	const existing = ctx.relayManager.remoteFolders.values().find((remote) =>
		remote.guid === folder.guid && remote.relayId === relay.id,
	);
	const remote =
		existing ?? (await ctx.relayManager.createRemoteFolder(folder.guid, name, relay, isPrivate));
	folder.remote = remote;
	ctx.sharedFolders.notifyListeners();
	// Attachment is complete; connection may wait for replay or the network.
	void folder.connect().catch((error) => console.warn("Relay folder connection failed", error));
	return remote;
}

function requireRemote(folder: CliSharedFolder): RemoteSharedFolder {
	if (!folder.remote) {
		throw new CliError(
			"no_remote",
			`${folder.path} is tracked but not on a Relay Server; use relay:vault:share`,
		);
	}
	return folder.remote;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const health: CliCommand = {
	name: "status",
	description: "Plugin and sync health",
	options: {},
	run(_params, ctx) {
		const folders = ctx.sharedFolders.items().map((folder) => folderRow(ctx, folder));
		const conflicts = ctx.notes.listConflicts();
		const relays = ctx.relayManager.relays.values().map((relay) => relayRow(ctx, relay));
		const metadata = ctx.metadataHealth();
		const actionable = folders.flatMap((folder) => folder.actionable);
		const data = {
			version: ctx.version,
			loggedIn: ctx.login.loggedIn,
			user: ctx.login.user ? { name: ctx.login.user.name, email: ctx.login.user.email } : null,
			debugging: ctx.debugging.enabled(),
			backgroundSyncPaused: ctx.backgroundSync.paused(),
			metadataHealth: metadata?.status ?? null,
			relays,
			folders,
			conflicts: conflicts.length,
			actionable,
		};
		const text = [
			`Relay ${markdownText(ctx.version)}`,
			ctx.login.loggedIn
				? `User: ${markdownText(ctx.login.user?.email || ctx.login.user?.name || "signed in")}`
				: "Logged out",
			data.debugging ? "Debugging enabled" : undefined,
			data.backgroundSyncPaused ? "Background sync paused" : undefined,
			metadata && metadata.status !== "ok"
				? `Metadata: ${markdownText(metadata.message || metadata.status)}` : undefined,
			folders.length ? table(["Folder", "Relay", "Status"], folders.map((f) => [
				f.path, f.relay ?? "", f.status + (f.queued ? ` (${f.queued} queued)` : ""),
			])) : "No tracked folders",
			actionable.length ? "## Attention\n" + actionable.map((a) => `- ${markdownText(a.path)}: ${markdownText(a.label)}`).join("\n") : undefined,
		].filter((line) => line !== undefined).join("\n\n");
		return { data, text, markdown: true };
	},
};

const vault: CliCommand = {
	name: "list",
	description: "List local folders",
	options: FOLDER_FILTER,
	run(params, ctx) {
		const ref = optional(params, "folder");
		const folders = ref ? [resolveSharedFolder(ctx, ref)] : ctx.sharedFolders.items();
		const rows = folders.map((folder) => folderRow(ctx, folder));
		return {
			data: rows,
			text: table(
				["path", "relay server", "guid", "status", "queued", "actionable"],
				rows.map((r) => [r.path, r.relay ?? "tracked", r.guid, r.status, r.queued, r.actionable.length]),
			),
		};
	},
};

const vaultAdd: CliCommand = {
	name: "clone",
	description: "Clone server folder into vault",
	options: {
		...REMOTE_FOLDER_OPTION,
		...RELAY_OPTION,
		path: { value: "<path>", description: "Vault-relative destination (default: folder name)" },
	},
	async run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		const remote = resolveRemoteFolder(relay, required(params, "folder"), ctx.suggest);
		const existing = inVault(ctx, remote);
		if (existing) {
			throw new CliError("already_in_vault", `${remote.name} is already in the vault at ${existing.path}` +
				(!existing.remote ? "; use relay:vault:share with this local path and the same relay to attach its server copy again" : ""));
		}
		const path = folderPath(optional(params, "path") ?? remote.name);
		requireDisjointFolder(ctx, path);
		await ensureVaultFolder(ctx, path);
		const folder = ctx.sharedFolders.clone(path, remote.guid, remote.relay.guid);
		folder.remote = remote;
		ctx.sharedFolders.notifyListeners();
		return {
			data: { path: folder.path, guid: folder.guid, relay: relay.name, folder: remote.name },
			text: `Added ${remote.name} from ${relay.name} at ${folder.path}`,
		};
	},
};

const share: CliCommand = {
	name: "share",
	description: "Share or reattach local folder to server",
	options: {
		path: { value: "<path>", description: "Vault-relative folder path", required: true },
		...RELAY_OPTION,
		private: { description: "Create owner-only folder; grant users with relay:folder:grant" },
	},
	async run(params, ctx) {
		const path = folderPath(required(params, "path"));
		const relay = resolveRelay(ctx, required(params, "relay"));
		const isPrivate = flag(params, "private");
		const existing = ctx.sharedFolders.items().find((folder) => folderPath(folder.path) === path);
		requireDisjointFolder(ctx, path, existing);
		if (existing?.remote) {
			throw new CliError(
				"already_shared",
				`${path} is already on ${existing.remote.relay.name}; use relay:vault:detach first`,
			);
		}
		await ensureVaultFolder(ctx, path);
		const folder = existing ?? ctx.sharedFolders.init(path);
		const remote = await attachRemote(ctx, folder, relay, isPrivate);
		return {
			data: { path: folder.path, guid: folder.guid, relay: relay.name, folder: remote.name, private: remote.private },
			text: `Shared ${folder.path} on ${relay.name}` + (isPrivate ? " (private)" : ""),
		};
	},
};

const track: CliCommand = {
	name: "track",
	description: "Track local history without a server",
	options: { path: { value: "<path>", description: "Vault-relative folder path", required: true } },
	async run(params, ctx) {
		const path = folderPath(required(params, "path"));
		requireDisjointFolder(ctx, path);
		await ensureVaultFolder(ctx, path);
		const folder = ctx.sharedFolders.init(path);
		return { data: { path, guid: folder.guid }, text: `Tracking ${path} locally` };
	},
};

const remoteRemove: CliCommand = {
	name: "detach",
	description: "Disconnect from server; preserve local history. Reattach with relay:vault:share",
	options: FOLDER_OPTION,
	run(params, ctx) {
		const folder = resolveSharedFolder(ctx, required(params, "folder"));
		const remote = requireRemote(folder);
		const relayName = remote.relay.name;
		folder.detachRemote();
		ctx.sharedFolders.notifyListeners();
		return {
			data: { path: folder.path, guid: folder.guid, previousRelay: relayName },
			text: `${folder.path} is tracked; its copy on ${relayName} was left alone\nReattach with relay:vault:share using this local path and the same relay.`,
		};
	},
};

const untrack: CliCommand = {
	name: "untrack",
	description: "Delete local history and tracking; preserve files and server copy",
	options: FOLDER_OPTION,
	run(params, ctx) {
		const folder = resolveSharedFolder(ctx, required(params, "folder"));
		const removed = ctx.sharedFolders.delete(folder);
		if (!removed) throw new CliError("untrack_failed", `Could not delete metadata for ${folder.path}`);
		return {
			data: { path: folder.path, guid: folder.guid },
			text: `${folder.path} is no longer a Shared Folder; its files were left alone`,
		};
	},
};

const sharedFolder: CliCommand = {
	name: "folder",
	argument: "folder",
	description: "Show local folder details",
	options: FOLDER_OPTION,
	run(params, ctx) {
		const folder = resolveSharedFolder(ctx, required(params, "folder"));
		const row = folderRow(ctx, folder);
		const users = folder.remote
			? (folder.remote.private ? rolesOnFolder(ctx, folder.remote) : rolesOnRelay(ctx, folder.remote.relay)).map((role) => ({ user: role.user.name, email: role.user.email, userId: role.userId, role: role.role }))
			: [];
		const types = fileTypes(folder);
		return {
			data: { ...row, users, fileTypes: types },
			text: [
				kv([
					["Shared Folder", folder.path],
					["guid", folder.guid],
					["Relay Server", relayLabel(folder)],
					["name on server", folder.remote?.name],
					["private", folder.remote?.private],
					["connected", folder.connected],
					["status", row.status],
					["queued", row.queued],
					["failures", row.failures],
				]),
				"",
				"## Access",
				"",
				!folder.remote ? "(tracked locally; no Relay Server access)"
					: table(["user", "email", "id", "role"], users.map((u) => [u.user, u.email, u.userId, u.role])),
				"",
				"## File types",
				"",
				table(["type", "enabled", "needs storage"], types.map((t) => [t.name, t.enabled, t.requiresStorage])),
				row.actionable.length > 0
					? "\n## Attention\n\n" + table(["kind", "path", "label"], row.actionable.map((a) => [a.category, a.path, a.label]))
					: "",
			].join("\n").trimEnd(),
		};
	},
};

const sharedFolderFileTypes: CliCommand = {
	name: "list",
	description: "List local sync file types",
	options: FOLDER_FILTER,
	run(params, ctx) {
		const ref = optional(params, "folder");
		const folders = ref ? [resolveSharedFolder(ctx, ref)] : ctx.sharedFolders.items();
		const rows = folders.flatMap((folder) => fileTypes(folder).map((type) => ({ folder: folder.path, folderGuid: folder.guid, ...type })));
		return {
			data: rows,
			text: table(["folder", "type", "key", "enabled", "needs storage"], rows.map((r) => [r.folder, r.name, r.key, r.enabled, r.requiresStorage])),
		};
	},
};

function fileTypeSetting(enabled: boolean): CliCommand {
	return {
		name: enabled ? "enable" : "disable",
		description: `${enabled ? "Enable" : "Disable"} a file type for sync on this device`,
		options: {
			...FOLDER_OPTION,
			type: { value: SYNC_CATEGORIES.join("|"), choices: SYNC_CATEGORIES, description: "File type category", required: true },
		},
		async run(params, ctx) {
			const folder = resolveSharedFolder(ctx, required(params, "folder"));
			const type = required(params, "type") as keyof SyncFlags;
			if (!SYNC_CATEGORIES.includes(type)) throw new CliError("invalid_value", `Unknown file type: ${type}`);
			const category = folder.syncSettingsManager.getCategories()[type];
			if (noStorage(ctx, folder) && category.requiresStorage) throw new CliError("no_storage", `${category.name} needs storage, and this Relay Server's plan has none`);
			if (!category.canToggle) throw new CliError("cannot_toggle", `${category.name} cannot be changed`);
			await folder.syncSettingsManager.toggleCategory(type, enabled);
			return { data: { path: folder.path, type, enabled }, text: `${category.name} sync ${enabled ? "enabled" : "disabled"} for ${folder.path}` };
		},
	};
}

const sharedFolderResync: CliCommand = {
	name: "resync",
	description: "Queue two-way sync and retry failures; preserve history",
	options: FOLDER_OPTION,
	async run(params, ctx) {
		const folder = resolveSharedFolder(ctx, required(params, "folder"));
		requireRemote(folder);
		const reason = folder.localOnly ? "local-only" : !folder.connected ? "disconnected" : null;
		if (reason) {
			return {
				data: { path: folder.path, skipped: true, reason },
				text: `Skipped resync of ${folder.path}: ${reason}`,
			};
		}
		await folder.resync();
		const status = ctx.folderStatus(folder);
		return {
			data: { path: folder.path, skipped: false, status: status.label, queued: status.queued },
			text: `Resynced ${folder.path}: ${status.label}`,
		};
	},
};

const pause: CliCommand = {
	name: "pause",
	description: "Pause background sync on this device",
	options: {},
	run(_params, ctx) {
		ctx.backgroundSync.pause();
		return { data: { paused: true }, text: "Background sync paused" };
	},
};

const resume: CliCommand = {
	name: "resume",
	description: "Resume background sync on this device",
	options: {},
	run(_params, ctx) {
		ctx.backgroundSync.resume();
		return { data: { paused: false }, text: "Background sync resumed" };
	},
};

const conflicts: CliCommand = {
	name: "list",
	description: "List note conflicts",
	options: {},
	run(_params, ctx) {
		const rows = ctx.notes.listConflicts().map((c) => ({ path: c.path, folder: c.folderPath, guid: c.guid }));
		return { data: rows, text: table(["path", "shared folder"], rows.map((r) => [r.path, r.folder])) };
	},
};


const featureFlags: CliCommand = {
	name: "feature-flags",
	description: "List feature flags",
	run(_params, ctx) {
		const current = ctx.flags.get();
		const rows = (Object.keys(FeatureFlagSchema) as (keyof FeatureFlags)[])
			.map((key) => ({ key, value: current[key] ?? FeatureFlagSchema[key].default }));
		return { data: rows, text: table(["key", "value"], rows.map((r) => [r.key, r.value])) };
	},
};

const setFeatureFlag: CliCommand = {
	name: "set",
	description: "Set feature flag",
	assignment: { value: "true|false", choices: ["true", "false"], description: "Feature flag" },
	async run(params, ctx) {
		const names = Object.keys(FeatureFlagSchema) as (keyof FeatureFlags)[];
		const key = pick("flag", required(params, "key"), names,
			(name) => ({ exact: [name], names: [name] }),
			(name) => ({ name }), ctx.suggest);
		const value = params.value;
		if (value !== "true" && value !== "false") throw new CliError("invalid_value", `${key} must be true|false`);
		await ctx.flags.set(key, value === "true");
		return { data: { key, value: value === "true" }, text: `${key}=${value}` };
	},
};

function debugCommand(action: "status" | "enable" | "disable"): CliCommand {
	return {
		name: action,
		description: action === "status" ? "Show debugging state" : `${action === "enable" ? "Enable" : "Disable"} debugging`,
		options: {},
		async run(_params, ctx) {
			if (action !== "status") await ctx.debugging.set(action === "enable");
			const enabled = ctx.debugging.enabled();
			return { data: { debugging: enabled }, text: `Debugging ${enabled ? "on" : "off"}` };
		},
	};
}

export const CLI_TREE: CliCommand = {
	name: "relay",
	description: "Command reference",
	requires: "vault",
	commands: [
		health,
		...(SERVER_TREE.commands ?? []),
		{ name: "vault", description: "Local folders and sync settings", requires: "vault", commands: [
			{ ...vault, name: "folders" }, sharedFolder,
			track, share, vaultAdd, remoteRemove, untrack, sharedFolderResync,
			{ ...sharedFolderFileTypes, name: "file-types" },
			{ name: "file-type", description: "Local sync file type", register: false, commands: [fileTypeSetting(true), fileTypeSetting(false)] },
		] },
		{ name: "sync", description: "Background sync state", run(_params, ctx) {
			const paused = ctx.backgroundSync.paused();
			return { data: { paused }, text: `Background sync ${paused ? "paused" : "running"}` };
		}, commands: [pause, resume] },
		{ ...conflicts, name: "conflicts" },
		featureFlags,
		{ name: "feature-flag", description: "Feature flag", register: false, commands: [setFeatureFlag] },
		{ ...debugCommand("status"), name: "debug", commands: [debugCommand("enable"), debugCommand("disable")] },
	],
};

export const CLI_COMMANDS = flattenCommands(CLI_TREE);

export function isKnownFlag(name: string): boolean {
	return isKeyOfFeatureFlags(name);
}

export type { CliResult };
