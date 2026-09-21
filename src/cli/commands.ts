import type { CliFlags } from "obsidian";
import { FeatureFlagSchema, isKeyOfFeatureFlags, type FeatureFlags } from "../flags";
import type { Relay, RemoteSharedFolder } from "../Relay";
import { SyncSettingsManager, type SyncFlags } from "../SyncSettings";
import { shortestUniquePrefixLength } from "../merge-hsm/conflict";
import { conflictBlocks, decidableBlocks, type ConflictSource } from "../merge-hsm/conflictValue";
import { kv, table } from "./format";
import { flag, folderPath, notePath, optional, parseOnOff, required } from "./params";
import {
	pick,
	resolveRelay,
	resolveRelayRole,
	resolveRemoteFolder,
	resolveSharedFolder,
	resolveUser,
	rolesOnFolder,
	rolesOnRelay,
} from "./resolve";
import {
	CliError,
	type CliCommand,
	type CliContext,
	type CliResult,
	type CliSharedFolder,
	type BlockDecision,
} from "./types";

const RELAY_FLAG: CliFlags = {
	relay: { value: "<name|guid>", description: "Relay Server", required: true },
};
const FOLDER_FLAG: CliFlags = {
	folder: { value: "<path|name|guid>", description: "Shared Folder", required: true },
};
/** File-type categories come from the sync settings schema, never a local list. */
const SYNC_CATEGORIES: (keyof SyncFlags)[] = SyncSettingsManager.categories.map((c) => c.key);
const DECISIONS: BlockDecision[] = ["ours", "theirs", "both", "neither"];

function bytes(n: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = n;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** "used of quota", or "none" when the plan has no storage. */
function storage(usage: number | null, quota: number | null): string | undefined {
	if (quota === null) return undefined;
	if (quota === 0) return "none";
	return `${bytes(usage ?? 0)} of ${bytes(quota)}`;
}

function userLabel(user: { name: string; email?: string }): string {
	return user.email ? `${user.name} <${user.email}>` : user.name;
}

// ---------------------------------------------------------------------------
// Shared projections
// ---------------------------------------------------------------------------

function relayRow(ctx: CliContext, relay: Relay) {
	const quota = relay.storageQuota;
	return {
		name: relay.name,
		guid: relay.guid,
		role: relay.role,
		plan: relay.plan,
		members: rolesOnRelay(ctx, relay).length,
		folders: relay.folders.values().length,
		storageUsage: quota?.usage ?? null,
		storageQuota: quota?.quota ?? null,
	};
}

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
			`${folder.path} is tracked but not on a Relay Server; use relay:remote:add`,
		);
	}
	return folder.remote;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const health: CliCommand = {
	id: "relay",
	description: "Health: version, login, Relay Servers, My vault, anything actionable",
	flags: null,
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
			kv([
				["Relay", ctx.version],
				["Logged in", ctx.login.loggedIn],
				["User", ctx.login.user ? userLabel(ctx.login.user) : undefined],
				["Debugging", ctx.debugging.enabled()],
				["Background sync", ctx.backgroundSync.paused() ? "paused" : "running"],
				["Metadata health", metadata ? metadata.status + (metadata.message ? `: ${metadata.message}` : "") : undefined],
			]),
			"",
			"Relay Servers",
			table(["name", "role", "plan", "members", "folders"], relays.map((r) => [r.name, r.role, r.plan, r.members, r.folders])),
			"",
			"My vault",
			table(["path", "relay server", "status"], folders.map((f) => [f.path, f.relay ?? "tracked", f.status])),
			"",
			actionable.length > 0
				? "Actionable\n" + table(["kind", "path", "label"], actionable.map((a) => [a.category, a.path, a.label]))
				: "Nothing actionable",
		].join("\n");
		return { data, text };
	},
};

const servers: CliCommand = {
	id: "relay:servers",
	description: "Relay Servers: name, plan, storage, your role",
	flags: null,
	run(_params, ctx) {
		const rows = ctx.relayManager.relays.values().map((relay) => relayRow(ctx, relay));
		return {
			data: rows,
			text: table(
				["name", "guid", "role", "plan", "members", "folders", "storage"],
				rows.map((r) => [
					r.name, r.guid, r.role, r.plan, r.members, r.folders,
					storage(r.storageUsage, r.storageQuota) ?? "",
				]),
			),
		};
	},
};

