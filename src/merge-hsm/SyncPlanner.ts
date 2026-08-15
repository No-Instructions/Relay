import type { Document } from "../Document";
import type { Canvas } from "../Canvas";
import type { SyncFile } from "../SyncFile";
import type {
	FolderPassRequest,
	SyncWorkRequest,
} from "../background-sync/types";
import { snapshotFromDoc } from "./snapshots";

/** Deduplication input from the executor: is this guid already worked? */
export type InFlightCheck = (guid: string) => boolean;

// Selection takes already-narrowed targets: callers dispatch on the type
// guards they already hold. Importing the concrete classes here would drag
// the whole app graph (providers, auth) under every merge-hsm consumer, so
// this module is type-only toward the file types.

// A document edited offline whose sync session did not converge (e.g. the
// server refuses the ops) stays advertised-out-of-sync forever; without a
// rate limit every subdoc index sync would re-enqueue a full session for it.
export const LOCAL_AHEAD_RETRY_INTERVAL_MS = 5 * 60_000;

/** A conflicted document belongs to the user, not the queue. */
export function isDocumentConflicted(doc: Document): boolean {
	return doc.hsm?.getSyncStatus().status === "conflict";
}

/**
 * Whether an advertised canvas head differs from local state. A hibernated
 * canvas compares against its persisted local head; snapshotting the
 * ephemeral remoteDoc (empty every fresh session) would flag every canvas
 * on every folder sync.
 */
export function canvasAdvertisedOutOfSync(canvas: Canvas): boolean {
	const mergeManager = canvas.sharedFolder.mergeManager;
	if (!mergeManager) return true;
	return !mergeManager.isServerAdvertisedInSync(
		canvas.guid,
		canvas.isMaterialized ? snapshotFromDoc(canvas.ydoc).snapshot : undefined,
	);
}

/** Folder-pass selection for an attachment. */
export function shouldSelectFileForFolderSync(file: SyncFile): boolean {
	return !file.sharedFolder.shouldDeferPendingPublication(file.path);
}

/** Folder-pass selection for a canvas. */
export function shouldSelectCanvasForFolderSync(canvas: Canvas): boolean {
	return canvasAdvertisedOutOfSync(canvas);
}

/** Folder-pass selection for a document. */
export function shouldSelectDocumentForFolderSync(doc: Document): boolean {
	const hsm = doc.hsm;
	if (!hsm) return true;
	if (hsm.getSyncStatus().status === "conflict") return false;
	if (!hsm.state.lca) return true;
	if (hsm.getSyncStatus().status !== "synced") return true;

	const mergeManager = doc.sharedFolder.mergeManager;
	if (!mergeManager) return true;

	return !mergeManager.isServerAdvertisedInSync(doc.guid);
}

/**
 * Selection for advertised-head syncs. The attempt clock rate-limits
 * local-ahead flushes: the map records, per guid, when a flush session last
 * started. An advertised-in-sync doc clears its entry; an eligible
 * local-ahead doc records the attempt.
 */
export function shouldEnqueueForRemoteHeadSync(
	doc: Document,
	localAheadAttempts: Map<string, number>,
	now: number,
): boolean {
	if (isDocumentConflicted(doc)) return false;
	if (doc.hsm?.hasFork()) return false;
	const mergeManager = doc.sharedFolder.mergeManager;
	if (!mergeManager) return false;
	if (mergeManager.isServerAdvertisedRemoteAhead(doc.guid)) return true;
	// A document edited in the editor while offline and closed before
	// reconnect holds local ops the server lacks. It has no fork and no
	// open editor, so no other path pushes those ops — run a sync
	// session to flush them. Skip docs with an open editor or a live
	// provider: their own connection already carries local ops.
	if (doc.userLock || mergeManager.isActive(doc.guid)) return false;
	if (doc.intent === "connected") return false;
	if (!mergeManager.isServerAdvertisedOutOfSync(doc.guid)) {
		localAheadAttempts.delete(doc.guid);
		return false;
	}
	const lastAttempt = localAheadAttempts.get(doc.guid);
	if (
		lastAttempt !== undefined &&
		now - lastAttempt < LOCAL_AHEAD_RETRY_INTERVAL_MS
	) {
		return false;
	}
	localAheadAttempts.set(doc.guid, now);
	return true;
}

/**
 * Converge selection for a whole-folder pass. Targets arrive narrowed by
 * the host that owns the registry; ordering is the executor's concern.
 */
