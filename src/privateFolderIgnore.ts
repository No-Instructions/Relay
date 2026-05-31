"use strict";

export const RELAY_IGNORE_FILE_NAME = ".relayignore";

export function splitVaultPath(path: string): string[] {
	return path.split(/[\\/]+/).filter(Boolean);
}

export function normalizeVirtualPath(path: string): string {
	return splitVaultPath(path).join("/");
}

export function isRelayIgnoreMarkerPath(path: string): boolean {
	const parts = splitVaultPath(path);
	return parts[parts.length - 1] === RELAY_IGNORE_FILE_NAME;
}

export function relayIgnoreMarkerPath(folderPath: string): string {
	const normalized = normalizeVirtualPath(folderPath);
	return normalized ? `${normalized}/${RELAY_IGNORE_FILE_NAME}` : RELAY_IGNORE_FILE_NAME;
}

export function markerOwnerPath(markerPath: string): string {
	const parts = splitVaultPath(markerPath);
	if (parts[parts.length - 1] === RELAY_IGNORE_FILE_NAME) {
		parts.pop();
	}
	return parts.join("/");
}
