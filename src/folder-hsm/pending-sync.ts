/**
 * Trust probes for the folder docs, and the drain observer that re-arms
 * a deferred classification pass.
 *
 * A deletion can reach a replica as sync data that cannot yet apply (its
 * dependencies never arrived, or a delete set references structs this
 * replica never held). It then parks in the doc's pending state and the
 * membership map understates remote deletions: a deleted path reads as
 * never present. While any folder doc holds such state, classification
 * must not read the map (see FolderHSM.runClassification); once it
 * drains, the deletion stands as an ordinary tombstone and
 * classification can run honestly.
 *
 * The probe reads the LIVE docs only — a persisted readiness marker can
 * declare a folder synced while the current session's exchange is
 * incomplete or faulty.
 */

import type * as Y from "yjs";
import type { FolderEvent } from "./types";

/** The slice of the machine the drain observer needs. */
interface DeferredClassificationHost {
	context: { classificationDeferred: boolean };
	send(event: FolderEvent): void;
}

/**
 * Whether any of the given docs holds pending sync state. Tolerates
 * docs that are not fully constructed (test harnesses, teardown races):
 * no readable store means nothing pending.
 */
export function docsHavePendingSyncState(
	...docs: Array<Y.Doc | null | undefined>
): boolean {
	return docs.some((doc) => {
		const store = doc?.store as
			| { pendingStructs?: unknown; pendingDs?: unknown }
			| undefined;
		if (store == null) return false;
		return store.pendingStructs != null || store.pendingDs != null;
	});
}

/**
 * Report the drain of pending sync state to a machine whose
 * classification pass deferred on it. Every folder-doc transaction that
 * integrates structs can complete the drain, so the probe runs after
 * each update; the checks are two null reads and the machine consumes
 * SYNC_DRAINED only while a deferred pass is armed. Returns the
 * uninstaller.
 */
export function observeSyncDrain(
	hsm: DeferredClassificationHost,
	docs: Array<Y.Doc | null | undefined>,
): () => void {
	const live = docs.filter((doc): doc is Y.Doc => doc != null);
	const onUpdate = () => {
		if (
			hsm.context.classificationDeferred &&
			!docsHavePendingSyncState(...live)
		) {
			hsm.send({ type: "SYNC_DRAINED" });
		}
	};
	for (const doc of live) doc.on("update", onUpdate);
	return () => {
		for (const doc of live) doc.off("update", onUpdate);
	};
}
