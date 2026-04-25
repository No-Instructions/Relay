import { dirname, sep } from "path-browserify";

export function expandDesiredRemotePaths(paths: Iterable<string>): Set<string> {
	const desiredPaths = new Set<string>();
	for (const path of paths) {
		desiredPaths.add(path);

		let parent = dirname(path);
		while (parent && parent !== "." && parent !== sep) {
			desiredPaths.add(parent);
			parent = dirname(parent);
		}
	}
	return desiredPaths;
}
