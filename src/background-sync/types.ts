import type { RequestUrlResponse } from "obsidian";
import type { Document } from "../Document";
import type { Canvas } from "../Canvas";
import type { SyncFile } from "../SyncFile";
import type { SharedFolder } from "../SharedFolder";
import type { ObservableMap } from "../observable/ObservableMap";
import type { ObservableSet } from "../observable/ObservableSet";
import type { Subscriber, Unsubscriber } from "../observable/Observable";
import type { FolderSyncSnapshot } from "../BackgroundSyncProgress";

export type SyncTarget = Document | Canvas | SyncFile;

export type SyncWorkIntent =
	| "converge"
	| "publish"
	| "fetch"
	| "backfill-baseline";

/**
 * One unit of work a decider hands the executor. Deciders (the sync
 * planner, per-doc machines, SharedFolder) select targets; the executor
 * owns admission, budgets, retries, and reporting.
 */
export interface SyncWorkRequest {
	target: SyncTarget;
	intent: SyncWorkIntent;
	/** Counts toward user-facing folder progress (fetch only). */
	userVisible?: boolean;
}

/** The subset of work a folder pass can carry. */
export type FolderPassRequest = SyncWorkRequest & {
	intent: "converge" | "fetch";
};

/** Terminal outcomes the ledger accounts. */
export type DirectionTerminal = "completed" | "failed" | "skipped";

export interface QueueItem {
	guid: string;
	path: string;
	doc: SyncTarget;
	status: "pending" | "running" | "completed" | "failed";
	sharedFolder: SharedFolder;
	userVisible: boolean;
	enqueuedAt: number;
	/**
	 * The folder-pass era the item belongs to, stamped by the ledger at
	 * admission (or adoption into a pass). Settles credit the folder's
	 * group only when the item's era matches the group's, so a stale
	 * pass's stragglers can never advance — or overflow — a later pass.
	 */
	passEpoch?: number;
	syncIntent?: "sync" | "upload" | "lca-backfill";
	/**
	 * The bound work order: the target's operation for this item's verb,
	 * chosen at admission (and re-bound if an upgrade changes the verb).
	 * The queue runs it without inspecting the target.
	 */
	run?: () => Promise<unknown>;
	retryAttempts?: number;
	nextAttemptAt?: number;
	retryReason?: "provider" | "s3";
}

/**
 * How a sync completion settled. Cancellation resolves rather than
 * rejects — the pipeline behind the completion has nothing to retry —
 * but the two outcomes are not interchangeable to the caller: an
 * upload's caller publishes membership on "completed" and must stand
 * down on "cancelled", because a cancelled transfer moved only part of
 * its bytes.
 */
export type SyncCompletionOutcome = "completed" | "cancelled";

export interface BackgroundSyncFailure {
	id: string;
	guid: string;
	path: string;
	kind: "sync" | "download" | "local";
	message: string;
	sharedFolder: SharedFolder;
	/**
	 * Whether the recorded error was a transient class (5xx, throttling,
	 * network-level). Transient failures stay claimable: the periodic pass
	 * re-enqueues them once the reclaim interval has elapsed. Permanent
	 * classes (auth/permission) are never re-driven automatically.
	 */
	retryable: boolean;
	recordedAt: number;
}

export interface SyncGroup {
	sharedFolder: SharedFolder;
	total: number; // Total operations (syncs + downloads)
	completed: number; // Successful operations
	status: "pending" | "running" | "completed" | "failed";
	downloads: number;
	syncs: number;
	completedDownloads: number;
	completedSyncs: number;
	failedDownloads: number;
	failedSyncs: number;
	skippedDownloads: number;
	skippedSyncs: number;
	userDownloads: number;
	completedUserDownloads: number;
	failedUserDownloads: number;
	skippedUserDownloads: number;
}

export function createEmptySyncGroup(sharedFolder: SharedFolder): SyncGroup {
	return {
		sharedFolder,
		total: 0,
		completed: 0,
		status: "pending",
		downloads: 0,
		syncs: 0,
		completedDownloads: 0,
		completedSyncs: 0,
		failedDownloads: 0,
		failedSyncs: 0,
		skippedDownloads: 0,
		skippedSyncs: 0,
		userDownloads: 0,
		completedUserDownloads: 0,
		failedUserDownloads: 0,
		skippedUserDownloads: 0,
	};
}

