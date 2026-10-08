import type { FolderRole, Relay, RelayRole, RelayUser, RemoteSharedFolder } from "../Relay";
import type { RelayManager } from "../RelayManager";
import { CliError, type Command, type CliData, type CliOption } from "./schema";
import { kv, table } from "./format";
import { optional, required } from "./params";
import { pick, resolveRelay, resolveRelayRole, resolveRemoteFolder, resolveUser, rolesOnRelay, rolesOnFolder, type Suggest } from "./resolve";

export interface ServerManager {
	relays: { values(): Relay[] };
	remoteFolders: { values(): RemoteSharedFolder[] };
	relayRoles: { values(): RelayRole[] };
	folderRoles: { values(): FolderRole[] };
	users: { values(): RelayUser[] };
	createRelay: RelayManager["createRelay"];
	createSelfHostedRelay: RelayManager["createSelfHostedRelay"];
	updateRelay: RelayManager["updateRelay"];
	leaveRelay: RelayManager["leaveRelay"];
	destroyRelay: RelayManager["destroyRelay"];
	kick: RelayManager["kick"];
	deleteRemote: RelayManager["deleteRemote"];
	createRemoteFolder: RelayManager["createRemoteFolder"];
	addFolderRole: RelayManager["addFolderRole"];
	removeFolderRole: RelayManager["removeFolderRole"];
}

/** Account commands need no vault, editor, sync engine, or filesystem. */
export interface ServerContext {
	relayManager: ServerManager;
	suggest?: Suggest;
	/** Optional host projection and reconciliation, supplied by the Obsidian adapter. */
	localState?: {
		path(guid: string): string | null;
		remoteDeleted(guid: string): void;
	};
}
export type ServerCommand = Command<ServerContext>;

export const RELAY_OPTION: Record<string, CliOption> = {
	relay: { value: "<name|guid>", description: "Relay", required: true },
};
export const REMOTE_FOLDER_OPTION: Record<string, CliOption> = {
	folder: { value: "<name|guid>", description: "Server folder", required: true },
};
const RELAY_FILTER = { relay: { ...RELAY_OPTION.relay, description: "Relay (default: all)", required: false } };
const REMOTE_FOLDER_FILTER = { folder: { ...REMOTE_FOLDER_OPTION.folder, description: "Server folder (default: all)", required: false } };

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

// ---------------------------------------------------------------------------
// Shared projections
// ---------------------------------------------------------------------------

