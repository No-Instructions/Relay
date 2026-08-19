import type { RequestUrlResponse } from "obsidian";
import type { LoginManager } from "./LoginManager";
import * as Y from "yjs";
import { S3RN, S3RemoteCanvas, S3RemoteDocument, type S3RNType } from "./S3RN";
import type { TimeProvider } from "./TimeProvider";
import { HasLogging, RelayInstances, metrics } from "./debug";
import {
	Observable,
	type Subscriber,
	type Unsubscriber,
} from "./observable/Observable";
import { ObservableSet } from "./observable/ObservableSet";
import { ObservableMap } from "./observable/ObservableMap";
import type { SharedFolder, SharedFolders } from "./SharedFolder";
import type { ClientToken } from "./client/types";
import { isEmptyDoc } from "./merge-hsm/snapshots";
import {
	buildFolderSyncSnapshot,
	FolderSyncSnapshotSmoother,
	type FolderSyncSnapshot,
	type FolderSyncWorkItemInput,
} from "./BackgroundSyncProgress";
import { errorFromUnknown, formatUserFacingError } from "./UserFacingError";
import { getRelayRequestHeaders, requestUrlWithMetrics } from "./customFetch";
import {
	isRetryableProviderSyncError,
	isRetryableSyncError,
	ProviderTimeoutError,
} from "./background-sync/errors";
import type {
	SyncOperationContext,
	SyncParticipant,
} from "./background-sync/SyncParticipant";
import {
	createWorkRequest,
	type QueueItem,
	type RetryReason,
	type SyncCompletionOutcome,
	type WorkCompletion,
	type WorkRequest,
	type WorkScope,
	type WorkTarget,
} from "./background-sync/WorkRequest";
import {
	WorkLane,
	type LaneOperation,
	type LaneSortReason,
} from "./background-sync/WorkLane";

export type {
	QueueItem,
	SyncCompletionOutcome,
	WorkCompletion,
	WorkIntent,
	WorkRequest,
	WorkScope,
} from "./background-sync/WorkRequest";
export { createWorkRequest } from "./background-sync/WorkRequest";
export type {
	PlanContext,
	PlanOccasion,
	SessionIntent,
	SyncOperationContext,
	SyncParticipant,
} from "./background-sync/SyncParticipant";
export {
	isRetryableSyncError,
	ProviderTimeoutError,
	RetryableProviderSyncError,
} from "./background-sync/errors";

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
	/** The request that failed, so a reclaim re-admits the same work. */
	request?: WorkRequest;
	/** How many times the periodic pass has already re-admitted this row. */
	reclaims: number;
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

interface FolderSyncSnapshotSubscription {
	smoother: FolderSyncSnapshotSmoother;
	subscribers: Set<Subscriber<FolderSyncSnapshot>>;
	latestSnapshot: FolderSyncSnapshot | null;
	unsubscribers: Unsubscriber[];
	emit: () => void;
}

const MAX_PROVIDER_SYNC_RETRIES = 5;
const BACKGROUND_SYNC_QUEUE_PUMP_INTERVAL_MS = 1000;
const BACKGROUND_SYNC_FOLDER_POLL_INTERVAL_MS = 5000;
const BACKGROUND_SYNC_DRAIN_BUDGET_MS = 8;
// How long a terminally-failed transient failure rests before the periodic
// pass re-admits it. Short-lived blips are already absorbed by the lane's own
// backoff retries; this interval is the long-tail self-heal for outages that
// outlast them, so it can be generous without stranding files until reload.
const FAILURE_RECLAIM_INTERVAL_MS = 5 * 60_000;
// Each reclaim of the same row waits twice as long as the last, and after
// this many the row stays parked until a sweep, a server event, or the user
// re-admits the file: a file whose every attempt wedges must not hold a lane
// slot at a steady rate for the rest of the session.
const MAX_FAILURE_RECLAIMS = 3;
// A provider-bound operation that has not settled in this long is treated as
// timed out. Generous by design — a healthy but slow transfer must never trip
// it — because the deadline only detects a wedged await (a dead or stranded
// connection whose promise never resolves) and converts it into a legible,
// retryable failure. It never schedules recovery: reconnection and the lane's
// own retry/backoff do that.
const PROVIDER_OP_DEADLINE_MS = 5 * 60_000;

// Identity for a single in-flight provider-bound operation, minted by
// withProviderDeadline and threaded through the operation's call chain. Warm
// leases acquired inside the operation register their releases against the
// token, so a deadline sweep can only ever release what its own operation
// holds — never a concurrent operation's lease on the same document. The
// sweep marks the token abandoned; a lease registered afterwards (an
// abandoned operation resuming on a late settle) is released immediately
// instead of parking with no deadline left to watch it.
export interface ProviderOperationToken {
	abandoned: boolean;
}

export interface QueueStatus {
	syncsQueued: number;
	syncsActive: number;
	downloadsQueued: number;
	downloadsActive: number;
	isPaused: boolean;
}

/**
 * The background sync engine. Every unit of work — a converge pass, an
 * upload, a merge-base backfill, a download — enters through `admit` as one
 * work-request type; the engine owns pass accounting, ordering, concurrency,
 * retry/backoff, deadlines, and cancellation. What work a file needs is
 * decided elsewhere (the folder sweep and the file's own machine); the engine
 * never selects.
 */
export class BackgroundSync extends HasLogging {
	public syncGroups = new ObservableMap<SharedFolder, SyncGroup>();
	private folderResyncs = new ObservableSet<SharedFolder>();
	private failures = new ObservableMap<string, BackgroundSyncFailure>(
		"BackgroundSync.failures",
	);
	private queueStatusChanged = new Observable<BackgroundSync>(
		"BackgroundSync.queueStatus",
	);

	private lanes: Record<WorkScope, WorkLane>;
	private draining: Record<WorkScope, boolean> = {
		session: false,
		transfer: false,
	};
	private isPaused = true;
	private folderSyncSnapshotSubscriptions = new Map<
		SharedFolder,
		FolderSyncSnapshotSubscription
	>();
	private folderQueueWakeups = new Map<SharedFolder, Unsubscriber>();

	subscriptions: Unsubscriber[] = [];

