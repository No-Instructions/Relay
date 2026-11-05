import type { Relay } from "src/Relay";
import type { SharedFolder } from "src/SharedFolder";

export interface SharedFolderRelayGroup {
	relayId: string | undefined;
	relay: Relay | undefined;
	folders: SharedFolder[];
}

export function groupSharedFoldersByRelay(
	folders: SharedFolder[],
	relays: Relay[],
): SharedFolderRelayGroup[] {
	const relaysByGuid = new Map(relays.map((relay) => [relay.guid, relay]));
	const groups = new Map<string | undefined, SharedFolderRelayGroup>();
	for (const folder of folders) {
		const remoteRelay = folder.remote?.relay;
		const relayId = remoteRelay?.guid ?? folder.relayId;
		let group = groups.get(relayId);
		if (!group) {
			group = {
				relayId,
				relay: remoteRelay ?? (relayId ? relaysByGuid.get(relayId) : undefined),
				folders: [],
			};
			groups.set(relayId, group);
		}
		group.relay ??= remoteRelay;
		group.folders.push(folder);
	}
	return Array.from(groups.values());
}
