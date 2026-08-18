import type { Document } from "../Document";
import type { Canvas } from "../Canvas";
import type { SyncFile } from "../SyncFile";
import type {
	FolderPassRequest,
	SyncWorkRequest,
} from "../background-sync/types";

/** Deduplication input from the executor: is this guid already worked? */
export type InFlightCheck = (guid: string) => boolean;

// Selection takes already-narrowed targets: callers dispatch on the type
// guards they already hold. Importing the concrete classes here would drag
// the whole app graph (providers, auth) under every merge-hsm consumer, so
// this module is type-only toward the file types.

/** A conflicted document belongs to the user, not the queue. */
export function isDocumentConflicted(doc: Document): boolean {
	return doc.hsm?.getSyncStatus().status === "conflict";
}

/**
 * Whether an advertised canvas head differs from local state. The machine
 * compares its retained server head against its own basis, warm or cold;
 * a canvas provably current needs no session.
 */
export function canvasAdvertisedOutOfSync(canvas: Canvas): boolean {
	return canvas.hsm.compareRetainedServerHead() !== "current";
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
	// The machine compares its retained server head against its own
	// basis; a document provably current needs no session.
	return hsm.compareRetainedServerHead() !== "current";
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
	return hsm.compareRetainedServerHead() === "ahead";
}
