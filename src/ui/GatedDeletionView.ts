import type { SharedFolder } from "../SharedFolder";
import type { GatedFolderView } from "./GatedDeletionController";

/**
 * Adapts a SharedFolder to the GatedFolderView the controller consumes. Gate
 * snapshots expose sorted, deduplicated folder-relative paths; the view
 * prefixes the shared root for the decision modal's vault-absolute list.
 */
export function sharedFolderGateView(folder: SharedFolder): GatedFolderView {
	return {
		key: folder.guid,
		get name() {
			return folder.name;
		},
		isGated: () => folder.deletionsGated,
		isConnected: () => folder.connected,
		heldPaths: () =>
			(folder.deletionGate()?.paths ?? []).map((heldPath) => {
				const relative = heldPath.replace(/^\//, "") || heldPath;
				return `${folder.path}/${relative}`;
			}),
		send: () => {
			const token = folder.deletionGate()?.token;
			if (token) folder.sendHeldDeletions(token);
		},
		restore: () => {
			const token = folder.deletionGate()?.token;
			if (token) folder.restoreHeldDeletions(token);
		},
		subscribe: (listener) => folder.subscribe({}, () => listener()),
	};
}
