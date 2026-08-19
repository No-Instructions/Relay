import type { YjsSnapshot } from "../merge-hsm/types";
import type { WorkRequest, WorkScope, WorkTarget } from "./WorkRequest";

/**
 * Why a participant is being asked to plan. Each occasion is a moment the
 * folder or its provider observes; what it means for a given file is the
 * file's own business.
 *
 * - `sweep`: a folder-wide pass (connect, resync) asking every file to
 *   converge with the server if it is not provably current.
 * - `reconnect`: the provider session came back; files whose merge base
 *   was never established may recover it now.
 * - `server-head`: the server reported a head for this file.
 */
export type PlanOccasion =
	| { kind: "sweep" }
	| { kind: "reconnect" }
	| { kind: "server-head"; head: YjsSnapshot };

export interface PlanContext {
	occasion: PlanOccasion;
	now: number;
	/** Whether work for the guid is already queued or active in the scope. */
	inFlight(guid: string, scope: WorkScope): boolean;
}

/**
 * A synced file type able to plan its own work. The folder asks every
 * participant on each occasion and admits the concatenation; it never names
 * a file type or reads a machine. A participant answers from its own
 * machine surface — cold when it can — and returns nothing when it is
 * current.
 */
export interface SyncParticipant extends WorkTarget {
	planSyncWork(context: PlanContext): WorkRequest[];
}

export function isSyncParticipant(
	file: unknown,
): file is SyncParticipant {
	return (
		typeof file === "object" &&
		file !== null &&
		typeof (file as SyncParticipant).planSyncWork === "function"
	);
}

/**
 * A synced file type that consumes the server's live update stream for its
 * own guid: classifying each update against what it has already applied,
 * applying what follows on, and turning a dependency gap into a server-head
 * reaction of its own. The folder routes; the file decides.
 */
export interface ServerUpdateSink {
	onServerUpdate(update: Uint8Array): void;
}

export function isServerUpdateSink(file: unknown): file is ServerUpdateSink {
	return (
		typeof file === "object" &&
		file !== null &&
		typeof (file as ServerUpdateSink).onServerUpdate === "function"
	);
}
