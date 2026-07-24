import type Live from "./main";
import type { SharedFolder } from "./SharedFolder";
import type {
	RelayIdentity,
	RelayIdentityApi,
	RelayPublicApiV1,
} from "../relay-plugin-api";

// The published declaration file is the contract. Re-export it here so plugin
// code and consumers compile against one definition and cannot drift apart.
export type { RelayIdentity, RelayIdentityApi, RelayPublicApiV1 };

interface RelayUserLike {
	id?: string;
	name?: string;
	picture?: string;
	color?: string | { color?: string; light?: string };
	colorLight?: string;
}

export function createRelayPublicApi(plugin: Live): RelayPublicApiV1 {
	return {
		version: 1,
		identity: {
			async getCurrentUser(path: string): Promise<RelayIdentity | null> {
				if (isUnavailable(plugin)) return null;
				if (!plugin.sharedFolders.lookup(path)) return null;
				return toIdentity(
					plugin.loginManager.user ?? plugin.relayManager.user,
				);
			},

			async resolveUser(
				id: string,
				path: string,
			): Promise<RelayIdentity | null> {
				if (isUnavailable(plugin)) return null;
				const folder = plugin.sharedFolders.lookup(path);
				if (!folder) return null;
				const localUser = localUserWithId(plugin, id);
				if (localUser) return toIdentity(localUser);
				if (!isFolderMember(plugin, folder, id)) return null;
				return toIdentity(plugin.relayManager.users.get(id));
			},
		},
	};
}

/**
 * Teardown replaces the managers this API reads, and the ready event fires at
 * most twice at startup, so consumers are expected to hold the api object for
 * the lifetime of their own plugin. Every entry point therefore checks the same
 * unloading flag the plugin's other consumer-facing callbacks check: a call
 * that arrives after Relay unloads resolves to null instead of throwing an
 * unhandled rejection inside the caller.
 */
function isUnavailable(plugin: Live): boolean {
	return (
		plugin.isUnloading ||
		!plugin.sharedFolders ||
		!plugin.loginManager ||
		!plugin.relayManager
	);
}

function localUserWithId(plugin: Live, id: string): RelayUserLike | undefined {
	if (plugin.loginManager.user?.id === id) return plugin.loginManager.user;
	if (plugin.relayManager.user?.id === id) return plugin.relayManager.user;
	return undefined;
}

/**
 * The manager's user map is flat: it holds every user the vault has seen across
 * every relay it belongs to, so it cannot answer whether an id belongs to one
 * folder. Membership is read the way the folder management UI reads it — a
 * private folder's members are the folder roles naming it, held by users who
 * also still hold a role on the hosting relay; any other folder's members are
 * everyone with a role on that relay. A folder with no remote has no members
 * beyond the local user.
 */
function isFolderMember(
	plugin: Live,
	folder: SharedFolder,
	id: string,
): boolean {
	const remote = folder.remote;
	if (!remote) return false;
	const onRelay = plugin.relayManager.relayRoles.some(
		(role) => role.relayId === remote.relayId && role.userId === id,
	);
	if (!onRelay) return false;
	if (!remote.private) return true;
	return plugin.relayManager.folderRoles.some(
		(role) => role.sharedFolderId === remote.id && role.userId === id,
	);
}

function toIdentity(user: RelayUserLike | undefined): RelayIdentity | null {
	if (!user) return null;
	const id = user.id?.trim();
	const name = user.name?.trim();
	if (!id || !name) return null;
	const color =
		typeof user.color === "string" ? user.color : user.color?.color;
	const colorLight =
		user.colorLight ??
		(typeof user.color === "string" ? undefined : user.color?.light);
	return {
		id,
		name,
		...(user.picture ? { picture: user.picture } : {}),
		...(color ? { color } : {}),
		...(colorLight ? { colorLight } : {}),
	};
}
