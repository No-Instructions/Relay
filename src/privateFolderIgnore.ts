"use strict";

export const DEFAULT_IGNORED_FOLDER_NAME = "_private";

export function isValidIgnoredFolderName(name: string): boolean {
	const trimmed = name.trim();
	return !!trimmed && !/[\\/]/.test(trimmed);
}

export function normalizeIgnoredFolderName(name?: string): string {
	const trimmed = name?.trim();
	if (!trimmed || !isValidIgnoredFolderName(trimmed)) {
		return DEFAULT_IGNORED_FOLDER_NAME;
	}
	return trimmed;
}

export function pathContainsIgnoredFolderSegment(
	path: string,
	ignoredFolderName = DEFAULT_IGNORED_FOLDER_NAME,
): boolean {
	const ignoredSegment = normalizeIgnoredFolderName(ignoredFolderName);
	return path
		.split(/[\\/]+/)
		.filter(Boolean)
		.includes(ignoredSegment);
}
