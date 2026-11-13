import type { SharedFolder } from "../SharedFolder";

/**
 * The dedup scope of a work request. Two requests for the same file in the
 * same scope are one unit of work: admission returns the claim already held
 * rather than queueing a second. Scopes are independent — a file may have a
 * session-scope request and a transfer-scope request in flight at once.
 *
 * - `session`: work that converges local and server state through a provider
 *   session (a converge pass, a local-authoritative upload, a merge-base
 *   backfill).
 * - `transfer`: work that moves the server's full state down to the local
 *   file (a download).
 */
export type WorkScope = "session" | "transfer";

/** Urgent work takes the next free slot, within the same concurrency limit. */
export type WorkPriority = "normal" | "high";

/**
 * What the request asks for. The intent fixes the scope (see `scopeForIntent`);
 * the scope is still carried on the request so admission, dedup, and pass
 * accounting never derive it from the intent.
 */
export type WorkIntent = "converge" | "upload" | "backfill" | "download";

/** The file a request is about: enough identity to queue, sort, and cancel. */
export interface WorkTarget {
	readonly guid: string;
	/** Path relative to the shared folder. */
	readonly path: string;
	readonly destroyed: boolean;
	readonly sharedFolder: SharedFolder;
	/** Whether this target may publish local content to the server. */
	readonly canPublishContent: boolean;
	/** Temporary target used only until the folder registers the real file. */
	readonly provisional?: boolean;
	/** Whether this target's transfer can create its missing disk object. */
	readonly materializesOnTransfer?: boolean;
	/**
	 * Whether this provisional target's active operation is already carrying
	 * the candidate's transfer. A registered participant can then share the
	 * active claim instead of scheduling the same transfer again.
	 */
	sharesActiveWorkWith?(candidate: WorkTarget): boolean;
}

/**
 * The one unit of admission. Converge passes, uploads, backfills, and
 * downloads are all this type; the engine's admit step is the only consumer.
 */
export interface WorkRequest<T extends WorkTarget = WorkTarget> {
	readonly guid: string;
	/** Vault path — the ordering key and the name shown in status surfaces. */
	readonly path: string;
	readonly target: T;
	readonly sharedFolder: SharedFolder;
	readonly scope: WorkScope;
	readonly intent: WorkIntent;
	/** What asked for the work. Free-form, for logs and metrics only. */
	readonly trigger: string;
	/** Whether the user asked for this (folder-level progress follows it). */
	readonly userVisible: boolean;
	readonly priority?: WorkPriority;
}

export function scopeForIntent(intent: WorkIntent): WorkScope {
	return intent === "download" ? "transfer" : "session";
}

export function createWorkRequest<T extends WorkTarget>(
	target: T,
	intent: WorkIntent,
	trigger: string,
	options: { userVisible?: boolean; priority?: WorkPriority } = {},
): WorkRequest<T> {
	const sharedFolder = target.sharedFolder;
	return {
		guid: target.guid,
		path: sharedFolder.getPath(target.path),
		target,
		sharedFolder,
		scope: scopeForIntent(intent),
		intent,
		trigger,
		userVisible: options.userVisible ?? false,
		priority: options.priority ?? "normal",
	};
}

/**
 * How a unit of work settled. Cancellation resolves rather than rejects —
 * the pipeline behind the completion has nothing to retry — but the two
 * outcomes are not interchangeable to the caller: an upload's caller
 * publishes membership on "completed" and must stand down on "cancelled",
 * because a cancelled transfer moved only part of its bytes.
 */
export type SyncCompletionOutcome = "completed" | "cancelled";

/** What a settled claim delivers. Transfers may carry the bytes they moved. */
export interface WorkCompletion {
	outcome: SyncCompletionOutcome;
	bytes?: Uint8Array;
}

/** Why a retryable failure is being re-driven, for metrics. */
export type RetryReason = "provider" | "s3";

/**
 * A request once admitted: the queue's own bookkeeping laid over the
 * request. Status surfaces read these; only the engine writes them.
 */
export interface QueueItem<T extends WorkTarget = WorkTarget>
	extends WorkRequest<T> {
	status: "pending" | "running" | "completed" | "failed";
	/** A later urgent request can promote a queued claim. */
	priority?: WorkPriority;
	enqueuedAt: number;
	retryAttempts?: number;
	nextAttemptAt?: number;
	retryReason?: RetryReason;
}
