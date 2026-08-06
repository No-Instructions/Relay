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
	// NOTE: this is called on every file at startup. The navigation refresh is
	// folder-scoped and microtask-coalesced across that event burst.
	const folder = host.sharedFolders.lookup(tfile.path);
	if (!folder) return;

	// New read-only files deliberately do not mutate the sync store, so they
	// need an explicit repaint to receive their NOT SYNCED marker.
	host.folderNavDecorations.fileCreated(folder);

	// A known file materializes immediately; a new file's registration settles
	// for a debounce window so a short-lived atomic-write temp file vanishes
	// before it is place-held and uploaded.
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
