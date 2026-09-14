import type { FolderRole, Relay, RelayRole, RelayUser, RemoteSharedFolder } from "../Relay";
import { folderPath } from "./params";
import { CliError, type CliContext, type CliSharedFolder } from "./types";
import type { ServerContext } from "./server";
export type Suggest = <T>(query: string, items: readonly T[], labels: (item: T) => readonly string[]) => T[];

/** Portable fallback; host adapters can supply their own ranked matcher. */
const matchingLabels: Suggest = (query, items, labels) => items.filter((item) =>
	labels(item).some((label) => label.toLowerCase().includes(query.toLowerCase()))).slice(0, 3);

interface Keys {
	/** Matched exactly, case-sensitive: guids and ids. */
	exact: string[];
	/** Matched case-insensitively by complete name or path. */
	names: string[];
}

interface Candidate {
	name: string;
	guid?: string;
}

/**
 * Resolve an exact id or complete name. Zero or several matches fail with
 * alternatives; a fragment must never select a mutation's target.
 */
export function pick<T>(
	kind: string,
	ref: string,
	items: T[],
	keys: (item: T) => Keys,
	describe: (item: T) => Candidate,
	suggest: Suggest = matchingLabels,
): T {
	const wanted = ref.trim();
	const lower = wanted.toLowerCase();
	const byId = items.filter((item) => keys(item).exact.includes(wanted));
	if (byId.length === 1) return byId[0];
	const byName = items.filter((item) =>
		keys(item).names.some((name) => name.toLowerCase() === lower),
	);
	if (byId.length === 0 && byName.length === 1) return byName[0];
	const matches = byId.length > 0 ? byId : byName;
	const label = kind.replace(/_/g, " ");
	if (matches.length > 1) {
		throw new CliError(`ambiguous_${kind}`, `Several ${label}s match "${wanted}"`, { candidates: matches.map(describe) });
	}
	const suggestions = suggest(wanted, items, (item) => [...keys(item).names, ...keys(item).exact]).map(describe);
	throw new CliError(`${kind}_not_found`, `No ${label} matches "${wanted}"`, suggestions.length ? { suggestions } : {});
}

export function resolveRelay(ctx: ServerContext, ref: string): Relay {
	return pick(
		"relay",
		ref,
		ctx.relayManager.relays.values(),
		(relay) => ({ exact: [relay.guid, relay.id], names: [relay.name] }),
		(relay) => ({ name: relay.name, guid: relay.guid }),
		ctx.suggest,
	);
}

export function resolveSharedFolder(ctx: CliContext, ref: string): CliSharedFolder {
	return pick(
		"shared_folder",
		folderPath(ref),
		ctx.sharedFolders.items(),
		(folder) => ({
			exact: [folder.guid, folder.path],
			names: [folder.path, folder.path.split("/").pop() ?? folder.path],
		}),
		(folder) => ({ name: folder.path, guid: folder.guid }),
		ctx.suggest,
	);
}

export function resolveRemoteFolder(relay: Relay, ref: string, suggest?: Suggest): RemoteSharedFolder {
	return pick(
		"folder",
		ref,
		relay.folders.values(),
		(remote) => ({ exact: [remote.guid, remote.id], names: [remote.name] }),
		(remote) => ({ name: remote.name, guid: remote.guid }),
		suggest,
	);
}

export function rolesOnRelay(ctx: ServerContext, relay: Relay): RelayRole[] {
	return ctx.relayManager.relayRoles
		.values()
		.filter((role) => role.relayId === relay.id);
}

export function rolesOnFolder(ctx: ServerContext, remote: RemoteSharedFolder): FolderRole[] {
	return ctx.relayManager.folderRoles
		.values()
		.filter((role) => role.sharedFolderId === remote.id);
}

const userKeys = (user: RelayUser): Keys => ({
	exact: [user.id],
	names: [user.name ?? "", user.email ?? ""].filter(Boolean),
});
const userCandidate = (user: RelayUser): Candidate => ({
	name: user.email ? `${user.name} <${user.email}>` : user.name,
	guid: user.id,
});

export function resolveRelayRole(ctx: ServerContext, relay: Relay, ref: string): RelayRole {
	return pick(
		"user",
		ref,
		rolesOnRelay(ctx, relay),
		(role) => userKeys(role.user),
		(role) => userCandidate(role.user),
		ctx.suggest,
	);
}

export function resolveUser(ctx: ServerContext, relay: Relay, ref: string): RelayUser {
	return resolveRelayRole(ctx, relay, ref).user;
}
