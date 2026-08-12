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