const server: CliCommand = {
	id: "relay:server",
	description: "One Relay Server: plan, storage, Membership, Shared Folders on this Relay Server",
	flags: RELAY_FLAG,
	run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		const row = relayRow(ctx, relay);
		const members = rolesOnRelay(ctx, relay).map((role) => ({
			user: role.user.name,
			email: role.user.email,
			userId: role.userId,
			role: role.role,
		}));
		const folders = relay.folders.values().map((remote) => {
			const local = inVault(ctx, remote);
			return {
				name: remote.name,
				guid: remote.guid,
				private: remote.private,
				inVault: local ? local.path : null,
			};
		});
		return {
			data: { ...row, members, folders },
			text: [
				kv([
					["Relay Server", relay.name],
					["guid", relay.guid],
					["role", relay.role],
					["plan", relay.plan],
					["storage", storage(row.storageUsage, row.storageQuota)],
				]),
				"",
				"Membership",
				table(["user", "email", "role"], members.map((m) => [m.user, m.email, m.role])),
				"",
				"Shared Folders on this Relay Server",
				table(["name", "guid", "private", "in vault"], folders.map((f) => [f.name, f.guid, f.private, f.inVault ?? "no"])),
			].join("\n"),
		};
	},
};

const serverCreate: CliCommand = {
	id: "relay:server:create",
	description: "Create a Relay Server",
	flags: { name: { value: "<name>", description: "Relay Server name", required: true } },
	async run(params, ctx) {
		const relay = await ctx.relayManager.createRelay(required(params, "name"));
		return {
			data: { name: relay.name, guid: relay.guid },
			text: `Created Relay Server ${relay.name} (${relay.guid})`,
		};
	},
};

const serverSetName: CliCommand = {
	id: "relay:server:set-name",
	description: "Set the Relay Server's name",
	flags: { ...RELAY_FLAG, name: { value: "<name>", description: "New name", required: true } },
	async run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		const previous = relay.name;
		relay.name = required(params, "name");
		let updated: Relay;
		try {
			updated = await ctx.relayManager.updateRelay(relay);
		} catch (error) {
			relay.name = previous;
			throw error;
		}
		return {
			data: { guid: updated.guid, name: updated.name, previous },
			text: `Renamed ${previous} to ${updated.name}`,
		};
	},
};

const serverUsers: CliCommand = {
	id: "relay:server:users",
	description: "Membership of a Relay Server",
	flags: RELAY_FLAG,
	run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		const rows = rolesOnRelay(ctx, relay).map((role) => ({
			user: role.user.name,
			email: role.user.email,
			userId: role.userId,
			role: role.role,
		}));
		return {
			data: rows,
			text: table(["user", "email", "id", "role"], rows.map((r) => [r.user, r.email, r.userId, r.role])),
		};
	},
};

const serverKick: CliCommand = {
	id: "relay:server:kick",
	description: "Kick a user from a Relay Server",
	flags: { ...RELAY_FLAG, user: { value: "<name|email|id>", description: "User", required: true } },
	async run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		const role = resolveRelayRole(ctx, relay, required(params, "user"));
		await ctx.relayManager.kick(role);
		return {
			data: { relay: relay.name, user: role.user.name, userId: role.userId },
			text: `Kicked ${role.user.name} from ${relay.name}`,
		};
	},
};

const serverLeave: CliCommand = {
	id: "relay:server:leave",
	description: "Leave Relay Server; local data is preserved",
	flags: RELAY_FLAG,
	async run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		await ctx.relayManager.leaveRelay(relay);
		return { data: { relay: relay.name, guid: relay.guid }, text: `Left ${relay.name}` };
	},
};

const serverDestroy: CliCommand = {
	id: "relay:server:destroy",
	description: "Destroy Relay Server",
	flags: RELAY_FLAG,
	async run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		await ctx.relayManager.destroyRelay(relay);
		return { data: { relay: relay.name, guid: relay.guid }, text: `Destroyed ${relay.name}` };
	},
};

