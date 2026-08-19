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

/**
 * A synced file type able to plan and perform its own work. The folder asks
 * every participant on each occasion and admits the concatenation; the
 * engine runs what was admitted by calling back into the participant. Neither
 * names a file type: the participant answers from its own machine surface —
 * cold when it can — plans nothing when it is current, and drives its
 * machine through the shared signal vocabulary while it works.
 */
export interface SyncParticipant extends WorkTarget {
	planSyncWork(context: PlanContext): WorkRequest<SyncParticipant>[];
	/**
	 * Whether a session can be taken now. A file that cannot (a document
	 * parked in conflict, which only its resolution surface may move) has the
	 * request settle as completed with no work; the engine never queues it.
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
	/**
	 * Bring the server's full state for this file down to the local copy.
	 * Resolves the bytes applied, or undefined when the server held no
	 * content; rejects on failure.
	 */
	transferFromServer(
		context: SyncOperationContext,
	): Promise<Uint8Array | undefined>;
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