export function relayRow(ctx: ServerContext, relay: Relay) {
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

function selectedRelays(params: CliData, ctx: ServerContext): Relay[] {
	const ref = optional(params, "relay");
	return ref ? [resolveRelay(ctx, ref)] : ctx.relayManager.relays.values();
}

function selectedRemoteFolders(params: CliData, ctx: ServerContext): RemoteSharedFolder[] {
	const folders = selectedRelays(params, ctx).flatMap((relay) => relay.folders.values());
	const ref = optional(params, "folder");
	return ref ? [pick("folder", ref, folders,
		(folder) => ({ exact: [folder.guid, folder.id], names: [folder.name] }),
		(folder) => ({ name: folder.name, guid: folder.guid }), ctx.suggest)] : folders;
}

const servers: ServerCommand = {
	name: "servers",
	description: "List Relay Servers",
	options: RELAY_FILTER,
	run(params, ctx) {
		const rows = selectedRelays(params, ctx).map((relay) => relayRow(ctx, relay));
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

const server: ServerCommand = {
	name: "server",
	argument: "relay",
	description: "Show Relay Server details",
	options: RELAY_OPTION,
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
			const localPath = ctx.localState?.path(remote.guid) ?? null;
			return {
				name: remote.name,
				guid: remote.guid,
				private: remote.private,
				...(ctx.localState ? { inVault: localPath } : {}),
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
				"## Members",
				"",
				table(["user", "email", "role"], members.map((m) => [m.user, m.email, m.role])),
				"",
				"## Folders",
				"",
				table(["name", "guid", "private", ...(ctx.localState ? ["in vault"] : [])], folders.map((f) => [f.name, f.guid, f.private, ...(ctx.localState ? [f.inVault ?? "no"] : [])])),
			].join("\n"),
		};
	},
};

const serverCreate: ServerCommand = {
	name: "create",
	description: "Create a Relay Server",
	options: { name: { value: "<name>", description: "Relay Server name", required: true } },
	async run(params, ctx) {
		const relay = await ctx.relayManager.createRelay(required(params, "name"));
		return {
			data: { name: relay.name, guid: relay.guid },
			text: `Created Relay Server ${relay.name} (${relay.guid})`,
		};
	},
};

const serverSetName: ServerCommand = {
	name: "rename",
	description: "Set the Relay Server's name",
	options: { ...RELAY_OPTION, name: { value: "<name>", description: "New name", required: true } },
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

const serverUsers: ServerCommand = {
	name: "list",
	description: "List relay members",
	options: RELAY_FILTER,
	run(params, ctx) {
		const rows = selectedRelays(params, ctx).flatMap((relay) => rolesOnRelay(ctx, relay).map((role) => ({
			relay: relay.name,
			relayGuid: relay.guid,
			user: role.user.name,
			email: role.user.email,
			userId: role.userId,
			role: role.role,
		})));
		return {
			data: rows,
			text: table(["relay", "user", "email", "id", "role"], rows.map((r) => [r.relay, r.user, r.email, r.userId, r.role])),
		};
	},
};

const serverKick: ServerCommand = {
	name: "remove",
	description: "Remove server member",
	options: { ...RELAY_OPTION, user: { value: "<name|email|id>", description: "User", required: true } },
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

const serverLeave: ServerCommand = {
	name: "leave",
	description: "Leave server; preserve local data",
	options: RELAY_OPTION,
	async run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		await ctx.relayManager.leaveRelay(relay);
		return { data: { relay: relay.name, guid: relay.guid }, text: `Left ${relay.name}` };
	},
};

const serverDestroy: ServerCommand = {
	name: "delete",
	description: "Delete server data for all members; preserve local files",
	options: RELAY_OPTION,
	async run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		if (!await ctx.relayManager.destroyRelay(relay)) throw new CliError("delete_failed", `Could not delete server ${relay.name}`);
		return { data: { relay: relay.name, guid: relay.guid }, text: `Destroyed ${relay.name}` };
	},
};

const serverRemoveFolder: ServerCommand = {
	name: "delete",
	description: "Delete server folder for all members; preserve local files and history",
	options: { ...RELAY_OPTION, ...REMOTE_FOLDER_OPTION },
	async run(params, ctx) {
		const relay = resolveRelay(ctx, required(params, "relay"));
		const remote = resolveRemoteFolder(relay, required(params, "folder"), ctx.suggest);
		if (!await ctx.relayManager.deleteRemote(remote)) throw new CliError("delete_failed", `Could not delete server folder ${remote.name}`);
		const localPath = ctx.localState?.path(remote.guid) ?? null;
		ctx.localState?.remoteDeleted(remote.guid);
		return {
			data: { relay: relay.name, folder: remote.name, guid: remote.guid, ...(ctx.localState ? { localPath } : {}) },
			text: `Removed ${remote.name} from ${relay.name}` + (localPath ? `; ${localPath} is tracked` : ""),
		};
	},
};

const sharedFolderUsers: ServerCommand = {
	name: "list",
	description: "List access roles: private grants or public relay members",
	options: { ...RELAY_FILTER, ...REMOTE_FOLDER_FILTER },
	run(params, ctx) {
		const rows = selectedRemoteFolders(params, ctx).flatMap((remote) =>
			(remote.private ? rolesOnFolder(ctx, remote) : rolesOnRelay(ctx, remote.relay)).map((role) => ({
			relay: remote.relay.name, relayGuid: remote.relay.guid,
			folder: remote.name, folderGuid: remote.guid,
			user: role.user.name, email: role.user.email, userId: role.userId, role: role.role,
		})));
		return {
			data: rows,
			text: table(["relay", "folder", "user", "email", "id", "role"], rows.map((r) => [r.relay, r.folder, r.user, r.email, r.userId, r.role])),
		};
	},
};

function folderAccess(action: "add" | "remove"): ServerCommand {
	return {
		name: action === "add" ? "grant" : "revoke",
		description: action === "add" ? "Grant server member access to private folder" : "Revoke access to private folder",
		options: { ...RELAY_OPTION, ...REMOTE_FOLDER_OPTION, user: { value: "<name|email|id>", description: "Relay member", required: true } },
		async run(params, ctx) {
			const relay = resolveRelay(ctx, required(params, "relay"));
			const remote = resolveRemoteFolder(relay, required(params, "folder"), ctx.suggest);
			if (!remote.private) throw new CliError("not_private", "Everyone on this server has access; explicit access applies to private folders");
			const ref = required(params, "user");
			if (action === "add") {
				const user = resolveUser(ctx, remote.relay, ref);
				await ctx.relayManager.addFolderRole(remote, { user: user.id, role: "Member" });
			} else {
				const role = pick("user", ref, rolesOnFolder(ctx, remote),
					(r) => ({ exact: [r.userId], names: [r.user.name, r.user.email].filter(Boolean) }),
					(r) => ({ name: r.user.name, guid: r.userId }), ctx.suggest);
				await ctx.relayManager.removeFolderRole(role);
			}
			return { data: { relay: relay.name, folder: remote.name, guid: remote.guid, user: ref, action }, text: `${action === "add" ? "Granted" : "Removed"} access for ${ref} on ${remote.name}` };
		},
	};
}

const serverFolders: ServerCommand = {
	name: "list",
	description: "List server folders",
	options: RELAY_FILTER,
	run(params, ctx) {
		const rows = selectedRemoteFolders(params, ctx).map((remote) => ({ relay: remote.relay.name, relayGuid: remote.relay.guid, name: remote.name, guid: remote.guid, private: remote.private, ...(ctx.localState ? { path: ctx.localState.path(remote.guid) } : {}) }));
		return { data: rows, text: table(["relay", "name", "guid", "private", ...(ctx.localState ? ["local path"] : [])], rows.map((r) => [r.relay, r.name, r.guid, r.private, r.path])) };
	},
};

const remoteFolder: ServerCommand = {
	name: "folder",
	description: "Show server folder details",
	argument: "folder",
	options: { ...RELAY_FILTER, ...REMOTE_FOLDER_OPTION },
	run(params, ctx) {
		const remote = selectedRemoteFolders(params, ctx)[0];
		const data = { name: remote.name, guid: remote.guid, relay: remote.relay.name, relayGuid: remote.relay.guid, private: remote.private, ...(ctx.localState ? { path: ctx.localState.path(remote.guid) } : {}) };
		return { data, text: table(["name", "guid", "relay", "private", ...(ctx.localState ? ["local path"] : [])], [[data.name, data.guid, data.relay, data.private, data.path]]) };
	},
};

const serverRegister: ServerCommand = {
	name: "register",
	description: "Register a self-hosted server",
	options: { url: { value: "<url>", description: "Self-hosted server URL", required: true } },
	async run(params, ctx) {
		const value = required(params, "url");
		let url: URL;
		try { url = new URL(value); } catch { throw new CliError("invalid_value", "url must be an http or https URL"); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
			throw new CliError("invalid_value", "url must be an http or https URL without credentials or a fragment");
		}
		const relay = await ctx.relayManager.createSelfHostedRelay(value);
		const data = { name: relay.name, guid: relay.guid, url: relay.provider?.url ?? value };
		return { data, text: table(["name", "guid", "url"], [[data.name, data.guid, data.url]]) };
	},
};

function serverScope(command: ServerCommand): ServerCommand {
	return { ...command, requires: "server", commands: command.commands?.map(serverScope) };
}

/** Import this entrypoint to include account/server commands without local sync. */
export const SERVER_TREE: ServerCommand = serverScope({
	name: "relay", description: "Server command reference",
	commands: [servers, { ...server, commands: [
		serverCreate, serverRegister, serverSetName, serverLeave, serverDestroy,
		{ ...serverUsers, name: "roles" },
		{ name: "role", description: "Server member", register: false, commands: [serverKick] },
	] },
		{ ...serverFolders, name: "folders" },
		{ ...remoteFolder, commands: [serverRemoveFolder,
			{ ...sharedFolderUsers, name: "roles" },
			folderAccess("add"), folderAccess("remove"),
		] },
	],
});