const serverRemoveFolder: CliCommand = {
	id: "relay:server:remove-folder",
	description: "Remove from Relay Server; the copy is gone for every member",
	flags: { ...RELAY_FLAG, ...FOLDER_FLAG },
	async run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		const remote = resolveRemoteFolder(relay, required(params, "folder"));
		await ctx.relayManager.deleteRemote(remote);
		const local = inVault(ctx, remote);
		if (local) {
			local.remote = undefined;
			ctx.sharedFolders.notifyListeners();
		}
		return {
			data: { relay: relay.name, folder: remote.name, guid: remote.guid, localPath: local?.path ?? null },
			text: `Removed ${remote.name} from ${relay.name}` + (local ? `; ${local.path} is tracked` : ""),
		};
	},
};

const vault: CliCommand = {
	id: "relay:vault",
	description: "My vault: Shared Folders on this device, each with its Relay Server or tracked",
	flags: null,
	run(_params, ctx) {
		const rows = ctx.sharedFolders.items().map((folder) => folderRow(ctx, folder));
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
	id: "relay:vault:add",
	description: "Add remote folder to vault",
	flags: {
		...FOLDER_FLAG,
		...RELAY_FLAG,
		path: { value: "<path>", description: "Local path (default: the folder's name at the vault root)" },
	},
	async run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		const remote = resolveRemoteFolder(relay, required(params, "folder"));
		const existing = inVault(ctx, remote);
		if (existing) {
			throw new CliError("already_in_vault", `${remote.name} is already in the vault at ${existing.path}`);
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
	id: "relay:share",
	description: "Share local folder: make it a Shared Folder, and with relay= put it on a Relay Server",
	flags: {
		path: { value: "<path>", description: "Local folder", required: true },
		relay: { value: "<name|guid>", description: "Relay Server to share on" },
		private: { description: "Only selected users can access this folder" },
	},
	async run(params, ctx) {
		const path = folderPath(required(params, "path"));
		const relayRef = optional(params, "relay");
		const isPrivate = flag(params, "private");
		const existing = ctx.sharedFolders.items().find((folder) => folderPath(folder.path) === path);
		requireDisjointFolder(ctx, path, existing);
		if (existing?.remote) {
			throw new CliError(
				"already_shared",
				`${path} is already on ${existing.remote.relay.name}; use relay:remote:remove first`,
			);
		}
		await ensureVaultFolder(ctx, path);
		const folder = existing ?? ctx.sharedFolders.init(path);
		if (!relayRef) {
			return {
				data: { path: folder.path, guid: folder.guid, relay: null },
				text: `${folder.path} is a Shared Folder (tracked, not on a Relay Server)`,
			};
		}
		const relay = resolveRelay(ctx, relayRef);
		const remote = await attachRemote(ctx, folder, relay, isPrivate);
		return {
			data: { path: folder.path, guid: folder.guid, relay: relay.name, folder: remote.name, private: remote.private },
			text: `Shared ${folder.path} on ${relay.name}` + (isPrivate ? " (private)" : ""),
		};
	},
};

const remoteAdd: CliCommand = {
	id: "relay:remote:add",
	description: "Put a Shared Folder on a Relay Server, history included",
	flags: {
		...FOLDER_FLAG,
		...RELAY_FLAG,
		private: { description: "Only selected users can access this folder" },
	},
	async run(params, ctx) {
		const folder = resolveSharedFolder(ctx, required(params, "folder"));
		if (folder.remote) {
			throw new CliError(
				"already_shared",
				`${folder.path} is already on ${folder.remote.relay.name}; use relay:remote:remove first`,
			);
		}
		const relay = resolveRelay(ctx, required(params, "relay"));
		const remote = await attachRemote(ctx, folder, relay, flag(params, "private"));
		return {
			data: { path: folder.path, guid: folder.guid, relay: relay.name, folder: remote.name },
			text: `${folder.path} is on ${relay.name}`,
		};
	},
};

const remoteRemove: CliCommand = {
	id: "relay:remote:remove",
	description: "Forget the remote; local history and the server copy both stay",
	flags: FOLDER_FLAG,
	run(params, ctx) {
		const folder = resolveSharedFolder(ctx, required(params, "folder"));
		const remote = requireRemote(folder);
		const relayName = remote.relay.name;
		folder.detachRemote();
		ctx.sharedFolders.notifyListeners();
		return {
			data: { path: folder.path, guid: folder.guid, previousRelay: relayName },
			text: `${folder.path} is tracked; its copy on ${relayName} was left alone`,
		};
	},
};

const untrack: CliCommand = {
	id: "relay:untrack",
	description: "Delete metadata: edit history and change tracking; files and the server copy stay",
	flags: FOLDER_FLAG,
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
	id: "relay:shared-folder",
	description: "One Shared Folder: remote, Users with access, file types, sync status",
	flags: FOLDER_FLAG,
	run(params, ctx) {
		const folder = resolveSharedFolder(ctx, required(params, "folder"));
		const row = folderRow(ctx, folder);
		const users = folder.remote
			? rolesOnFolder(ctx, folder.remote).map((role) => ({ user: role.user.name, email: role.user.email, userId: role.userId, role: role.role }))
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
				"Users with access",
				folder.remote?.private ? table(["user", "email", "role"], users.map((u) => [u.user, u.email, u.role])) : "(everyone on the Relay Server)",
				"",
				"File types synced on this device",
				table(["type", "enabled", "needs storage"], types.map((t) => [t.name, t.enabled, t.requiresStorage])),
				row.actionable.length > 0
					? "\nActionable\n" + table(["kind", "path", "label"], row.actionable.map((a) => [a.category, a.path, a.label]))
					: "",
			].join("\n").trimEnd(),
		};
	},
};

