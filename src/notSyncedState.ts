import type { TFile } from "obsidian";
import type { SharedFolder } from "./SharedFolder";

export interface NotSyncedPillState {
	label: string;
	reason: string;
}

/** Shared decision for the file explorer and the open-file banner. */
export function notSyncedPillState(sharedFolder: SharedFolder, file: TFile): NotSyncedPillState | null {
	if (!sharedFolder.checkPath(file.path)) return null;
	if (sharedFolder.isStorageBlockedTFile(file)) {
		return { label: "Attachment storage is required to sync this file", reason: "storage-required" };
	}
	if (!sharedFolder.isSyncableTFile(file)) {
		return { label: "Syncing this file type is disabled", reason: "file-type-disabled" };
	}
	if (sharedFolder.ready && !sharedFolder.canManageFiles &&
		!sharedFolder.syncStore.has(sharedFolder.getVirtualPath(file.path))) {
		return {
			label: "This file is only on this device: the folder is read-only for you",
			reason: "read-only-folder",
		};
	}
	return null;
}
