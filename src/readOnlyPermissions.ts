import * as Y from "yjs";
import type { Role } from "./Relay";
import { flags } from "./flagManager";
import type { Fork } from "./merge-hsm/types";

/** Role sent to the server for a folder grant under the current feature flag. */
export function effectiveFolderGrantRole(role: Role): Role {
	return flags().enableReadOnlyPermissions ? role : "Member";
}

/** Whether an HSM state represents a flag-enabled live Reader session. */
export function isReadingAccessState(statePath: string | undefined): boolean {
	return (
		flags().enableReadOnlyPermissions &&
		(statePath?.startsWith("active.reading") ?? false)
	);
}

/**
 * Restore the preserved side of a demotion fork from its own Yjs snapshot.
 * New forks always carry this snapshot; the localDoc fallback keeps older
 * persisted forks reviewable without making current UI depend on mutable text.
 */
export function preservedForkText(
	localDoc: Y.Doc | null,
	fork: Fork | null | undefined,
): string | null {
	if (!localDoc || !fork) return null;
	if (!fork.localSnapshot) {
		return localDoc.getText("contents").toString();
	}

	const originDoc = new Y.Doc({ gc: false });
	let restoredDoc: Y.Doc | null = null;
	try {
		Y.applyUpdate(originDoc, Y.encodeStateAsUpdate(localDoc));
		restoredDoc = Y.createDocFromSnapshot(
			originDoc,
			Y.decodeSnapshot(fork.localSnapshot),
		);
		return restoredDoc.getText("contents").toString();
	} catch {
		return null;
	} finally {
		restoredDoc?.destroy();
		originDoc.destroy();
	}
}