const sharedFolderUsers: CliCommand = {
	id: "relay:shared-folder:users",
	description: "Users with access to a private Shared Folder; add= or remove= a user",
	flags: {
		...FOLDER_FLAG,
		add: { value: "<name|email|id>", description: "Add Users to Folder" },
		remove: { value: "<name|email|id>", description: "Remove a user's access" },
	},
	async run(params, ctx) {
		const folder = resolveSharedFolder(ctx, required(params, "folder"));
		const remote = requireRemote(folder);
		const addRef = optional(params, "add");
		const removeRef = optional(params, "remove");
		const changes: string[] = [];
		if (addRef) {
			const user = resolveUser(ctx, remote.relay, addRef);
			await ctx.relayManager.addFolderRole(remote, user.id, "Member");
			changes.push(`added ${user.name}`);
		}
		if (removeRef) {
			const role = pick(
				"user",
				removeRef,
				rolesOnFolder(ctx, remote),
				(r) => ({ exact: [r.userId], names: [r.user.name, r.user.email].filter(Boolean) }),
				(r) => ({ name: r.user.name, guid: r.userId }),
			);
			await ctx.relayManager.removeFolderRole(role);
			changes.push(`removed ${role.user.name}`);
		}
		const users = rolesOnFolder(ctx, remote).map((role) => ({
			user: role.user.name, email: role.user.email, userId: role.userId, role: role.role,
		}));
		return {
			data: { path: folder.path, private: remote.private, changes, users },
			text: [
				changes.length > 0 ? changes.join(", ") + "\n" : "",
				remote.private ? "" : "Not private: everyone on the Relay Server has access\n",
				table(["user", "email", "id", "role"], users.map((u) => [u.user, u.email, u.userId, u.role])),
			].join(""),
		};
	},
};

