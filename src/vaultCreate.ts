import type { TAbstractFile } from "obsidian";
import { isDestroyedError } from "./DestroyedError";
import type { SharedFolders } from "./SharedFolder";
import type { FolderNavigationDecorations } from "./ui/FolderNav";

interface VaultCreateHost {
	sharedFolders: SharedFolders;
	folderNavDecorations: FolderNavigationDecorations;
	warn: (...args: unknown[]) => void;
}

/** Handle an Obsidian vault create event for shared-folder state and UI. */
export function handleVaultCreate(
	host: VaultCreateHost,
	tfile: TAbstractFile,
): void {
	// Obsidian fires this for every file at startup; fileCreated coalesces repaints.
	const folder = host.sharedFolders.lookup(tfile.path);
	if (!folder) return;

	// A file with no membership record only gets its marker from a repaint.
	host.folderNavDecorations.fileCreated(folder);

	// A new file's registration is debounced so an atomic-write temp file
	// can vanish first.
	if (folder.notifyVaultCreateLegacy(tfile)) {
		folder
			.whenReady()
			.then((folder) => {
				folder.getFile(tfile);
			})
			.catch((error) => {
				if (isDestroyedError(error)) return;
				host.warn("folder ready failed after file create", error);
			});
	}
}
