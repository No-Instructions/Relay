import type { YjsSnapshot } from "../merge-hsm/types";
import type { TimeProvider } from "../TimeProvider";
import type {
	WorkIntent,
	WorkRequest,
	WorkScope,
	WorkTarget,
} from "./WorkRequest";

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

/** The intents a session-scope request can carry. */
export type SessionIntent = Exclude<WorkIntent, "download">;

/**
 * What the engine hands an operation while it runs. The operation owns its
 * pipeline; the engine owns the slot, the deadline, and cancellation.
 */
export interface SyncOperationContext {
	timeProvider: TimeProvider;
	/**
	 * Register a warm-lease release against the operation's deadline. The
	 * returned release is idempotent; an operation abandoned at its deadline
	 * has every lease it registered released for it.
	 */
	holdLease(release: () => void): () => void;
	/** Whether the work was cancelled while running; consulted at stage boundaries. */
	isCancelled(): boolean;
}

/** A transfer can create a file before a persistent participant exists. */
export interface DownloadParticipant extends WorkTarget {
	/** Reject ineligible work before it claims a queue slot or counts as progress. */
	checkSyncWork?(intent: WorkIntent): void;
	/** Resolve when the server's content has been applied, or reject on failure. */
	transferFromServer(context: SyncOperationContext): Promise<Uint8Array | undefined>;
}

/**
 * A synced file type able to plan and perform its own work. The folder asks
 * every participant on each occasion and admits the concatenation; the
 * engine runs what was admitted by calling back into the participant.
 */
export interface SyncParticipant extends DownloadParticipant {
	planSyncWork(context: PlanContext): WorkRequest<SyncParticipant>[];
	/**
	 * Whether a session can be taken now. A file that cannot (one parked in
	 * a state only its own resolution surface may move) has the request
	 * settle as completed with no work; the engine never queues it.
	 */
	acceptsSession(): boolean;
	/**
	 * Run a session-scope unit of work: converge with the server, upload the
	 * local state as authoritative, or recover the merge base. Resolves when
	 * the work settled — synced, stood down on cancellation, or nothing to
	 * do — and rejects on failure; a retryable rejection is re-driven.
	 */
	runSyncSession(
		intent: SessionIntent,
		context: SyncOperationContext,
	): Promise<void>;
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
