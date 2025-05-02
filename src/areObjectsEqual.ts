// Function to perform loose comparison of objects
export function areObjectsEqual(obj1: any, obj2: any): boolean {
	if (!obj1 || !obj2) return false;

	// Check if all keys and values in obj1 match obj2
	for (const key in obj1) {
		if (typeof obj1[key] === "object" && obj1[key] !== null) {
			if (!areObjectsEqual(obj1[key], obj2[key])) return false;
		} else if (obj1[key] !== obj2[key]) {
			return false;
		}
	}

	// Check if all keys in obj2 exist in obj1
	for (const key in obj2) {
		if (!(key in obj1)) return false;
	}

	return true;
}
