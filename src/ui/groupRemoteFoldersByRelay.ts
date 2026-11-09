import type { Relay, RemoteSharedFolder } from "../Relay";

/** A folder can outlive its Relay Server record during a local cascade. */
export function remoteFolderRelay(
	folder: RemoteSharedFolder,
): Relay | undefined {
	try {
		return folder.relay;
	} catch {
		return undefined;
	}
}

/** Apply the Relay Server folder view's access gate without allocating derived maps. */
export function accessibleRemoteFolders(
	relays: Relay[],
	folders: RemoteSharedFolder[],
): RemoteSharedFolder[] {
	const relayIds = new Set(relays.map((relay) => relay.id));
	return folders.filter(
		(folder) =>
			relayIds.has(folder.relayId) && folder.permissionParents.length > 0,
	);
}

export function groupRemoteFoldersByRelay(folders: RemoteSharedFolder[]) {
	const groups = new Map<
		string,
		{ relay: Relay; folders: RemoteSharedFolder[] }
	>();
	const resolved: { relay: Relay; folder: RemoteSharedFolder }[] = [];
	for (const folder of folders) {
		const relay = remoteFolderRelay(folder);
		if (relay && folder.name) resolved.push({ relay, folder });
	}
	resolved.sort((a, b) =>
		(a.relay.name + "/" + a.folder.name).localeCompare(
			b.relay.name + "/" + b.folder.name,
		),
	);
	for (const { relay, folder } of resolved) {
		let group = groups.get(relay.guid);
		if (!group) {
			group = { relay, folders: [] };
			groups.set(relay.guid, group);
		}
		group.folders.push(folder);
	}
	return Array.from(groups.values());
}