export interface SyncProgress {
	totalPercent: number;
	syncPercent: number;
	downloadPercent: number;
	totalItems: number;
	completedItems: number;
	syncItems: number;
	completedSyncs: number;
	downloadItems: number;
	completedDownloads: number;
}

export interface GroupProgress {
	percent: number;
	syncPercent: number;
	downloadPercent: number;
	sharedFolder: SharedFolder;
	status: "pending" | "running" | "completed" | "failed";
}

export interface QueueStatus {
	syncsQueued: number;
	syncsActive: number;
	downloadsQueued: number;
	downloadsActive: number;
	isPaused: boolean;
}

/**
 * The scheduler surface consumers depend on. BackgroundSyncEngine
 * implements it; consumers hold this interface rather than the class so
 * they stay decoupled from the engine's composition.
 */
export interface BackgroundSyncApi {
	/** Items whose transfer is running, in start order. */
	readonly activeSync: ObservableSet<QueueItem>;
	readonly activeDownloads: ObservableSet<QueueItem>;
	/** Per-folder progress counters. */
	readonly syncGroups: ObservableMap<SharedFolder, SyncGroup>;
	/** Queued (not yet started) items. */
	readonly pendingSyncs: readonly QueueItem[];
	readonly pendingDownloads: readonly QueueItem[];

	enqueueSync(
		item: SyncTarget,
		deferQueueFlush?: boolean,
	): Promise<SyncCompletionOutcome>;
	enqueueRetryableSync(
		item: SyncTarget,
		error: Error,
	): Promise<SyncCompletionOutcome>;
	enqueueUpload(item: SyncTarget): Promise<SyncCompletionOutcome>;
	enqueueDownload(
		item: SyncTarget,
		userVisible?: boolean,
	): Promise<Uint8Array | undefined>;
	/**
	 * Immediate-lane download for a fetch whose consumer is waiting: runs
	 * on dedicated slots instead of behind queued sweep work, parking into
	 * the background queue when it cannot start.
	 */
	downloadNow(item: SyncTarget): Promise<Uint8Array | undefined>;
	/**
	 * Admit a folder pass: the folder's progress group resets to the
	 * pass's selection, and the requests are admitted pre-counted with one
	 * ordering flush. Passes carry converge and fetch work only.
	 */
	enqueuePass(
		sharedFolder: SharedFolder,
		requests: FolderPassRequest[],
	): void;
	/** Admit a decider's batch with one ordering flush per channel. */
	enqueueMany(requests: SyncWorkRequest[]): void;
	/**
	 * Whether the guid holds queued or active work — the deduplication
	 * input deciders consult before selecting work. Deduplication is
	 * per-queue: pass the queue whose work would be redundant. Admissions
	 * across queues serialize on the target — while one direction's work
	 * for a guid runs, the other direction's parks — so checking both
	 * (omit the queue argument) is about avoiding redundant selection,
	 * not about racing.
	 */
	isQueuedOrActive(guid: string, queue?: "session" | "transfer"): boolean;
	cancelDocumentWork(guid: string): void;

	downloadItem(item: Document | Canvas): Promise<RequestUrlResponse>;
	downloadByGuid(
		sharedFolder: SharedFolder,
		guid: string,
		path: string,
		kind?: "doc" | "canvas",
	): Promise<Uint8Array | undefined>;

	getFolderSyncSnapshot(sharedFolder: SharedFolder): FolderSyncSnapshot;
	subscribeToFolderSyncSnapshot(
		sharedFolder: SharedFolder,
		callback: Subscriber<FolderSyncSnapshot>,
	): Unsubscriber;
	getQueueStatus(): QueueStatus;

	getFailures(sharedFolder: SharedFolder): BackgroundSyncFailure[];
	clearFailure(id: string): void;
	beginFolderResync(sharedFolder: SharedFolder): Unsubscriber;

	pause(): void;
	resume(): void;
	start(): void;
	destroy(): void;
}
