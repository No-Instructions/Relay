/**
 * Pending-sync-state probes for the folder docs, and the drain observer
 * that re-arms a deferred provenance ladder.
 *
 * A deletion that reaches a replica as a delete-set entry without its
 * struct cannot apply: it parks in the doc's pending state and the
 * membership map understates remote deletions. While any folder doc
 * holds such state the bootstrap provenance ladder must not classify
 * (see FolderHSM.runProvenanceLadder); once it drains, the deletion
 * stands as an ordinary tombstone and the ladder can run honestly.
 */

import type * as Y from "yjs";
import type { FolderEvent } from "./types";

/** The slice of the machine the drain observer needs. */
interface DeferredLadderHost {
	context: { ladderDeferred: boolean };
	send(event: FolderEvent): void;
}

/**
 * Whether any of the given docs holds pending sync state: structs whose
 * dependencies never arrived, or a delete set with no structs to attach
 * to (the signature of a deletion delivered for a key this replica
 * never held). Reads the live docs only — a persisted readiness latch
 * can declare a folder synced while the current session's handshake is
 * incomplete or faulty. Tolerates docs that are not fully constructed
 * (test harnesses, teardown races): no readable store means nothing
 * pending.
 */
export function docsHavePendingSyncState(
	...docs: Array<Y.Doc | null | undefined>
): boolean {
	return docs.some(
		(doc) =>
			doc?.store != null &&
			(doc.store.pendingStructs !== null || doc.store.pendingDs !== null),
	);
}

/**
 * Report the drain of pending sync state to a machine whose provenance
 * ladder deferred on it. Every folder-doc transaction that integrates
 * structs can complete the drain, so the probe runs after each update;
 * the checks are two null reads and the machine consumes SYNC_DRAINED
 * only while a deferred ladder is armed. Returns the uninstaller.
 */
export function observeSyncDrain(
	hsm: DeferredLadderHost,
	docs: Array<Y.Doc | null | undefined>,
): () => void {
	const live = docs.filter((doc): doc is Y.Doc => doc != null);
	const onUpdate = () => {
		if (hsm.context.ladderDeferred && !docsHavePendingSyncState(...live)) {
			hsm.send({ type: "SYNC_DRAINED" });
		}
	};
	for (const doc of live) doc.on("update", onUpdate);
	return () => {
		for (const doc of live) doc.off("update", onUpdate);
	};
}
