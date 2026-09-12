import type { FolderRole, Relay, RelayRole, RelayUser, RemoteSharedFolder } from "../Relay";
import { folderPath } from "./params";
import { CliError, type CliContext, type CliSharedFolder } from "./types";

interface Keys {
	/** Matched exactly, case-sensitive: guids and ids. */
	exact: string[];
	/** Matched case-insensitively, then by substring: names and paths. */
	names: string[];
}

interface Candidate {
	name: string;
	guid: string;
}

/**
 * Resolve a pointer flag: a guid or id wins outright, then an exact name,
 * then a unique substring. Zero or several matches fail with candidates.
 */
export function pick<T>(
	kind: string,
	ref: string,
	items: T[],
	keys: (item: T) => Keys,
	describe: (item: T) => Candidate,
): T {
	const wanted = ref.trim();
	const lower = wanted.toLowerCase();
	const byId = items.filter((item) => keys(item).exact.includes(wanted));
	if (byId.length === 1) return byId[0];
	const byName = items.filter((item) =>
		keys(item).names.some((name) => name.toLowerCase() === lower),
	);
	if (byName.length === 1) return byName[0];
	const bySubstring = items.filter((item) =>
		keys(item).names.some((name) => name.toLowerCase().includes(lower)),
	);
	const matches = byName.length > 1 ? byName : bySubstring;
	if (matches.length === 1) return matches[0];
	const candidates = (matches.length > 1 ? matches : items).map(describe);
	const label = kind.replace(/_/g, " ");
	if (matches.length > 1) {
		throw new CliError(`ambiguous_${kind}`, `Several ${label}s match "${wanted}"`, { candidates });
	}
	throw new CliError(`${kind}_not_found`, `No ${label} matches "${wanted}"`, { candidates });
}

export function resolveRelay(ctx: CliContext, ref: string): Relay {
	return pick(
		"relay",
		ref,
		ctx.relayManager.relays.values(),
		(relay) => ({ exact: [relay.guid, relay.id], names: [relay.name] }),
		(relay) => ({ name: relay.name, guid: relay.guid }),
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
	);
}

export function resolveRemoteFolder(relay: Relay, ref: string): RemoteSharedFolder {
	return pick(
		"folder",
		ref,
		relay.folders.values(),
		(remote) => ({ exact: [remote.guid, remote.id], names: [remote.name] }),
		(remote) => ({ name: remote.name, guid: remote.guid }),
	);
}

export function rolesOnRelay(ctx: CliContext, relay: Relay): RelayRole[] {
	return ctx.relayManager.relayRoles
		.values()
		.filter((role) => role.relayId === relay.id || role.relay?.guid === relay.guid);
}

export function rolesOnFolder(ctx: CliContext, remote: RemoteSharedFolder): FolderRole[] {
	return ctx.relayManager.folderRoles
		.values()
		.filter((role) => role.sharedFolderId === remote.id || role.sharedFolder?.guid === remote.guid);
}

const userKeys = (user: RelayUser): Keys => ({
	exact: [user.id],
	names: [user.name ?? "", user.email ?? ""].filter(Boolean),
});
const userCandidate = (user: RelayUser): Candidate => ({
	name: user.email ? `${user.name} <${user.email}>` : user.name,
	guid: user.id,
});

export function resolveRelayRole(ctx: CliContext, relay: Relay, ref: string): RelayRole {
	return pick(
		"user",
		ref,
		rolesOnRelay(ctx, relay),
		(role) => userKeys(role.user),
		(role) => userCandidate(role.user),
	);
}

export function resolveUser(ctx: CliContext, relay: Relay, ref: string): RelayUser {
	return resolveRelayRole(ctx, relay, ref).user;
}
