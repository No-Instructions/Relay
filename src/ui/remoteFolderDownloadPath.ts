/** Derive a safe target from the remote name without merging existing contents. */
export function remoteFolderDownloadPath(
	name: string,
	normalizePath: (name: string) => string,
	pathExists: (path: string) => boolean,
): string {
	const path = normalizePath(name);
	if (
		!path ||
		path === "/" ||
		path.split("/").some((part) => part === ".." || part === ".")
	) {
		throw new Error("Choose a folder name and location in folder settings.");
	}
	if (pathExists(path)) {
		throw new Error(
			`“${path}” already exists. Use folder settings to choose another location.`,
		);
	}
	return path;
}