	constructor(
		private loginManager: LoginManager,
		private timeProvider: TimeProvider,
		private sharedFolders: SharedFolders,
		private concurrency: number = 3,
	) {
		super();
		RelayInstances.set(this, "BackgroundSync");
		this.lanes = {
			session: this.createLane("session"),
			transfer: this.createLane("transfer"),
		};

		let lastQueuePumpAt = this.timeProvider.now();
		this.timeProvider.setInterval(() => {
			const now = this.timeProvider.now();
			this.recordTickDelay(
				"queue",
				lastQueuePumpAt,
				now,
				BACKGROUND_SYNC_QUEUE_PUMP_INTERVAL_MS,
			);
			lastQueuePumpAt = now;
			this.drainAll();
		}, BACKGROUND_SYNC_QUEUE_PUMP_INTERVAL_MS);

		// Add polling timer for disk changes (poll all folders)
		let lastFolderPollAt = this.timeProvider.now();
		this.timeProvider.setInterval(() => {
			const now = this.timeProvider.now();
			this.recordTickDelay(
				"folder_poll",
				lastFolderPollAt,
				now,
				BACKGROUND_SYNC_FOLDER_POLL_INTERVAL_MS,
			);
			lastFolderPollAt = now;
			this.sharedFolders.forEach((folder) => {
				folder.poll();
			});
			this.reclaimParkedFailures();
		}, BACKGROUND_SYNC_FOLDER_POLL_INTERVAL_MS);

		this.subscriptions.push(
			this.sharedFolders.subscribe(() => {
				this.updateFolderQueueWakeups();
			}),
		);
		this.updateFolderQueueWakeups();
	}

	private createLane(scope: WorkScope): WorkLane {
		return new WorkLane(scope, {
			now: () => this.timeProvider.now(),
			isDrainable: (item) => this.isDrainable(item),
			onDiscarded: (item) => this.markTerminal(item, "skipped"),
			onQueueChanged: () => this.noteQueueChanged(scope),
		});
	}

	// =========================================================================
	// Queue surfaces
	// =========================================================================

	/** Session-scope work that is running. */
	public get activeSync(): ObservableSet<QueueItem> {
		return this.lanes.session.active;
	}

	/** Transfer-scope work that is running. */
	public get activeDownloads(): ObservableSet<QueueItem> {
		return this.lanes.transfer.active;
	}

	/** Session-scope work waiting to start. */
	public get pendingSyncs(): readonly QueueItem[] {
		return this.lanes.session.pending;
	}

	/** Transfer-scope work waiting to start. */
	public get pendingDownloads(): readonly QueueItem[] {
		return this.lanes.transfer.pending;
	}

	/** Whether the guid holds a claim in the scope (queued or running). */
	isClaimed(guid: string, scope: WorkScope): boolean {
		return this.lanes[scope].isClaimed(guid);
	}

	private noteQueueChanged(scope: WorkScope): void {
		const lane = this.lanes[scope];
		metrics.setBgSyncQueueLength(lane.operation, lane.queuedCount);
		this.queueStatusChanged.notifyListeners();
	}

	/**
	 * Cancel every unit of work for a file, in every scope. Queued work leaves
	 * the queues now; active work settles as cancelled when its pipeline
	 * returns. Failure rows for the file clear with it.
	 */
	cancelDocumentWork(guid: string): void {
		for (const lane of Object.values(this.lanes)) {
			const { removed } = lane.cancel(guid);
			for (const item of removed) {
				this.removeQueuedFromGroup(item);
			}
		}
		this.clearFailure(this.failureKey("sync", guid));
		this.clearFailure(this.failureKey("download", guid));
	}

	/**
	 * A queued item is drainable only when its folder is connected and the
	 * user hasn't asked it to pause. Items for disconnected folders stay in
	 * the queue — admissions made while offline (pending uploads, remaps) must
	 * survive until reconnect, when the folder-state subscription wakes the
	 * lanes — rather than being dropped at admission time.
	 */
	private isDrainable(item: QueueItem): boolean {
		return (
			item.sharedFolder.connected &&
			item.sharedFolder.intent !== "disconnected"
		);
	}


	// =========================================================================
	// Pass accounting
	// =========================================================================