const sharedFolderFileTypes: CliCommand = {
	id: "relay:shared-folder:file-types",
	description: "Sync settings for this device: which file types sync; set with <type>=on|off",
	flags: {
		...FOLDER_FLAG,
		...Object.fromEntries(
			SyncSettingsManager.categories.map((c) => [c.key, { value: "on|off", description: c.description }]),
		),
	},
	async run(params, ctx) {
		const folder = resolveSharedFolder(ctx, required(params, "folder"));
		const locked = noStorage(ctx, folder);
		const changes: string[] = [];
		const requested: [keyof SyncFlags, boolean][] = [];
		for (const key of SYNC_CATEGORIES) {
			const wanted = parseOnOff(key, params[key]);
			if (wanted === undefined) continue;
			const category = folder.syncSettingsManager.getCategories()[key];
			if (locked && category.requiresStorage) {
				throw new CliError("no_storage", `${category.name} needs storage, and this Relay Server's plan has none`);
			}
			if (!category.canToggle) {
				throw new CliError("cannot_toggle", `${category.name} cannot be changed`);
			}
			requested.push([key, wanted]);
		}
		for (const [key, wanted] of requested) {
			await folder.syncSettingsManager.toggleCategory(key, wanted);
			changes.push(`${key}=${wanted ? "on" : "off"}`);
		}
		const types = fileTypes(folder);
		return {
			data: { path: folder.path, changes, fileTypes: types },
			text: (changes.length > 0 ? changes.join(" ") + "\n" : "") +
				table(["type", "key", "enabled", "needs storage"], types.map((t) => [t.name, t.key, t.enabled, t.requiresStorage])),
		};
	},
};

const sharedFolderResync: CliCommand = {
	id: "relay:shared-folder:resync",
	description: "Resync a Shared Folder with its Relay Server",
	flags: FOLDER_FLAG,
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
	id: "relay:pause",
	description: "Pause background sync on this device, as the sync pane's Pause does",
	flags: null,
	run(_params, ctx) {
		ctx.backgroundSync.pause();
		return { data: { paused: true }, text: "Background sync paused" };
	},
};

const resume: CliCommand = {
	id: "relay:resume",
	description: "Resume background sync on this device",
	flags: null,
	run(_params, ctx) {
		ctx.backgroundSync.resume();
		return { data: { paused: false }, text: "Background sync resumed" };
	},
};

const conflicts: CliCommand = {
	id: "relay:conflicts",
	description: "Every note in conflict, across Shared Folders",
	flags: null,
	run(_params, ctx) {
		const rows = ctx.notes.listConflicts().map((c) => ({ path: c.path, folder: c.folderPath, guid: c.guid }));
		return { data: rows, text: table(["path", "shared folder"], rows.map((r) => [r.path, r.folder])) };
	},
};

const NOTE_FLAG: CliFlags = { path: { value: "<path>", description: "Note path", required: true } };

/** What a side of a conflict is, in the CLI's words. */
const SOURCE_WORDS: Record<ConflictSource, string> = {
	editor: "the editor",
	file: "the file on disk",
	record: "this device's record",
	remote: "the remote",
};

const diff: CliCommand = {
	id: "relay:diff",
	description: "One note: state, the conflict's sides, and the blocks they disagree on",
	flags: {
		...NOTE_FLAG,
		blocks: { value: "all", description: "Also list the changes only one side made, which merged on their own" },
	},
	async run(params, ctx) {
		const path = notePath(required(params, "path"));
		const info = await ctx.notes.conflictInfo(path);
		const conflict = info.conflict;
		if (!conflict) {
			const data = { path: info.path, state: info.statePath, conflict: false };
			return { data, text: kv([["note", info.path], ["state", info.statePath], ["conflict", false]]) };
		}
		const listAll = optional(params, "blocks") === "all";
		const listed = decidableBlocks(conflict).filter((b) => listAll || b.kind === "conflict");
		const prefix = shortestUniquePrefixLength(decidableBlocks(conflict).map((b) => b.id));
		const disagreements = conflictBlocks(conflict);
		const decided = disagreements.filter((b) => info.decisions[b.id] !== undefined).length;
		const blocks = listed.map((b) => ({
			id: b.id.slice(0, prefix),
			kind: b.kind,
			decision: info.decisions[b.id] ?? null,
			base: b.base,
			ours: b.kind === "theirs-only" ? b.base : b.ours,
			theirs: b.kind === "ours-only" ? b.base : b.theirs,
		}));
		const data = {
			path: info.path,
			state: info.statePath,
			conflict: true,
			id: conflict.id,
			situation: conflict.situation,
			ours: conflict.ours,
			theirs: conflict.theirs,
			base: conflict.base,
			decided,
			total: disagreements.length,
			blocks,
		};
		const lines = [
			kv([
				["note", info.path],
				["state", info.statePath],
				["conflict", conflict.id],
				["situation", conflict.situation],
				["ours", `${SOURCE_WORDS[conflict.ours.source]}: what this device has`],
				["theirs", `${SOURCE_WORDS[conflict.theirs.source]}: what came in`],
				["blocks", `${decided}/${disagreements.length} decided`],
			]),
		];
		for (const block of blocks) {
			const state = block.decision ? ` (take=${block.decision})` : "";
			lines.push("", `block ${block.id} ${block.kind}${state}`);
			lines.push("  ours:   " + JSON.stringify(block.ours));
			lines.push("  theirs: " + JSON.stringify(block.theirs));
		}
		if (conflict.base !== null) lines.push("", "--- baseline ---", conflict.base);
		lines.push("", `--- ours: ${SOURCE_WORDS[conflict.ours.source]} ---`, conflict.ours.text);
		lines.push("", `--- theirs: ${SOURCE_WORDS[conflict.theirs.source]} ---`, conflict.theirs.text);
		return { data, text: lines.join("\n") };
	},
};

