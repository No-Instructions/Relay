import type { TAbstractFile } from "obsidian";
import type { SharedFolder } from "./SharedFolder";

export function routeVaultDelete(folder: SharedFolder, vpath: string): boolean {
	folder.notifyVaultDelete(vpath);
	return folder.folderHSM !== null;
}

export function routeVaultRename(
	file: TAbstractFile,
	oldPath: string,
	fromFolder: SharedFolder | null,
	toFolder: SharedFolder | null,
): boolean {
	if (fromFolder && fromFolder === toFolder) {
		fromFolder.notifyVaultRename(file, oldPath);
		return true;
	}
	if (fromFolder && toFolder) {
		fromFolder.renameFile(file, oldPath);
		toFolder.renameFile(file, oldPath);
		return true;
	}
	const folder = fromFolder || toFolder;
	if (!folder) {
		return false;
	}
	folder.renameFile(file, oldPath);
	return true;
}