	private emptyGroup(sharedFolder: SharedFolder): SyncGroup {
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

	/**
	 * Start a fresh accounting pass for a folder: a sweep's progress counts
	 * from zero rather than on top of whatever the last pass left behind.
	 */
	beginFolderPass(sharedFolder: SharedFolder): void {
		const group = this.emptyGroup(sharedFolder);
		group.status = "completed";
		this.syncGroups.set(sharedFolder, group);
	}

	private countAdmitted(request: WorkRequest): void {
		const sharedFolder = request.sharedFolder;
		const group = this.syncGroups.get(sharedFolder) ?? this.emptyGroup(sharedFolder);
		group.total++;
		if (request.scope === "transfer") {
			group.downloads++;
			if (request.userVisible) group.userDownloads++;
		} else {
			group.syncs++;
		}
		group.status = "running";
		this.syncGroups.set(sharedFolder, group);
	}

	private removeQueuedFromGroup(item: QueueItem): void {
		const group = this.syncGroups.get(item.sharedFolder);
		if (!group) return;
		group.total = Math.max(0, group.total - 1);
		if (item.scope === "transfer") {
			group.downloads = Math.max(0, group.downloads - 1);
			if (item.userVisible) {
				group.userDownloads = Math.max(0, group.userDownloads - 1);
			}
		} else {
			group.syncs = Math.max(0, group.syncs - 1);
		}
		this.updateGroupTerminalStatus(group);
		this.syncGroups.set(item.sharedFolder, group);
	}

	private markTerminal(
		item: QueueItem,
		outcome: "completed" | "failed" | "skipped",
	): void {
		const group = this.syncGroups.get(item.sharedFolder);
		if (!group) return;
		if (item.scope === "transfer") {
			if (outcome === "completed") {
				group.completedDownloads++;
				group.completed++;
				if (item.userVisible) group.completedUserDownloads++;
			} else if (outcome === "failed") {
				group.failedDownloads++;
				if (item.userVisible) group.failedUserDownloads++;
			} else {
				group.skippedDownloads++;
				if (item.userVisible) group.skippedUserDownloads++;
			}
		} else if (outcome === "completed") {
			group.completedSyncs++;
			group.completed++;
		} else if (outcome === "failed") {
			group.failedSyncs++;
		} else {
			group.skippedSyncs++;
		}
		this.updateGroupTerminalStatus(group);
		this.syncGroups.set(item.sharedFolder, group);
	}

	private groupFinishedSyncs(group: SyncGroup): number {
		return Math.min(
			group.syncs,
			group.completedSyncs + group.failedSyncs + group.skippedSyncs,
		);
	}

	private groupFinishedDownloads(group: SyncGroup): number {
		return Math.min(
			group.downloads,
			group.completedDownloads + group.failedDownloads + group.skippedDownloads,
		);
	}

	private groupFinishedTotal(group: SyncGroup): number {
		return Math.min(
			group.total,
			this.groupFinishedSyncs(group) + this.groupFinishedDownloads(group),
		);
	}

	private groupFailureCount(group: SyncGroup): number {
		return group.failedSyncs + group.failedDownloads;
	}

	private updateGroupTerminalStatus(group: SyncGroup): void {
		if (this.groupFinishedTotal(group) >= group.total) {
			group.status = this.groupFailureCount(group) > 0 ? "failed" : "completed";
		} else if (this.groupFailureCount(group) > 0) {
			group.status = "failed";
		} else if (group.total > 0) {
			group.status = "running";
		} else {
			group.status = "completed";
		}
	}

	getOverallProgress(): SyncProgress {
		let totalItems = 0;
		let completedItems = 0;
		let syncItems = 0;
		let completedSyncs = 0;
		let downloadItems = 0;
		let completedDownloads = 0;

		this.syncGroups.forEach((group) => {
			totalItems += group.total;
			completedItems += this.groupFinishedTotal(group);
			syncItems += group.syncs;
			completedSyncs += this.groupFinishedSyncs(group);
			downloadItems += group.downloads;
			completedDownloads += this.groupFinishedDownloads(group);
		});

		const totalPercent =
			totalItems > 0 ? (completedItems / totalItems) * 100 : 0;
		const syncPercent = syncItems > 0 ? (completedSyncs / syncItems) * 100 : 0;
		const downloadPercent =
			downloadItems > 0 ? (completedDownloads / downloadItems) * 100 : 0;

		return {
			totalPercent: Math.round(totalPercent),
			syncPercent: Math.round(syncPercent),
			downloadPercent: Math.round(downloadPercent),
			totalItems,
			completedItems,
			syncItems,
			completedSyncs,
			downloadItems,
			completedDownloads,
		};
	}

	getGroupProgress(sharedFolder: SharedFolder): GroupProgress | null {
		const group = this.syncGroups.get(sharedFolder);
		if (!group) return null;

		const percent =
			group.total > 0 ? (this.groupFinishedTotal(group) / group.total) * 100 : 0;
		const syncPercent =
			group.syncs > 0
				? (this.groupFinishedSyncs(group) / group.syncs) * 100
				: 0;
		const downloadPercent =
			group.downloads > 0
				? (this.groupFinishedDownloads(group) / group.downloads) * 100
				: 0;

		return {
			percent: Math.round(percent),
			syncPercent: Math.round(syncPercent),
			downloadPercent: Math.round(downloadPercent),
			sharedFolder,
			status: group.status,
		};
	}

	/**
	 * Returns download-only progress for a shared folder.
	 * Used to show only user-visible downloads in folder progress indicators.
	 */
	getUserVisibleProgress(sharedFolder: SharedFolder): GroupProgress | null {
		const group = this.syncGroups.get(sharedFolder);
		if (!group) return null;

		const total = group.userDownloads;
		const finished =
			group.completedUserDownloads +
			group.failedUserDownloads +
			group.skippedUserDownloads;
		const percent = total > 0 ? (finished / total) * 100 : 0;
		const status =
			total === 0
				? group.status
				: finished === total
					? group.failedUserDownloads > 0
						? "failed"
						: "completed"
					: group.status === "failed"
						? "failed"
						: "running";

		return {
			percent: Math.round(percent),
			syncPercent: 0,
			downloadPercent: Math.round(percent),
			sharedFolder,
			status,
		};
	}

	getAllGroupsProgress(): GroupProgress[] {
		const progress: GroupProgress[] = [];
		this.syncGroups.forEach((group, sharedFolder) => {
			const groupProgress = this.getGroupProgress(sharedFolder);
			if (groupProgress) {
				progress.push(groupProgress);
			}
		});
		return progress;
	}

	// =========================================================================
	// Admission
	// =========================================================================

	/**
	 * Admit one unit of work. The lane for the request's scope dedups it
	 * against queued-or-active work for the same file: an equal-or-weaker
	 * request shares the claim already held, a stronger request (an upload
	 * over a queued converge pass) upgrades the queued work in place, and a
	 * stronger request colliding with ACTIVE work waits for that work to
	 * settle and is admitted again — an upload never runs concurrently with
	 * a plain sync for the same file, and an in-place upgrade is only legal
	 * against work that has not started.
	 *
	 * Resolves when the work settles; see `WorkCompletion` for what the
	 * outcome tells the caller.
	 */
	admit(
		request: WorkRequest<SyncParticipant>,
		options: { deferFlush?: boolean } = {},
	): Promise<WorkCompletion> {
		if (request.scope === "session" && !request.target.acceptsSession()) {
			this.clearFailure(this.failureKey(laneFailureKind(request.scope), request.guid));
			return Promise.resolve({ outcome: "completed" });
		}
		const lane = this.lanes[request.scope];
		const decision = lane.admit(request);
		switch (decision.kind) {
			case "shared":
				this.debug(
					`[admit] ${request.intent} for ${request.guid} already claimed, sharing`,
				);
				return decision.completion;
			case "upgraded":
				return decision.completion;
			case "after-active":
				return this.admitAfterActive(request, decision.settled);
			case "admitted":
				break;
		}
		this.clearFailure(this.failureKey(laneFailureKind(request.scope), request.guid));
		this.countAdmitted(request);
		if (!options.deferFlush) {
			this.flush(request.scope, "enqueue");
		}
		return decision.completion;
	}

	/**
	 * Admit a batch, sorting and draining once at the end. Returns the
	 * completions in request order.
	 */
	admitAll(
		requests: readonly WorkRequest<SyncParticipant>[],
	): Promise<WorkCompletion>[] {
		const completions: Promise<WorkCompletion>[] = [];
		const touched = new Set<WorkScope>();
		for (const request of requests) {
			completions.push(this.admit(request, { deferFlush: true }));
			touched.add(request.scope);
		}
		for (const scope of touched) {
			this.flush(scope, "batch");
		}
		return completions;
	}

	private async admitAfterActive(
		request: WorkRequest<SyncParticipant>,
		settled: Promise<unknown>,
	): Promise<WorkCompletion> {
		// The stronger request is the follow-up operation. Let it run even if
		// the weaker active attempt fails.
		await settled;
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		// Teardown while waiting: no transfer ran, so nothing may publish.
		if (!this.timeProvider) return { outcome: "cancelled" };
		return this.admit(request);
	}

	/**
	 * Admit work that already failed with a retryable error outside the
	 * engine: it enters its lane parked in the backoff window rather than at
	 * the head. Rejects with the original error once retries are spent.
	 */
	admitForRetry(
		request: WorkRequest<SyncParticipant>,
		error: Error,
	): Promise<WorkCompletion> {
		if (request.scope === "session" && !request.target.acceptsSession()) {
			this.clearFailure(this.failureKey(laneFailureKind(request.scope), request.guid));
			return Promise.resolve({ outcome: "completed" });
		}
		const lane = this.lanes[request.scope];
		const decision = lane.admitForRetry(
			request,
			this.retryReason(error),
			MAX_PROVIDER_SYNC_RETRIES,
		);
		if (!decision) return Promise.reject(error);
		if (decision.kind === "admitted") {
			this.countAdmitted(request);
			this.clearFailure(this.failureKey(laneFailureKind(request.scope), request.guid));
			this.debug(
				`[admit] retryable ${request.intent} failure for ${request.path}: ${error.message}; parked for retry`,
			);
		}
		return decision.completion;
	}

	private flush(scope: WorkScope, reason: LaneSortReason): void {
		const lane = this.lanes[scope];
		lane.sortQueue(reason);
		this.queueStatusChanged.notifyListeners();
		void this.drain(scope);
	}

	// -------------------------------------------------------------------------
	// Request constructors at the engine's boundary. Each is the one request
	// type with an intent filled in; nothing below them knows which.
	// -------------------------------------------------------------------------

	/**
	 * Converge a file with the server through a background session.
	 *
	 * @param deferQueueFlush Batch callers set this while adding all items,
	 * then flush the queue once after the batch is complete.
	 */
	async enqueueSync(
		target: SyncParticipant,
		deferQueueFlush = false,
		trigger = "sync",
	): Promise<SyncCompletionOutcome> {
		const completion = await this.admit(
			createWorkRequest(target, "converge", trigger),
			{ deferFlush: deferQueueFlush },
		);
		return completion.outcome;
	}

	async enqueueRetryableSync(
		target: SyncParticipant,
		error: Error,
	): Promise<SyncCompletionOutcome> {
		const completion = await this.admitForRetry(
			createWorkRequest(target, "converge", "retry"),
			error,
		);
		return completion.outcome;
	}

	/**
	 * Enqueue a local-authoritative upload before markUploaded(). For documents,
	 * this seeds remoteDoc from the enrolled local CRDT before provider sync
	 * resolves; other file types use their normal sync mechanics.
	 *
	 * The resolved outcome tells the caller whether the transfer actually
	 * completed: cancellation settles the completion (resolve, not reject)
	 * so the pipeline behind it drains, but it resolves "cancelled" so the
	 * caller's markUploaded can stand down instead of publishing membership
	 * for content that only partially transferred.
	 */
	async enqueueUpload(
		target: SyncParticipant,
		trigger = "upload",
	): Promise<SyncCompletionOutcome> {
		const completion = await this.admit(
			createWorkRequest(target, "upload", trigger),
		);
		return completion.outcome;
	}

	/**
	 * Transfer the server's full state for a file down to the local copy.
	 * Resolves with the bytes applied, or undefined when the server held no
	 * content (or the work was cancelled).
	 */
	async enqueueDownload(
		target: SyncParticipant,
		userVisible = true,
		trigger = "download",
	): Promise<Uint8Array | undefined> {
		const completion = await this.admit(
			createWorkRequest(target, "download", trigger, { userVisible }),
		);
		return completion.bytes;
	}

	// =========================================================================
	// Retry, reclaim, deadlines
	// =========================================================================

	private retryReason(error: Error): RetryReason {
		return isRetryableProviderSyncError(error) ? "provider" : "s3";
	}

	/**
	 * A parked failure must stay claimable: nothing else re-admits an
	 * unchanged file within a session once its lane retries are spent, so
	 * without this pass one outage lasting longer than the backoff window
	 * strands the file until plugin reload. Re-admit transient failures once
	 * the reclaim interval has elapsed. Permanent classes stay parked:
	 * retrying cannot heal an auth or permission refusal, and re-driving them
	 * would ping the server forever.
	 */
	reclaimParkedFailures(): void {
		const now = this.timeProvider.now();
		for (const failure of this.failures.values()) {
			if (failure.kind === "local" || !failure.retryable) continue;
			if (!failure.request) continue;
			if (failure.reclaims >= MAX_FAILURE_RECLAIMS) continue;
			const interval = FAILURE_RECLAIM_INTERVAL_MS * 2 ** failure.reclaims;
			if (now - failure.recordedAt < interval) continue;
			const target = failure.sharedFolder.files.get(failure.guid) as
				| WorkTarget
				| undefined;
			if (!target || target !== failure.request.target || target.destroyed) {
				continue;
			}
			if (
				!failure.sharedFolder.connected ||
				failure.sharedFolder.intent === "disconnected"
			) {
				continue;
			}
			if (
				this.lanes.session.isClaimed(failure.guid) ||
				this.lanes.transfer.isClaimed(failure.guid)
			) {
				continue;
			}
			this.debug(
				`[reclaim] re-admitting parked ${failure.kind} for ${failure.path} (reclaim ${failure.reclaims + 1}/${MAX_FAILURE_RECLAIMS})`,
			);
			// A reclaimed session re-runs as a plain converge pass: the caller
			// that wanted the stronger intent already saw its failure and owns
			// any follow-up; transfers re-run as themselves.
			const request: WorkRequest<SyncParticipant> = {
				...(failure.request as WorkRequest<SyncParticipant>),
				intent: failure.request.scope === "transfer" ? "download" : "converge",
				trigger: "reclaim",
			};
			this.admit(request).catch(() => {
				// The failure is re-recorded by the lane; the next reclaim
				// pass paces itself from the fresh record.
			});
			// Admission cleared the row (and with it this id's history); the
			// count carries forward so a repeat of the failure re-records
			// onto it rather than starting the budget over.
			this.reclaimHistory.set(failure.id, failure.reclaims + 1);
		}
	}

	// How many times each failure id has been reclaimed. Survives the row
	// being cleared by the reclaim's own admission; any other admission of
	// the file (a sweep, a server event, the user) clears it with the row.
	private reclaimHistory = new Map<string, number>();

	private recordTickDelay(
		tick: "queue" | "folder_poll",
		lastTickAt: number,
		now: number,
		intervalMs: number,
	): void {
		const delayMs = Math.max(0, now - lastTickAt - intervalMs);
		metrics.observeBgSyncTickDelay(tick, delayMs / 1000);
	}

	// Warm-lease releases held by in-flight provider-bound operations, keyed
	// by the operation's own token. A deadlined operation is abandoned with
	// its finally blocks suspended behind the hung await, so its lease release
	// never runs on its own — the deadline path releases through this registry
	// instead. Releases are idempotent, so an abandoned operation that
	// eventually settles double-releases as a no-op.
	private heldLeaseReleases = new Map<ProviderOperationToken, Set<() => void>>();

	registerHeldLease(
		token: ProviderOperationToken,
		release: () => void,
	): () => void {
		let releasedOnce = false;
		const registered = () => {
			if (releasedOnce) return;
			releasedOnce = true;
			const releases = this.heldLeaseReleases.get(token);
			if (releases) {
				releases.delete(registered);
				if (releases.size === 0) {
					this.heldLeaseReleases.delete(token);
				}
			}
			release();
		};
		if (token.abandoned) {
			// The operation's deadline has already fired and swept this token;
			// no watcher remains. Release now rather than park a lease that
			// would pin the document for the rest of the session.
			registered();
			return registered;
		}
		let releases = this.heldLeaseReleases.get(token);
		if (!releases) {
			releases = new Set();
			this.heldLeaseReleases.set(token, releases);
		}
		releases.add(registered);
		return registered;
	}

	private releaseAbandonedLeases(token: ProviderOperationToken): void {
		token.abandoned = true;
		const releases = this.heldLeaseReleases.get(token);
		if (!releases) return;
		this.heldLeaseReleases.delete(token);
		for (const release of releases) release();
	}

	// Wrap a provider-bound operation so a wedged await cannot hold its
	// concurrency slot forever. The operation receives a freshly minted token
	// and registers any warm-lease releases against it. The op races a
	// deadline timer on the injected TimeProvider (deterministic under test);
	// on expiry the returned promise rejects with a retryable
	// ProviderTimeoutError, which the lane's catch classifies as a provider
	// failure, frees the slot, and reschedules. A settled op clears the
	// timer; a genuinely hung underlying promise is left to be
	// garbage-collected once its references drop, and any warm leases its
	// operation registered are released through the token so the abandoned
	// work cannot pin its document against hibernation for the rest of the
	// session.
	private withProviderDeadline<T>(
		work: (token: ProviderOperationToken) => Promise<T>,
		operation: LaneOperation,
		awaited: string,
		guid: string,
	): Promise<T> {
		const token: ProviderOperationToken = { abandoned: false };
		// A TimeProvider without a scheduler cannot arm the deadline — only
		// narrow test doubles lack one; production always injects a full
		// TimeProvider. Run the operation undeadlined rather than failing it.
		if (typeof this.timeProvider?.setTimeout !== "function") {
			return work(token);
		}
		// The operation body starts synchronously here, before the timer is
		// armed: a lease acquired and registered in the op's first synchronous
		// section exists before the deadline can possibly fire.
		const operationPromise = work(token);
		let timer: ReturnType<TimeProvider["setTimeout"]> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = this.timeProvider.setTimeout(() => {
				this.releaseAbandonedLeases(token);
				reject(
					new ProviderTimeoutError(
						operation,
						awaited,
						guid,
						PROVIDER_OP_DEADLINE_MS,
					),
				);
			}, PROVIDER_OP_DEADLINE_MS);
		});
		// If the deadline wins the race the underlying promise is abandoned; a
		// no-op catch keeps its eventual rejection from surfacing as an unhandled
		// rejection.
		operationPromise.catch(() => {});
		return Promise.race([operationPromise, deadline]).finally(() => {
			if (timer !== undefined) {
				this.timeProvider.clearTimeout(timer);
			}
		});
	}

	// =========================================================================
	// Draining and execution
	// =========================================================================

	private drainAll(): void {
		void this.drain("session");
		void this.drain("transfer");
	}

	private wakeQueues(): void {
		if (!this.timeProvider) return;
		this.drainAll();
	}

	private updateFolderQueueWakeups(): void {
		const currentFolders = new Set(this.sharedFolders.items());

		for (const [folder, unsubscribe] of this.folderQueueWakeups) {
			if (!currentFolders.has(folder)) {
				unsubscribe();
				this.folderQueueWakeups.delete(folder);
			}
		}

		for (const folder of currentFolders) {
			if (this.folderQueueWakeups.has(folder)) continue;

			const subscriptionKey = {
				type: "background-sync-queue-wakeup",
				folder,
			};
			const unsubscribe = folder.subscribe(subscriptionKey, () => {
				this.wakeQueues();
			});
			this.folderQueueWakeups.set(folder, unsubscribe);
		}

		this.wakeQueues();
	}

	private recordDrain(
		operation: LaneOperation,
		startedAt: number,
		itemsStarted: number,
	): void {
		metrics.observeBgSyncDrain(
			operation,
			(performance.now() - startedAt) / 1000,
			itemsStarted,
			BACKGROUND_SYNC_DRAIN_BUDGET_MS,
		);
	}

	private observeItemStart(item: QueueItem, now: number): void {
		const operation = laneOperationFor(item);
		const intent = item.scope === "transfer" ? "download" : legacyIntent(item);
		metrics.observeBgSyncItemAge(
			operation,
			intent,
			Math.max(0, now - item.enqueuedAt) / 1000,
		);
		if (item.nextAttemptAt !== undefined && item.retryReason) {
			metrics.observeBgSyncRetryLateness(
				operation,
				item.retryReason,
				Math.max(0, now - item.nextAttemptAt) / 1000,
			);
		}
	}

	/**
	 * Start as many ready items in a lane as the concurrency allows. Each
	 * started item runs its operation under the provider deadline and settles
	 * through the lane: completion resolves the shared claim, a retryable
	 * failure parks the item for another attempt, and anything else fails the
	 * claim and records a failure row. Cancellation raised while the work
	 * runs settles it as cancelled (skipped in the pass accounting).
	 */
	private async drain(scope: WorkScope): Promise<void> {
		if (this.isPaused || this.draining[scope]) return;
		const lane = this.lanes[scope];
		const drainStart = performance.now();
		let itemsStarted = 0;
		this.draining[scope] = true;
		try {
			metrics.setBgSyncQueueLength(lane.operation, lane.queuedCount);

			const now = this.timeProvider.now();
			while (lane.active.size < this.concurrency) {
				const item = lane.takeNext(now);
				if (!item) break;

				this.observeItemStart(item, this.timeProvider.now());
				itemsStarted++;
				const opStart = performance.now();
				lane.start(item);
				metrics.setBgSyncActive(lane.operation, lane.active.size);
				metrics.setBgSyncQueueLength(lane.operation, lane.queuedCount);

				let work: Promise<WorkCompletion>;
				try {
					work = this.execute(item);
				} catch (error) {
					work = Promise.reject(error);
				}

				work
					.then((completion) => {
						metrics.incBgSyncOps(lane.operation, "completed");
						this.markTerminal(item, "completed");
						lane.settle(item, completion);
					})
					.catch((error) => {
						if (lane.isCancelled(item) || this.targetDeleted(item)) {
							// A cancellation raised while the work was active
							// usually settles cleanly; one that surfaces as an
							// error is still a cancellation, not a failure.
							this.markTerminal(item, "skipped");
							lane.settle(item, { outcome: "cancelled" });
							return;
						}

						if (
							isRetryableSyncError(error) &&
							lane.scheduleRetry(item, this.retryReason(error), MAX_PROVIDER_SYNC_RETRIES)
						) {
							// The row is withdrawn while the lane re-drives the
							// item; the reclaim history stays, since this is
							// the same unit of work still failing.
							this.failures.delete(this.failureKey(laneFailureKind(scope), item.guid));
							this.debug(
								`[${lane.operation}] retryable failure for ${item.path}: ${error.message}; retrying at ${item.nextAttemptAt}`,
							);
							return;
						}
						if (isRetryableSyncError(error)) {
							this.warn(
								`[${lane.operation}] retryable failure exhausted ${MAX_PROVIDER_SYNC_RETRIES} retries for ${item.path}: ${error.message}`,
							);
						}

						metrics.incBgSyncOps(lane.operation, "failed");
						this.logError(
							scope === "transfer" ? "[Download Failed]" : "[Sync Failed]",
							error,
						);
						this.recordFailure(item, error);
						this.markTerminal(item, "failed");
						lane.fail(item, errorFromUnknown(error));
					})
					.finally(() => {
						metrics.observeBgSyncOp(
							lane.operation,
							(performance.now() - opStart) / 1000,
						);
						metrics.setBgSyncActive(lane.operation, lane.active.size);
						// Continue draining without relying on throttled timers.
						queueMicrotask(() => {
							if (!this.timeProvider) return;
							void this.drain(scope);
						});
					});
			}
		} finally {
			this.draining[scope] = false;
			metrics.setBgSyncQueueLength(lane.operation, lane.queuedCount);
			this.recordDrain(lane.operation, drainStart, itemsStarted);
		}
	}

	/**
	 * A deletion landing while work is queued or in flight makes the op
	 * moot, not failed. The membership delta is the deletion's trigger, so
	 * committed-meta absence is the earliest signal; the target's destroyed
	 * flag and folder registration lag it — the file can vanish from disk
	 * mid-op, before teardown finishes.
	 */
	private targetDeleted(item: QueueItem): boolean {
		if (item.scope !== "transfer") return false;
		if (item.target.destroyed) return true;
		if (!item.sharedFolder.files.has(item.guid)) return true;
		return !item.sharedFolder.syncStore.getCommittedMeta(item.target.path);
	}

	/**
	 * Run one item's operation under the provider deadline. The participant
	 * performs the work — the engine hands it the slot, the lease registry,
	 * and the cancellation flag, and never asks what kind of file it is.
	 */
	private execute(item: QueueItem): Promise<WorkCompletion> {
		const target = item.target as SyncParticipant;
		const lane = this.lanes[item.scope];
		const contextFor = (token: ProviderOperationToken): SyncOperationContext => ({
			timeProvider: this.timeProvider,
			holdLease: (release) => this.registerHeldLease(token, release),
			isCancelled: () => lane.isCancelled(item),
		});
		if (item.scope === "transfer") {
			return this.withProviderDeadline(
				(token) => target.transferFromServer(contextFor(token)),
				"download",
				"download delivery",
				item.guid,
			).then((bytes) => ({
				outcome: "completed" as const,
				bytes: bytes ?? undefined,
			}));
		}
		const intent = item.intent === "download" ? "converge" : item.intent;
		return this.withProviderDeadline(
			(token) => target.runSyncSession(intent, contextFor(token)),
			"sync",
			sessionAwaited(intent),
			item.guid,
		).then(() => ({ outcome: "completed" as const }));
	}

	// =========================================================================
	// Transport
	// =========================================================================

	private getAuthHeader(clientToken: ClientToken) {
		return {
			Authorization: `Bearer ${clientToken.token}`,
			...getRelayRequestHeaders(),
		};
	}

	private getBaseUrl(
		clientToken: ClientToken,
		entity: S3RemoteDocument | S3RemoteCanvas,
	): string {
		const urlObj = new URL(clientToken.url);
		urlObj.protocol = "https:";
		const parts = urlObj.pathname.split("/");
		parts.pop();
		parts.push(clientToken.docId);
		urlObj.pathname = parts.join("/");
		const baseUrl =
			clientToken.baseUrl?.replace(/\/$/, "") || urlObj.toString();

		return baseUrl;
	}

	async downloadItem(item: RemoteEntityFile): Promise<RequestUrlResponse> {
		const getId = (entity: S3RemoteCanvas | S3RemoteDocument) => {
			if (entity instanceof S3RemoteCanvas) {
				return entity.canvasId;
			}
			return entity.documentId;
		};
		const entity = item.s3rn;
		this.log("[downloadItem]", item.path, `${S3RN.encode(entity)}`);

		if (
			!(entity instanceof S3RemoteDocument || entity instanceof S3RemoteCanvas)
		) {
			throw new Error(`Unable to decode S3RN: ${S3RN.encode(entity)}`);
		}

		const clientToken = await item.getProviderToken();
		const headers = this.getAuthHeader(clientToken);
		const baseUrl = this.getBaseUrl(clientToken, entity);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrlWithMetrics({
			url: url,
			method: "GET",
			headers: headers,
			throw: false,
			relayNetworkDomain: "relay",
		});

		if (response.status === 200) {
			this.debug("[downloadItem]", getId(entity), response.status);
		} else {
			this.error(
				"[downloadItem]",
				getId(entity),
				url,
				response.status,
				response.text,
			);
			throw new Error(`Unable to download item: ${S3RN.encode(entity)}`);
		}
		return response;
	}

	/**
	 * Download raw CRDT bytes for a document by guid, without needing a
	 * Document instance. Used by the SharedFolder guid-remap path, where
	 * the server's content must be fetched *before* the old Document is
	 * destroyed — a failure here leaves old state intact and retriable.
	 *
	 * Does not participate in the lanes, syncGroups, or claim tracking. It
	 * is a bare HTTP fetch.
	 *
	 * Returns undefined if the server has the guid registered but no
	 * peer has uploaded content yet (empty contents, empty users map).
	 */
	async downloadByGuid(
		sharedFolder: SharedFolder,
		guid: string,
		path: string,
		kind: "doc" | "canvas" = "doc",
	): Promise<Uint8Array | undefined> {
		const entity =
			kind === "canvas"
				? new S3RemoteCanvas(sharedFolder.relayId!, sharedFolder.guid, guid)
				: new S3RemoteDocument(
						sharedFolder.relayId!,
						sharedFolder.guid,
						guid,
					);
		this.log("[downloadByGuid]", path, S3RN.encode(entity));

		const clientToken = await sharedFolder.tokenStore.getToken(
			S3RN.encode(entity),
			path,
			() => {},
		);
		const headers = this.getAuthHeader(clientToken);
		const baseUrl = this.getBaseUrl(clientToken, entity);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrlWithMetrics({
			url,
			method: "GET",
			headers,
			throw: false,
			relayNetworkDomain: "relay",
		});

		if (response.status !== 200) {
			this.error(
				"[downloadByGuid]",
				path,
				url,
				response.status,
				response.text,
			);
			throw new Error(
				`downloadByGuid: status ${response.status} for ${S3RN.encode(entity)}`,
			);
		}

		const updateBytes = new Uint8Array(response.arrayBuffer);

		// Peek at the update in a throwaway doc to detect empty-server.
		const tmpDoc = new Y.Doc();
		Y.applyUpdate(tmpDoc, updateBytes);
		if (isEmptyDoc(tmpDoc)) {
			this.log(
				"[downloadByGuid] server has guid registered but no content",
				path,
			);
			return undefined;
		}
		return updateBytes;
	}

	// =========================================================================
	// Folder status surfaces
	// =========================================================================

	getFolderPillProgress(sharedFolder: SharedFolder): GroupProgress | null {
		const group = this.syncGroups.get(sharedFolder);
		if (!group) return null;

		const snapshot = this.getFolderSyncSnapshot(sharedFolder);
		return {
			percent: snapshot.percent,
			syncPercent: snapshot.syncPercent,
			downloadPercent: snapshot.downloadPercent,
			sharedFolder,
			status: snapshot.progressStatus,
		};
	}

	getFolderSyncSnapshot(sharedFolder: SharedFolder): FolderSyncSnapshot {
		const activeDownloads = this.activeDownloads.filter(
			(item) => item.sharedFolder === sharedFolder,
		);
		const activeSync = this.activeSync.filter(
			(item) => item.sharedFolder === sharedFolder,
		);
		const queuedDownloads = this.pendingDownloads.filter(
			(item) => item.sharedFolder === sharedFolder,
		);
		const queuedSyncs = this.pendingSyncs.filter(
			(item) => item.sharedFolder === sharedFolder,
		);
		const folderResyncActive = this.folderResyncs.has(sharedFolder) ? 1 : 0;
		const activeItem = this.activeItemForSnapshot(activeDownloads, activeSync);
		const queuedReason = this.queuedReasonForSnapshot(
			sharedFolder,
			activeDownloads.length + activeSync.length,
			queuedDownloads.length + queuedSyncs.length,
		);

		return buildFolderSyncSnapshot({
			group: this.syncGroups.get(sharedFolder) ?? null,
			queued: queuedDownloads.length + queuedSyncs.length,
			active: activeDownloads.length + activeSync.length + folderResyncActive,
			isPaused: this.isPaused,
			failureCount: this.getFailures(sharedFolder).length,
			canResync: sharedFolder.connected && !sharedFolder.localOnly,
			folderActivity: folderResyncActive ? "checking" : null,
			activeItem,
			queuedReason,
		});
	}

	private activeItemForSnapshot(
		activeDownloads: QueueItem[],
		activeSync: QueueItem[],
	): FolderSyncWorkItemInput | null {
		const download = activeDownloads[0];
		if (download) return { kind: "download", path: download.path };
		const sync = activeSync[0];
		if (sync) return { kind: "sync", path: sync.path };
		return null;
	}

	private queuedReasonForSnapshot(
		sharedFolder: SharedFolder,
		active: number,
		queued: number,
	): "connection" | "reconnecting" | null {
		if (active > 0 || queued === 0) return null;
		if (!sharedFolder.connected) {
			return sharedFolder.state.status === "connecting"
				? "reconnecting"
				: "connection";
		}
		return null;
	}

	getFailures(sharedFolder: SharedFolder): BackgroundSyncFailure[] {
		this.clearVanishedFailures(sharedFolder);
		return this.failures
			.values()
			.filter((failure) => failure.sharedFolder === sharedFolder)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/**
	 * A failure survives only while its document is still registered. An
	 * external atomic write's temp file can register, fail a queued op with
	 * ENOENT, then unregister when the rename removes it — stranding a failure
	 * row for a path that resolves to no doc. Such a row is stale the moment its
	 * target is gone: drop it rather than let it hold the folder's "Sync issue"
	 * badge until a manual clear.
	 */
	private clearVanishedFailures(sharedFolder: SharedFolder): void {
		for (const failure of this.failures.values()) {
			if (failure.sharedFolder !== sharedFolder) continue;
			if (this.failureTargetVanished(failure)) {
				this.clearFailure(failure.id);
			}
		}
	}

	private failureTargetVanished(failure: BackgroundSyncFailure): boolean {
		const { sharedFolder, guid, path } = failure;
		return (
			!sharedFolder.files.has(guid) &&
			!sharedFolder.syncStore.getCommittedMeta(path)
		);
	}

	clearFailure(id: string): void {
		this.failures.delete(id);
		this.reclaimHistory.delete(id);
	}

	clearFailuresForFolder(sharedFolder: SharedFolder): void {
		for (const failure of this.failures.values()) {
			if (failure.sharedFolder === sharedFolder) {
				this.clearFailure(failure.id);
			}
		}
	}

	beginFolderResync(sharedFolder: SharedFolder): Unsubscriber {
		this.clearFailuresForFolder(sharedFolder);
		this.folderResyncs.add(sharedFolder);
		return () => {
			this.folderResyncs.delete(sharedFolder);
		};
	}

	subscribeToSync(
		callback: Subscriber<ObservableSet<QueueItem>>,
	): Unsubscriber {
		return this.activeSync.subscribe(callback);
	}

	subscribeToDownloads(
		callback: Subscriber<ObservableSet<QueueItem>>,
	): Unsubscriber {
		return this.activeDownloads.subscribe(callback);
	}

	subscribeToSyncGroups(
		callback: Subscriber<ObservableMap<SharedFolder, SyncGroup>>,
	): Unsubscriber {
		return this.syncGroups.subscribe(callback);
	}

	subscribeToProgress(callback: Subscriber<SyncProgress>): Unsubscriber {
		const handler = () => {
			callback(this.getOverallProgress());
		};

		const unsub1 = this.activeSync.subscribe(() => handler());
		const unsub2 = this.activeDownloads.subscribe(() => handler());
		const unsub3 = this.syncGroups.subscribe(() => handler());

		return () => {
			unsub1();
			unsub2();
			unsub3();
		};
	}

	/**
	 * Subscribes to progress updates for a specific shared folder
	 *
	 * @param sharedFolder The shared folder to monitor
	 * @param callback The function to call when progress changes
	 * @returns A function to unsubscribe
	 */
	subscribeToGroupProgress(
		sharedFolder: SharedFolder,
		callback: Subscriber<GroupProgress | null>,
	): Unsubscriber {
		return this.syncGroups.subscribe(() => {
			callback(this.getGroupProgress(sharedFolder));
		});
	}

	subscribeToFolderSyncSnapshot(
		sharedFolder: SharedFolder,
		callback: Subscriber<FolderSyncSnapshot>,
	): Unsubscriber {
		const state = this.getFolderSyncSnapshotSubscription(sharedFolder);
		state.subscribers.add(callback);
		if (state.latestSnapshot) callback(state.latestSnapshot);

		return () => {
			state.subscribers.delete(callback);
			if (state.subscribers.size === 0) {
				this.disposeFolderSyncSnapshotSubscription(sharedFolder, state);
			}
		};
	}

	private getFolderSyncSnapshotSubscription(
		sharedFolder: SharedFolder,
	): FolderSyncSnapshotSubscription {
		const existing = this.folderSyncSnapshotSubscriptions.get(sharedFolder);
		if (existing) return existing;

		const state: FolderSyncSnapshotSubscription = {
			smoother: null as any,
			subscribers: new Set(),
			latestSnapshot: null,
			unsubscribers: [],
			emit: () => {},
		};
		state.smoother = new FolderSyncSnapshotSmoother(
			this.timeProvider,
			(snapshot) => {
				state.latestSnapshot = snapshot;
				for (const subscriber of state.subscribers) {
					subscriber(snapshot);
				}
			},
		);
		state.emit = () => {
			state.smoother.update(this.getFolderSyncSnapshot(sharedFolder));
		};
		const folderStateKey = { type: "folder-sync-snapshot", sharedFolder };
		state.unsubscribers = [
			this.activeSync.on(state.emit),
			this.activeDownloads.on(state.emit),
			this.syncGroups.on(state.emit),
			this.failures.on(state.emit),
			this.folderResyncs.on(state.emit),
			this.queueStatusChanged.on(state.emit),
			sharedFolder.subscribe(folderStateKey, state.emit),
		];
		this.folderSyncSnapshotSubscriptions.set(sharedFolder, state);
		state.emit();
		return state;
	}

	private disposeFolderSyncSnapshotSubscription(
		sharedFolder: SharedFolder,
		state: FolderSyncSnapshotSubscription,
	): void {
		if (this.folderSyncSnapshotSubscriptions.get(sharedFolder) !== state) return;
		this.folderSyncSnapshotSubscriptions.delete(sharedFolder);
		state.unsubscribers.forEach((unsubscribe) => unsubscribe());
		state.smoother.destroy();
		state.subscribers.clear();
		state.latestSnapshot = null;
	}

	/**
	 * Pauses all lane processing. The lanes can be resumed by calling
	 * resume().
	 */
	pause(): void {
		this.isPaused = true;
		this.queueStatusChanged.notifyListeners();
	}

	/**
	 * Resumes lane processing after pause().
	 */
	resume(): void {
		this.debug("starting");
		this.isPaused = false;
		this.queueStatusChanged.notifyListeners();
		this.drainAll();
	}
	start = this.resume;

	/**
	 * Gets the current status of the lanes
	 *
	 * @returns An object with queue statistics
	 */
	getQueueStatus(): QueueStatus {
		return {
			syncsQueued: this.lanes.session.queuedCount,
			syncsActive: this.lanes.session.active.size,
			downloadsQueued: this.lanes.transfer.queuedCount,
			downloadsActive: this.lanes.transfer.active.size,
			isPaused: this.isPaused,
		};
	}

	subscribeToQueueStatus(callback: Subscriber<QueueStatus>): Unsubscriber {
		const emit = () => callback(this.getQueueStatus());
		const unsubscribers = [
			this.activeSync.subscribe(emit),
			this.activeDownloads.subscribe(emit),
			this.syncGroups.subscribe(emit),
			this.failures.subscribe(emit),
			this.queueStatusChanged.subscribe(emit),
		];

		return () => {
			unsubscribers.forEach((unsubscribe) => unsubscribe());
		};
	}

	/**
	 * Destroys this instance and cleans up all resources
	 *
	 * This method cleans up all resources used by this instance,
	 * including rejecting pending claims, destroying observable
	 * collections, and clearing the lanes.
	 */
	destroy(): void {
		for (const [sharedFolder, state] of [
			...this.folderSyncSnapshotSubscriptions.entries(),
		]) {
			this.disposeFolderSyncSnapshotSubscription(sharedFolder, state);
		}

		for (const unsubscribe of this.folderQueueWakeups.values()) {
			unsubscribe();
		}
		this.folderQueueWakeups.clear();
		// Invoke every release still registered by an in-flight operation
		// before dropping the registry: a hung operation's lease must not
		// outlive the bookkeeping that was going to release it. Marking each
		// token abandoned makes any post-destroy registration self-release.
		for (const [token, releases] of [...this.heldLeaseReleases]) {
			token.abandoned = true;
			for (const release of [...releases]) release();
		}
		this.heldLeaseReleases.clear();

		// Reject every pending claim and drop the lanes.
		const destroyed = new Error("BackgroundSync destroyed");
		for (const lane of Object.values(this.lanes)) {
			lane.destroy(destroyed);
		}

		this.reclaimHistory.clear();

		// Destroy observable collections
		this.folderResyncs.destroy();
		this.syncGroups.destroy();
		this.failures.destroy();
		this.queueStatusChanged.destroy();

		// Clean up references
		this.loginManager = null as any;
		this.timeProvider = null as any;

		// Unsubscribe from all subscriptions
		this.subscriptions.forEach((off) => off());
	}

	private recordFailure(item: QueueItem, error: unknown): void {
		const kind = laneFailureKind(item.scope);
		const id = this.failureKey(kind, item.guid);
		this.setFailure({
			id,
			guid: item.guid,
			path: item.target.path,
			kind,
			message: this.errorMessage(error),
			sharedFolder: item.sharedFolder,
			retryable: isRetryableSyncError(error),
			recordedAt: this.timeProvider.now(),
			request: requestOf(item),
			reclaims: this.reclaimHistory.get(id) ?? 0,
		});
	}

	private setFailure(failure: BackgroundSyncFailure): void {
		const existing = this.failures.get(failure.id);
		if (
			existing &&
			existing.guid === failure.guid &&
			existing.path === failure.path &&
			existing.kind === failure.kind &&
			existing.message === failure.message &&
			existing.sharedFolder === failure.sharedFolder &&
			existing.retryable === failure.retryable
		) {
			// Keep the original recordedAt: an identical failure re-recorded
			// paces its reclaim from the first occurrence, not the latest.
			return;
		}
		this.failures.set(failure.id, failure);
	}

	private failureKey(kind: BackgroundSyncFailure["kind"], guid: string): string {
		return `${kind}:${guid}`;
	}

	private errorMessage(error: unknown): string {
		return formatUserFacingError(error);
	}

	private logError(context: string, error: unknown): void {
		this.error(`${context}: ${this.errorMessage(error)}`, error);
	}
}

