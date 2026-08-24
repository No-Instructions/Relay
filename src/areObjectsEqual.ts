// Function to perform loose comparison of objects
export function areObjectsEqual(obj1: unknown, obj2: unknown): boolean {
	if (!obj1 || !obj2) return false;
	const a = obj1 as Record<string, unknown>;
	const b = obj2 as Record<string, unknown>;

	// Check if all keys and values in obj1 match obj2
	for (const key in a) {
		const value = a[key];
		if (typeof value === "object" && value !== null) {
			if (!areObjectsEqual(value, b[key])) return false;
		} else if (value !== b[key]) {
			return false;
		}
	}

	// Check if all keys in obj2 exist in obj1
	for (const key in b) {
		if (!(key in a)) return false;
	}

	return true;
}
