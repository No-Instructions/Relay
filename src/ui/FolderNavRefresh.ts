import type { SyncStatus } from "src/merge-hsm/types";

interface PathItem {
	path: string;
}

export function changedQueueItemPaths<T extends PathItem>(
	previous: ReadonlySet<T>,
	current: ReadonlySet<T>,
): Set<string> {
	const changed = new Set<string>();
	for (const item of current) {
		if (!previous.has(item)) {
			changed.add(item.path);
		}
	}
	for (const item of previous) {
		if (!current.has(item)) {
			changed.add(item.path);
		}
	}
	return changed;
}

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
