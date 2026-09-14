import type { RemoteSharedFolder } from "./Relay";

/**
 * The remote record a folder binds to, given every record the relay manager
 * holds. A detached folder binds to none. A folder that names a Relay Server
 * binds only to that server's copy, so a copy of the same folder on another
 * server never claims it. A folder that names no server adopts a copy that
 * carries its guid, which is how a folder recovers its remote once access is
 * restored.
 */
export function matchRemoteFolder(
	folder: { guid: string; relayId?: string; detached?: boolean },
	remotes: RemoteSharedFolder[],
): RemoteSharedFolder | undefined {
	if (folder.detached) return undefined;
	const candidates = remotes.filter((remote) => remote.guid == folder.guid);
	if (candidates.length === 0) return undefined;
	if (!folder.relayId) return candidates[0];
	const relayGuidOf = (remote: RemoteSharedFolder): string | undefined => {
		try {
			return remote.relay?.guid;
		} catch {
			return undefined;
		}
	};
	return candidates.find((remote) => {
		const relayGuid = relayGuidOf(remote);
		return relayGuid ? relayGuid === folder.relayId : candidates.length === 1;
	});
}
