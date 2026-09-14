/**
 * Loose deep comparison of plain objects. A key whose value is undefined
 * counts as absent, so an in-memory object compares equal to its own JSON
 * round trip: JSON.stringify drops such keys, and a comparison that did
 * not would call a canvas node freshly rendered from disk unequal to the
 * disk copy it was rendered from.
 */
export function areObjectsEqual(obj1: unknown, obj2: unknown): boolean {
	if (!obj1 || !obj2) return false;
	const a = obj1 as Record<string, unknown>;
	const b = obj2 as Record<string, unknown>;

	// Every defined value in obj1 must match obj2.
	for (const key in a) {
		const value = a[key];
		if (value === undefined) {
			if (b[key] !== undefined) return false;
		} else if (typeof value === "object" && value !== null) {
			if (!areObjectsEqual(value, b[key])) return false;
		} else if (value !== b[key]) {
			return false;
		}
	}

	// Every defined value in obj2 must have a counterpart in obj1.
	for (const key in b) {
		if (b[key] !== undefined && !(key in a)) return false;
	}

	return true;
}
