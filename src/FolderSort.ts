interface HasPath {
	path: string;
}

export function compareFilePaths(a: HasPath, b: HasPath): number {
	const aParts = a.path.split("/");
	const bParts = b.path.split("/");
	// Root files go last
	if (aParts.length === 2 && bParts.length > 2) return 1;
	if (bParts.length === 2 && aParts.length > 2) return -1;

	// Compare each path segment
	const minLength = Math.min(aParts.length, bParts.length);
	for (let i = 0; i < minLength; i++) {
		if (aParts[i] !== bParts[i]) {
			// For filenames (last part), compare numerically
			if (i === aParts.length - 1) {
				// Extract numbers from the strings
				const aMatches = aParts[i].match(/\d+/g);
				const bMatches = bParts[i].match(/\d+/g);

				if (aMatches && bMatches) {
					// Compare the first numbers found
					const aNum = parseInt(aMatches[0]);
					const bNum = parseInt(bMatches[0]);
					if (aNum !== bNum) {
						return aNum - bNum;
					}
				}
			}
			return aParts[i].localeCompare(bParts[i]);
		}
	}

	// When paths match up to shorter length, shortest wins
	return aParts.length - bParts.length;
}