const diffResolve: CliCommand = {
	id: "relay:diff:resolve",
	description:
		"Resolve a conflict: decide one block with block= and take=, or give the whole note with content=. conflict= is the id relay:diff prints",
	flags: {
		...NOTE_FLAG,
		conflict: { value: "<id>", description: "Conflict id from relay:diff; a conflict that has since changed is refused" },
		block: { value: "<id>", description: "Block id from relay:diff" },
		take: { value: "ours|theirs|both|neither", description: "ours keeps what this device has, theirs takes what came in" },
		content: { value: "<text>", description: "Replace the whole note; empty text clears it, literal true is reserved for a bare flag" },
	},
	async run(params, ctx) {
		const path = notePath(required(params, "path"));
		const conflictId = required(params, "conflict");
		const content = params.content;
		const block = optional(params, "block");
		const take = optional(params, "take");
		const wholeNote = content !== undefined && content !== "true";
		if (!wholeNote && !(block && take)) {
			throw new CliError("missing_flag", "Give block= and take=, or content=");
		}
		if (!wholeNote && !DECISIONS.includes(take as BlockDecision)) {
			throw new CliError("invalid_value", `take must be one of ${DECISIONS.join(", ")}`);
		}
		// Reading the conflict first materializes a hibernated note's conflict,
		// which a decision requires; the UI's flow does the same.
		const info = await ctx.notes.conflictInfo(path);
		if (!info.conflict) {
			const loading = /loading|recoverLCA/.test(info.statePath);
			throw new CliError(
				"no_conflict",
				`${path} is not in conflict (state ${info.statePath})` +
					(loading ? "; the note is still loading, try again shortly" : ""),
			);
		}
		if (info.conflict.id !== conflictId) {
			throw new CliError(
				"stale_conflict",
				`The conflict on ${path} is ${info.conflict.id}, not ${conflictId}: it changed since it was read. Run relay:diff again`,
			);
		}
		const state = wholeNote
			? await ctx.notes.resolveContents(path, conflictId, content)
			: await ctx.notes.decideBlock(path, conflictId, block as string, take as BlockDecision);
		// A decision writes nothing until every disagreement has one.
		const written = state === "idle.synced" || state === "active.tracking";
		let convergence = "not-requested";
		if (state === "idle.synced") {
			convergence = ctx.backgroundSync.paused() ? "paused" : await convergeWithinDeadline(ctx, path);
		}
		const converged = convergence === "complete";
		const after = await ctx.notes.state(path);
		const data = {
			path,
			state: after.statePath,
			conflict: after.hasConflict,
			lca: after.hasLCA,
			diskMatchesStore: after.diskMatchesIdb,
			written,
			converged,
			convergence,
		};
		return {
			data,
			text: kv([
				["note", path],
				["state", after.statePath],
				["conflict", after.hasConflict],
				["written", written],
				["converged with server", converged],
				["convergence", convergence],
			]),
		};
	},
};

