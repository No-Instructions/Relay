import type { SyncStatus } from "src/merge-hsm/types";

export function changedSyncStatusGuids(
	previous: ReadonlyMap<string, SyncStatus>,
	current: ReadonlyMap<string, SyncStatus>,
): Set<string> {
	const changed = new Set<string>();
	for (const [guid, status] of current) {
		if (previous.get(guid) !== status) {
			changed.add(guid);
		}
	}
	for (const guid of previous.keys()) {
		if (!current.has(guid)) {
			changed.add(guid);
		}
	}
	return changed;
}
