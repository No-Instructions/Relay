import * as Y from "yjs";
import { restoreTextAtSnapshot } from "./merge-hsm/snapshots";
import type { Fork } from "./merge-hsm/types";

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

	return restoreTextAtSnapshot(
		localDoc,
		{ snapshot: fork.localSnapshot },
		"contents",
	);
}