// Resolution is already committed locally. Network availability must not turn
// that success into a command failure or an unbounded CLI wait.
async function convergeWithinDeadline(ctx: CliContext, path: string): Promise<string> {
	let timer: number | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(() => ctx.notes.converge(path)).then(
				(converged) => converged ? "complete" : "unavailable",
				() => "failed",
			),
			new Promise<string>((resolve) => {
				timer = ctx.timers.setTimeout(() => resolve("pending"), 1000);
			}),
		]);
	} finally {
		if (timer !== undefined) ctx.timers.clearTimeout(timer);
	}
}

const featureFlags: CliCommand = {
	id: "relay:feature-flags",
	description: "Show feature flags; with name= and on, off, or reset, change one",
	flags: {
		name: { value: "<flag>", description: "Flag name" },
		on: { description: "Turn the flag on" },
		off: { description: "Turn the flag off" },
		reset: { description: "Restore the flag's default" },
	},
	async run(params, ctx) {
		const current = ctx.flags.get();
		const names = Object.keys(FeatureFlagSchema) as (keyof FeatureFlags)[];
		const rowFor = (name: keyof FeatureFlags) => {
			const schema = FeatureFlagSchema[name];
			return { name, value: current[name] ?? schema.default, default: schema.default, category: schema.category, title: schema.title, requiresReload: schema.requiresReload ?? false };
		};
		const ref = optional(params, "name");
		if (!ref) {
			const rows = names.map(rowFor);
			return {
				data: rows,
				text: table(["flag", "value", "default", "category", "title"], rows.map((r) => [r.name, r.value ? "on" : "off", r.default ? "on" : "off", r.category, r.title])),
			};
		}
		const name = pick(
			"flag",
			ref,
			names,
			(n) => ({ exact: [n], names: [n, n.replace(/^enable/, "")] }),
			(n) => ({ name: n, guid: FeatureFlagSchema[n].category }),
		);
		const schema = FeatureFlagSchema[name];
		const wanted = flag(params, "on") ? true : flag(params, "off") ? false : flag(params, "reset") ? schema.default : undefined;
		if (wanted !== undefined) {
			if (schema.category !== "labs" && !ctx.debugging.enabled()) {
				throw new CliError("debugging_required", `${name} is a ${schema.category} flag; enable debugging first`);
			}
			await ctx.flags.set(name, wanted);
		}
		const row = { ...rowFor(name), value: wanted ?? rowFor(name).value };
		return {
			data: row,
			text: kv([
				["flag", row.name],
				["value", row.value ? "on" : "off"],
				["default", row.default ? "on" : "off"],
				["category", row.category],
				["title", row.title],
				["description", schema.description],
				["requires reload", row.requiresReload ? true : undefined],
			]),
		};
	},
};

const debugging: CliCommand = {
	id: "relay:debugging",
	description: "Show or set debugging: on or off",
	flags: {
		on: { description: "Enable debugging" },
		off: { description: "Disable debugging" },
	},
	async run(params, ctx) {
		if (flag(params, "on")) await ctx.debugging.set(true);
		else if (flag(params, "off")) await ctx.debugging.set(false);
		const enabled = ctx.debugging.enabled();
		return { data: { debugging: enabled }, text: `Debugging ${enabled ? "on" : "off"}` };
	},
};

export const CLI_COMMANDS: CliCommand[] = [
	health,
	servers,
	server,
	serverCreate,
	serverSetName,
	serverUsers,
	serverKick,
	serverLeave,
	serverDestroy,
	serverRemoveFolder,
	vault,
	vaultAdd,
	share,
	remoteAdd,
	remoteRemove,
	untrack,
	sharedFolder,
	sharedFolderUsers,
	sharedFolderFileTypes,
	sharedFolderResync,
	pause,
	resume,
	conflicts,
	diff,
	diffResolve,
	featureFlags,
	debugging,
];

export function isKnownFlag(name: string): boolean {
	return isKeyOfFeatureFlags(name);
}

export type { CliResult };
