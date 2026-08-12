export interface FolderOwned<Folder> {
	sharedFolder: Folder;
}

export function changedOwnedItemFolders<Item extends FolderOwned<unknown>>(
	previous: ReadonlySet<Item>,
	current: ReadonlySet<Item>,
): Set<Item["sharedFolder"]> {
	const changed = new Set<Item["sharedFolder"]>();
	for (const item of current) {
		if (!previous.has(item)) changed.add(item.sharedFolder);
	}
	for (const item of previous) {
		if (!current.has(item)) changed.add(item.sharedFolder);
	}
	return changed;
}

export function changedOwnedRecordFolders<
	Key,
	Record extends FolderOwned<unknown>,
>(
	previous: ReadonlyMap<Key, Record>,
	current: ReadonlyMap<Key, Record>,
): Set<Record["sharedFolder"]> {
	const changed = new Set<Record["sharedFolder"]>();
	for (const [key, record] of current) {
		if (previous.get(key) !== record) changed.add(record.sharedFolder);
	}
	for (const [key, record] of previous) {
		if (current.get(key) !== record) changed.add(record.sharedFolder);
	}
	return changed;
}

export function changedFingerprintedKeys<Key>(
	previous: ReadonlyMap<Key, string>,
	current: ReadonlyMap<Key, string>,
): Set<Key> {
	const changed = new Set<Key>();
	for (const [key, fingerprint] of current) {
		if (previous.get(key) !== fingerprint) changed.add(key);
	}
	for (const key of previous.keys()) {
		if (!current.has(key)) changed.add(key);
	}
	return changed;
}
