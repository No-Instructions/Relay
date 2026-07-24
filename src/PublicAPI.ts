import type Live from "./main";

export interface RelayIdentity {
	id: string;
	name: string;
	picture?: string;
	color?: string;
	colorLight?: string;
}

export interface RelayIdentityApi {
	getCurrentUser(path: string): Promise<RelayIdentity | null>;
	resolveUser(id: string, path: string): Promise<RelayIdentity | null>;
}

export interface RelayPublicApiV1 {
	version: 1;
	identity: RelayIdentityApi;
}

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
				if (!plugin.sharedFolders.lookup(path)) return null;
				return toIdentity(
					plugin.loginManager.user ?? plugin.relayManager.user,
				);
			},

			async resolveUser(
				id: string,
				path: string,
			): Promise<RelayIdentity | null> {
				const folder = plugin.sharedFolders.lookup(path);
				if (!folder) return null;
				const user =
					(plugin.loginManager.user?.id === id
						? plugin.loginManager.user
						: undefined) ??
					plugin.relayManager.users.get(id) ??
					(plugin.relayManager.user?.id === id
						? plugin.relayManager.user
						: undefined);
				const identity = toIdentity(user);
				if (identity) return identity;
				const name = folder.getUserDisplayName(id)?.trim();
				return name ? { id, name } : null;
			},
		},
	};
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