export function planFolderConvergeSweep(input: {
	documents: readonly Document[];
	canvases: readonly Canvas[];
	files: readonly SyncFile[];
}): FolderPassRequest[] {
	return [
		...input.documents.filter(shouldSelectDocumentForFolderSync),
		...input.canvases.filter(shouldSelectCanvasForFolderSync),
		...input.files.filter(shouldSelectFileForFolderSync),
	].map((target) => ({ target, intent: "converge" as const }));
}

/**
 * Advertised canvases whose machines should hear SERVER_AHEAD. The signal
 * routing itself (latch clear, machine send, hibernated wake) belongs to
 * the host; a canvas with a transfer already in flight settles that
 * transfer first.
 */
export function selectAdvertisedCanvasSignals(
	canvases: readonly Canvas[],
	advertisedGuids: ReadonlySet<string>,
	transferInFlight: InFlightCheck,
): Canvas[] {
	return canvases.filter(
		(canvas) =>
			advertisedGuids.has(canvas.guid) &&
			!transferInFlight(canvas.guid) &&
			canvasAdvertisedOutOfSync(canvas),
	);
}

/** Baseline backfill work for advertised documents. */
export function planAdvertisedBaselineBackfills(
	documents: readonly Document[],
	advertisedGuids: ReadonlySet<string>,
	sessionInFlight: InFlightCheck,
): SyncWorkRequest[] {
	return documents
		.filter(
			(doc) =>
				advertisedGuids.has(doc.guid) &&
				!sessionInFlight(doc.guid) &&
				shouldEnqueueForLCABackfill(doc),
		)
		.map((doc) => ({ target: doc, intent: "backfill-baseline" as const }));
}

/** Baseline backfill work for a folder sweep (connect). */
export function planBaselineBackfills(
	documents: readonly Document[],
	sessionInFlight: InFlightCheck,
): SyncWorkRequest[] {
	return documents
		.filter(
			(doc) =>
				!sessionInFlight(doc.guid) && shouldEnqueueForLCABackfill(doc),
		)
		.map((doc) => ({ target: doc, intent: "backfill-baseline" as const }));
}

/** Prerequisites for establishing a missing merge baseline. */
export function shouldEnqueueForLCABackfill(doc: Document): boolean {
	const hsm = doc.hsm;
	if (!hsm) return false;
	if (doc.sharedFolder.isPendingUpload(doc.path)) return false;
	if (hsm.isActive()) return false;
	if (hsm.state.lca) return false;
	if (hsm.hasFork()) return false;
	if (hsm.getSyncStatus().status === "pending") return true;
	return (
		doc.sharedFolder.mergeManager?.isServerAdvertisedOutOfSync(doc.guid) ??
		false
	);
}

/**
 * Sync work selection for the cold fleet, owned by each folder's
 * MergeManager per [[sync work routing]]: decisions live with the merge
 * state they read, and the executor asks rather than inspecting merge
 * internals. Holds the per-document local-ahead attempt clock.
 */
export class SyncPlanner {
	private localAheadAttempts = new Map<string, number>();

	isDocumentConflicted(doc: Document): boolean {
		return isDocumentConflicted(doc);
	}

	canvasAdvertisedOutOfSync(canvas: Canvas): boolean {
		return canvasAdvertisedOutOfSync(canvas);
	}

	shouldSelectFileForFolderSync(file: SyncFile): boolean {
		return shouldSelectFileForFolderSync(file);
	}

	shouldSelectCanvasForFolderSync(canvas: Canvas): boolean {
		return shouldSelectCanvasForFolderSync(canvas);
	}

	shouldSelectDocumentForFolderSync(doc: Document): boolean {
		return shouldSelectDocumentForFolderSync(doc);
	}

	shouldEnqueueForRemoteHeadSync(doc: Document, now: number): boolean {
		return shouldEnqueueForRemoteHeadSync(doc, this.localAheadAttempts, now);
	}

	/**
	 * Converge work for advertised documents: remote-ahead docs, plus
	 * local-ahead docs the attempt clock lets through.
	 */
	planAdvertisedConvergeRequests(
		documents: readonly Document[],
		advertisedGuids: ReadonlySet<string>,
		now: number,
		sessionInFlight: InFlightCheck,
	): SyncWorkRequest[] {
		return documents
			.filter(
				(doc) =>
					advertisedGuids.has(doc.guid) &&
					!sessionInFlight(doc.guid) &&
					this.shouldEnqueueForRemoteHeadSync(doc, now),
			)
			.map((doc) => ({ target: doc, intent: "converge" as const }));
	}

	shouldEnqueueForLCABackfill(doc: Document): boolean {
		return shouldEnqueueForLCABackfill(doc);
	}

	destroy(): void {
		this.localAheadAttempts.clear();
	}
}
