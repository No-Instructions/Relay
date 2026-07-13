/**
 * Whether a "[Create] <path>" suggestion should be offered for the typed query
 * in the folder-share pickers. Sharing the vault root is invalid and the share
 * flow adds already-shared / reserved folders (and the root `/`) to
 * `blockedPaths`; the create branch must honor that guard, not just the
 * existing-folder list.
 *
 * @param trimmed      the trimmed query text
 * @param isExisting   whether the query already matches a listed folder
 * @param blockedPaths paths the picker must not offer (includes the vault root)
 */
export function shouldOfferCreate(
	trimmed: string,
	isExisting: boolean,
	blockedPaths: Set<string>,
): boolean {
	if (!trimmed || isExisting) return false;
	// blockedPaths (and the vault folder tree) spell the root as "/" and every
	// other folder without a leading slash. Normalize the typed query to that
	// form so a bare and a leading-slash spelling both resolve to one path.
	const normalized = trimmed.replace(/^\/+/, "");
	// The vault root is never shareable.
	if (normalized === "") return false;
	// Respect the blocked-path list (already-shared / reserved folders).
	if (blockedPaths.has(normalized)) return false;
	return true;
}
