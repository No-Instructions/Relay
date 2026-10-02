import { SERVER_TREE, relayRow, RELAY_OPTION, REMOTE_FOLDER_OPTION } from "./server";
import { FeatureFlagSchema, isKeyOfFeatureFlags, type FeatureFlags } from "../flags";
import type { Relay, RemoteSharedFolder } from "../Relay";
import { SyncSettingsManager, type SyncFlags } from "../SyncSettings";
import { shortestUniquePrefixLength } from "../merge-hsm/conflict";
import { conflictBlocks, decidableBlocks, type ConflictSource } from "../merge-hsm/conflictValue";
import { kv, table, markdownText } from "./format";
import { flattenCommands } from "./tree";
import { flag, folderPath, notePath, optional, required } from "./params";
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
	type BlockDecision,
} from "./types";

const FOLDER_OPTION: Record<string, CliOption> = {
	folder: { value: "<path|name|guid>", description: "Local folder", required: true },
};
const FOLDER_FILTER = { folder: { ...FOLDER_OPTION.folder, description: "Local folder (default: all)", required: false } };
/** File-type categories come from the sync settings schema, never a local list. */
const SYNC_CATEGORIES: (keyof SyncFlags)[] = SyncSettingsManager.categories.map((c) => c.key);
const DECISIONS: BlockDecision[] = ["ours", "theirs", "both", "neither"];

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
			`${folder.path} is tracked but not on a Relay Server; use relay:folder:share`,
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
				(!existing.remote ? "; use relay:folder:share with this local --path and the same --relay to attach its server copy again" : ""));
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
		private: { description: "Create owner-only folder; grant users with relay:remote:folder:role:add" },
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
				`${path} is already on ${existing.remote.relay.name}; use relay:folder:detach first`,
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
	description: "Disconnect from server; preserve local history. Reattach with relay:folder:share",
	options: FOLDER_OPTION,
	run(params, ctx) {
		const folder = resolveSharedFolder(ctx, required(params, "folder"));
		const remote = requireRemote(folder);
		const relayName = remote.relay.name;
		folder.detachRemote();
		ctx.sharedFolders.notifyListeners();
		return {
			data: { path: folder.path, guid: folder.guid, previousRelay: relayName },
			text: `${folder.path} is tracked; its copy on ${relayName} was left alone\nReattach with relay:folder:share using this local --path and the same --relay.`,
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

const NOTE_OPTION: Record<string, CliOption> = { path: { value: "<path>", description: "Vault-relative note path", required: true } };

/** What a side of a conflict is, in the CLI's words. */
const SOURCE_WORDS: Record<ConflictSource, string> = {
	editor: "the editor",
	file: "the file on disk",
	record: "this device's record",
	remote: "the remote",
};

const diff: CliCommand = {
	name: "conflict",
	argument: "path",
	description: "Show conflict sides and blocks",
	options: {
		...NOTE_OPTION,
		"all-blocks": { description: "Include automatically merged blocks" },
	},
	async run(params, ctx) {
		const path = notePath(required(params, "path"));
		const info = await ctx.notes.conflictInfo(path);
		const conflict = info.conflict;
		if (!conflict) {
			const data = { path: info.path, state: info.statePath, conflict: false };
			return { data, text: kv([["note", info.path], ["state", info.statePath], ["conflict", false]]) };
		}
		const listAll = flag(params, "all-blocks");
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
	name: "resolve",
	description:
		"Resolve using --block and --take, or replace the whole note with --content or --content-file",
	options: {
		...NOTE_OPTION,
		conflict: { value: "<id>", description: "Conflict ID; rejects stale conflicts", required: true },
		block: { value: "<id>", description: "Block ID" },
		take: { value: "ours|theirs|both|neither", description: "ours: local; theirs: incoming", choices: DECISIONS },
		content: { value: "<text>", description: "Replace whole note; empty clears it. Literal true needs --content-file", allowEmpty: true, preserveWhitespace: true },
		"content-file": { value: "<path>", description: "Replace whole note from vault-relative file" },
	},
	async run(params, ctx) {
		const path = notePath(required(params, "path"));
		const conflictId = required(params, "conflict");
		const block = optional(params, "block");
		const take = optional(params, "take");
		const contentFile = optional(params, "content-file");
		const hasContent = params.content !== undefined;
		const wholeNote = hasContent || contentFile !== undefined;
		if ((hasContent && contentFile) || (wholeNote && (block || take))) {
			throw new CliError("conflicting_options", "Choose --block and --take, or --content, or --content-file");
		}
		if (!wholeNote && !(block && take)) throw new CliError("missing_option", "Give --block and --take, or --content, or --content-file");
		if (hasContent && params.content === "true") throw new CliError("missing_value", "For literal true use --content-file; Obsidian treats --content=true as a bare switch");
		if (!wholeNote && !DECISIONS.includes(take as BlockDecision)) throw new CliError("invalid_value", `--take must be one of ${DECISIONS.join(", ")}`);
		const content = contentFile ? await ctx.vault.readFile(folderPath(contentFile)) : params.content;
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
				`The conflict on ${path} is ${info.conflict.id}, not ${conflictId}: it changed since it was read. Run relay:conflict again`,
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
		{ ...vault, name: "folders" },
		{ ...sharedFolder, commands: [
			track, share, vaultAdd, remoteRemove, untrack, sharedFolderResync,
			{ ...sharedFolderFileTypes, name: "file-types" },
			{ name: "file-type", description: "Local sync file type", register: false, commands: [fileTypeSetting(true), fileTypeSetting(false)] },
		] },
		{ name: "sync", description: "Background sync state", run(_params, ctx) {
			const paused = ctx.backgroundSync.paused();
			return { data: { paused }, text: `Background sync ${paused ? "paused" : "running"}` };
		}, commands: [pause, resume] },
		{ ...conflicts, name: "conflicts" },
		{ ...diff, commands: [diffResolve] },
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