/** A file whose content lives in a per-file room on the relay. */
export interface RemoteEntityFile {
	readonly path: string;
	readonly s3rn: S3RNType;
	getProviderToken(): Promise<ClientToken>;
}

/** Metric label for what a session-scope operation awaits. */
function sessionAwaited(intent: "converge" | "upload" | "backfill"): string {
	switch (intent) {
		case "upload":
			return "upload ack";
		case "backfill":
			return "lca-backfill sync";
		default:
			return "provider sync";
	}
}

/** The request an admitted item carries, without the lane's bookkeeping. */
function requestOf(item: QueueItem): WorkRequest {
	const { guid, path, target, sharedFolder, scope, intent, trigger, userVisible } =
		item;
	return { guid, path, target, sharedFolder, scope, intent, trigger, userVisible };
}

function laneFailureKind(scope: WorkScope): "sync" | "download" {
	return scope === "transfer" ? "download" : "sync";
}

function laneOperationFor(item: QueueItem): LaneOperation {
	return item.scope === "transfer" ? "download" : "sync";
}

/** Metric label for a session-scope item's intent (historical names). */
function legacyIntent(item: QueueItem): "sync" | "upload" | "lca-backfill" {
	switch (item.intent) {
		case "upload":
			return "upload";
		case "backfill":
			return "lca-backfill";
		default:
			return "sync";
	}
}
