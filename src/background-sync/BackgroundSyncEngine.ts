import type { RequestUrlResponse } from "obsidian";
import type { LoginManager } from "../LoginManager";
import { isDocument, type Document } from "../Document";
import { isCanvas, type Canvas } from "../Canvas";
import { SyncFile, isSyncFile } from "../SyncFile";
import type { SharedFolder, SharedFolders } from "../SharedFolder";
import type { TimeProvider } from "../TimeProvider";
import { HasLogging, RelayInstances, metrics } from "../debug";
import {
	Observable,
	type Subscriber,
	type Unsubscriber,
} from "../observable/Observable";
import type { ObservableMap } from "../observable/ObservableMap";
import { ObservableSet } from "../observable/ObservableSet";
import { compareFilePaths } from "../FolderSort";
import {
	buildFolderSyncSnapshot,
	FolderSyncSnapshotSmoother,
	type FolderSyncSnapshot,
} from "../BackgroundSyncProgress";
import { isRetryableSyncError, retryReason } from "./errors";
import { DeadlineRegistry } from "./DeadlineRegistry";
import {
	WorkQueue,
	type WorkItem,
	type WorkSettle,
} from "./WorkQueue";
import type { TransferOperation } from "./DeadlineRegistry";
import { SyncOperations } from "./SyncOperations";
import { FolderProgressLedger, failureKey } from "./FolderProgressLedger";
import { isDocumentConflicted } from "../merge-hsm/SyncPlanner";
import type {
	BackgroundSyncApi,
	BackgroundSyncFailure,
	QueueItem,
	QueueStatus,
	SyncCompletionOutcome,
	SyncGroup,
	FolderPassRequest,
	SyncTarget,
	SyncWorkRequest,
} from "./types";

interface EngineWorkItem extends WorkItem {
	view: QueueItem;
}

const QUEUE_PUMP_INTERVAL_MS = 1000;
const RECLAIM_INTERVAL_MS = 5000;
// How long a terminally-failed file transfer rests before the periodic pass
// re-enqueues it. Short-lived blips are already absorbed by the queue's own
// backoff retries; this interval is the long-tail self-heal for outages that
// outlast them, so it can be generous without stranding files until reload.
const SYNC_FILE_RECLAIM_INTERVAL_MS = 5 * 60_000;

interface FolderSnapshotSubscription {
	smoother: FolderSyncSnapshotSmoother;
	subscribers: Set<Subscriber<FolderSyncSnapshot>>;
	latestSnapshot: FolderSyncSnapshot | null;
	unsubscribers: Unsubscriber[];
	emit: () => void;
}

/**
 * The background sync scheduler assembled from single-purpose parts: one
 * channel-aware WorkQueue owns scheduling, SyncOperations owns the
 * transfers, the DeadlineRegistry guards provider-bound awaits, and the
 * FolderProgressLedger projects lifecycle events into every progress and
 * failure surface. This class wires them together, owns the timers and
 * folder wakeups, and implements the public BackgroundSyncApi.
 */
export class BackgroundSyncEngine extends HasLogging implements BackgroundSyncApi {
	private ops: SyncOperations;
	private deadlines: DeadlineRegistry;
	private ledger = new FolderProgressLedger();
	private queue!: WorkQueue;
	/**
	 * One stable caller-facing promise per channel and guid: callers
	 * compare and share these, so settle mapping must not mint a new
	 * promise per read.
	 */
	private mapped = new Map<string, Promise<unknown>>();

	private paused = true;
	private destroyed = false;
	private queueStatusChanged = new Observable<BackgroundSyncEngine>(
		"BackgroundSyncEngine.queueStatus",
	);
	private folderSnapshotSubscriptions = new Map<
		SharedFolder,
		FolderSnapshotSubscription
	>();
	private folderQueueWakeups = new Map<SharedFolder, Unsubscriber>();
	private intervals: number[] = [];
	subscriptions: Unsubscriber[] = [];

	readonly activeSync: ObservableSet<QueueItem>;
	readonly activeDownloads: ObservableSet<QueueItem>;

	constructor(
		private loginManager: LoginManager,
		private timeProvider: TimeProvider,
		private sharedFolders: SharedFolders,
		private concurrency: number = 3,
	) {
		super();
		RelayInstances.set(this, "BackgroundSyncEngine");
		this.deadlines = new DeadlineRegistry(timeProvider);
		this.ops = new SyncOperations({
			timeProvider,
			isSyncCancelled: (doc) => this.isSyncCancelledDoc(doc),
			registerLease: (token, release) =>
				this.deadlines.registerHeldLease(token, release),
			isFetchCancelled: (doc) =>
				doc.destroyed || this.queue.isCancelled("download", doc.guid),
			enqueueSync: (item) => {
				this.enqueueSync(item).catch(() => {
					// The turnaround upload's failure is recorded by the queue;
					// the download that requested it already settled.
				});
			},
		});

		this.queue = new WorkQueue({
			channels: {
				sync: { concurrency },
				download: { concurrency },
			},
			timeProvider,
			isPaused: () => this.paused,
			comparePaths: (a, b) => compareFilePaths({ path: a }, { path: b }),
			isRetryable: isRetryableSyncError,
			retryReasonOf: (error) => retryReason(error as Error),
			listener: {
				onAdmitted: (item, preCounted) =>
					this.ledger.admitted(this.opOf(item), this.viewOf(item), preCounted),
				onStarted: (item) => {
					const view = this.viewOf(item);
					view.status = "running";
					this.activeSetOf(item).add(view);
					this.ledger.started(this.opOf(item), view);
				},
				onSettled: (item, outcome, error) => {
					const view = this.viewOf(item);
					view.status = outcome === "failed" ? "failed" : "completed";
					this.activeSetOf(item).delete(view);
					if (outcome === "failed" && error !== undefined) {
						const op = this.opOf(item);
						this.error(
							op === "sync"
								? `[Sync Failed]: ${this.ops.errorMessage(error)}`
								: `[Download Failed]: ${this.ops.errorMessage(error)}`,
							error,
						);
						this.recordFailure(op, view, error);
					}
					this.ledger.settled(
						this.opOf(item),
						view,
						outcome === "cancelled" ? "skipped" : outcome,
					);
				},
				onRequeued: (item) => {
					const view = this.viewOf(item);
					view.status = "pending";
					view.retryAttempts = item.retryAttempts;
					view.nextAttemptAt = item.nextAttemptAt;
					view.retryReason = item.retryReason as QueueItem["retryReason"];
					this.activeSetOf(item).delete(view);
					this.ledger.requeued(this.opOf(item), view);
				},
				onCancelledQueued: (item) =>
					this.ledger.cancelledQueued(this.opOf(item), this.viewOf(item)),
				onQueueChanged: () => this.queueStatusChanged.notifyListeners(),
			},
		});

		this.activeSync = new ObservableSet<QueueItem>();
		this.activeDownloads = new ObservableSet<QueueItem>();

		let lastQueuePumpAt = this.timeProvider.now();
		this.intervals.push(
			this.timeProvider.setInterval(() => {
				const now = this.timeProvider.now();
				this.recordTickDelay(
					"queue",
					lastQueuePumpAt,
					now,
					QUEUE_PUMP_INTERVAL_MS,
				);
				lastQueuePumpAt = now;
				this.queue.drain();
			}, QUEUE_PUMP_INTERVAL_MS),
		);

		// Long-tail reclaim of parked retryable failures. Disk-poll cadence
		// is the folder's own concern, not the engine's.
		let lastReclaimAt = this.timeProvider.now();
		this.intervals.push(
			this.timeProvider.setInterval(() => {
				const now = this.timeProvider.now();
				this.recordTickDelay(
					"folder_poll",
					lastReclaimAt,
					now,
					RECLAIM_INTERVAL_MS,
				);
				lastReclaimAt = now;
				this.reclaimStalledSyncFiles();
			}, RECLAIM_INTERVAL_MS),
		);

		this.subscriptions.push(
			this.sharedFolders.subscribe(() => {
				this.updateFolderQueueWakeups();
			}),
		);
		this.updateFolderQueueWakeups();
	}

	get syncGroups(): ObservableMap<SharedFolder, SyncGroup> {
		return this.ledger.syncGroups;
	}

	get pendingSyncs(): readonly QueueItem[] {
		return this.queue.pendingIn("sync").map((i) => this.viewOf(i));
	}

	get pendingDownloads(): readonly QueueItem[] {
		return this.queue.pendingIn("download").map((i) => this.viewOf(i));
	}

	// ---- transfer dispatch ----

	/**
	 * Bind the item's work order: the verb-to-operation choice happens
	 * once, when the decider admits the item, and the queue runs the bound
	 * closure without inspecting the target. The one verb change after
	 * admission — the in-place upload upgrade — re-binds explicitly.
	 */
	private bindSessionRun(item: QueueItem): () => Promise<unknown> {
		const doc = item.doc;
		if (doc instanceof SyncFile) {
			return () =>
				this.deadlines.withDeadline(
					() => this.ops.syncFile(doc),
					"sync",
					"file sync",
					item.guid,
				);
		}
		if (item.syncIntent === "upload") {
			return () =>
				this.deadlines.withDeadline(
					(token) => this.ops.syncDocumentUpload(doc, token),
					"sync",
					"upload ack",
					item.guid,
				);
		}
		if (item.syncIntent === "lca-backfill" && isDocument(doc)) {
			return () =>
				this.deadlines.withDeadline(
					(token) => this.ops.syncDocumentLCABackfill(doc, token),
					"sync",
					"lca-backfill sync",
					item.guid,
				);
		}
		return () =>
			this.deadlines.withDeadline(
				(token) => this.ops.syncDocument(doc, token),
				"sync",
				"provider sync",
				item.guid,
			);
	}

	private bindTransferRun(item: QueueItem): () => Promise<unknown> {
		const doc = item.doc;
		if (isCanvas(doc)) {
			return () =>
				this.deadlines.withDeadline(
					() => this.ops.getCanvas(doc),
					"download",
					"download delivery",
					item.guid,
				);
		}
		if (doc instanceof SyncFile) {
			return () =>
				this.deadlines.withDeadline(
					() => this.ops.getSyncFile(doc),
					"download",
					"download delivery",
					item.guid,
				);
		}
		return () =>
			this.deadlines.withDeadline(
				(token) => this.ops.getDocument(doc as Document, token),
				"download",
				"download delivery",
				item.guid,
			);
	}

	private makeSessionItem(
		doc: SyncTarget,
		opts: { syncIntent?: QueueItem["syncIntent"] } = {},
	): QueueItem {
		const item = this.makeQueueItem(doc, opts);
		item.run = this.bindSessionRun(item);
		return item;
	}

	private makeTransferItem(
		doc: SyncTarget,
		opts: { userVisible?: boolean } = {},
	): QueueItem {
		const item = this.makeQueueItem(doc, opts);
		item.run = this.bindTransferRun(item);
		return item;
	}

	// ---- single-queue plumbing ----

	private viewOf(item: WorkItem): QueueItem {
		return (item as EngineWorkItem).view;
	}

	private opOf(item: WorkItem): TransferOperation {
		return item.channel as TransferOperation;
	}

	private activeSetOf(item: WorkItem): ObservableSet<QueueItem> {
		return item.channel === "sync" ? this.activeSync : this.activeDownloads;
	}

	/**
	 * Map a generic settle to the session's caller-facing outcome. A
	 * skipped settle for a destroyed target keeps the legacy rejection so
	 * pipelines that treat teardown as an error still observe one.
	 */
	private mapSessionSettle(view: QueueItem) {
		return (settle: WorkSettle): SyncCompletionOutcome => {
			if (settle.outcome === "completed") return "completed";
			if (settle.outcome === "skipped" && view.doc.destroyed) {
				throw new Error("Document destroyed");
			}
			return "cancelled";
		};
	}

	private mapTransferSettle(view: QueueItem) {
		return (settle: WorkSettle): Uint8Array | undefined => {
			if (settle.outcome === "completed") {
				return settle.result as Uint8Array | undefined;
			}
			if (settle.outcome === "skipped" && view.doc.destroyed) {
				throw new Error("Document destroyed");
			}
			return undefined;
		};
	}

	private mapAndCache<R>(
		channel: "sync" | "download",
		view: QueueItem,
		promise: Promise<WorkSettle>,
		mapSettle: (settle: WorkSettle) => R,
	): Promise<R> {
		const key = `${channel}:${view.guid}`;
		const existing = this.mapped.get(key);
		if (existing) return existing as Promise<R>;
		const mapped = promise.then(mapSettle);
		this.mapped.set(key, mapped);
		const cleanup = () => {
			if (this.mapped.get(key) === mapped) {
				this.mapped.delete(key);
			}
		};
		mapped.then(cleanup, cleanup);
		return mapped;
	}

	private sharedSessionPromise(
		guid: string,
	): Promise<SyncCompletionOutcome> | undefined {
		return this.mapped.get(`sync:${guid}`) as
			| Promise<SyncCompletionOutcome>
			| undefined;
	}

	private sharedTransferPromise(
		guid: string,
	): Promise<Uint8Array | undefined> | undefined {
		return this.mapped.get(`download:${guid}`) as
			| Promise<Uint8Array | undefined>
			| undefined;
	}

	/** The guid's view in a channel, whether queued or in flight. */
	private findView(
		channel: "sync" | "download",
		guid: string,
	): QueueItem | undefined {
		const queued = this.queue.findQueued(channel, guid);
		if (queued) return this.viewOf(queued);
		const activeSet = channel === "sync" ? this.activeSync : this.activeDownloads;
		let found: QueueItem | undefined;
		activeSet.forEach((view) => {
			if (!found && view.guid === guid) found = view;
		});
		return found;
	}

	private wrapItem(
		channel: "sync" | "download",
		view: QueueItem,
	): EngineWorkItem {
		return {
			channel,
			key: view.guid,
			rank: channel === "sync" && view.syncIntent === "upload" ? 1 : 0,
			path: view.path,
			report: {
				group: view.sharedFolder.guid,
				// Dynamic: an in-place upload upgrade changes the view's
				// intent after admission, and start-time metrics read it.
				get kind() {
					return channel === "download"
						? "download"
						: (view.syncIntent ?? "sync");
				},
				userVisible: view.userVisible,
			},
			ready: () =>
				view.sharedFolder.connected &&
				view.sharedFolder.intent !== "disconnected",
			// Stable teardown only; the deleted-target compound classifies
			// failures (failureIsMoot), where it is sound.
			moot: () => view.doc.destroyed,
			failureIsMoot:
				channel === "download"
					? () => this.downloadTargetDeleted(view)
					: undefined,
			run: () => view.run!(),
			view,
		};
	}

	private admitSession(
		view: QueueItem,
		opts: { deferFlush?: boolean; preCounted?: boolean } = {},
	): Promise<SyncCompletionOutcome> {
		const existing = this.sharedSessionPromise(view.guid);
		if (existing && this.queue.has("sync", view.guid)) {
			// Preserve supersession/sharing on the underlying queue, then
			// hand back the stable caller-facing promise.
			void this.queue.admit(this.wrapItem("sync", view), opts);
			return existing;
		}
		return this.mapAndCache(
			"sync",
			view,
			this.queue.admit(this.wrapItem("sync", view), opts),
			this.mapSessionSettle(view),
		);
	}

	private admitTransfer(
		view: QueueItem,
		opts: { deferFlush?: boolean; preCounted?: boolean } = {},
	): Promise<Uint8Array | undefined> {
		const existing = this.sharedTransferPromise(view.guid);
		if (existing && this.queue.has("download", view.guid)) {
			void this.queue.admit(this.wrapItem("download", view), opts);
			return existing;
		}
		return this.mapAndCache(
			"download",
			view,
			this.queue.admit(this.wrapItem("download", view), opts),
			this.mapTransferSettle(view),
		);
	}

	// ---- gates ----

	private isSyncCancelledDoc(doc: SyncTarget): boolean {
		return doc.destroyed || this.queue.isCancelled("sync", doc.guid);
	}

	/**
	 * Failure classifier: a deletion landing while a download is in flight
	 * makes the op moot, not failed. The membership delta is the deletion's
	 * trigger, so committed-meta absence is the earliest signal; the doc's
	 * destroyed flag and folder registration lag it — the file can vanish
	 * from disk mid-op, before doc teardown finishes. Consulted only after
	 * a failed run: a doc mid-materialization also has no committed row
	 * yet, so before a run this compound cannot tell "deleted" from "not
	 * yet enrolled" and must not gate anything.
	 */
	private downloadTargetDeleted(item: QueueItem): boolean {
		if (item.doc.destroyed) return true;
		if (!item.sharedFolder.files.has(item.guid)) return true;
		return !item.sharedFolder.syncStore.getCommittedMeta(item.doc.path);
	}

	// ---- enqueue API ----

	private makeQueueItem(
		doc: SyncTarget,
		opts: {
			userVisible?: boolean;
			syncIntent?: QueueItem["syncIntent"];
		} = {},
	): QueueItem {
		const sharedFolder = doc.sharedFolder;
		return {
			guid: doc.guid,
			path: sharedFolder.getPath(doc.path),
			doc,
			status: "pending",
			sharedFolder,
			userVisible: opts.userVisible ?? false,
			enqueuedAt: this.timeProvider.now(),
			syncIntent: opts.syncIntent,
		};
	}

	async enqueueSync(
		item: SyncTarget,
		deferQueueFlush = false,
	): Promise<SyncCompletionOutcome> {
		if (isDocument(item) && isDocumentConflicted(item)) {
			this.ledger.clearFailure(failureKey("sync", item.guid));
			return "completed";
		}
		if (this.queue.has("sync", item.guid)) {
			return (
				this.sharedSessionPromise(item.guid) ??
				Promise.resolve("completed")
			);
		}
		this.ledger.clearFailure(failureKey("sync", item.guid));
		return this.admitSession(this.makeSessionItem(item), {
			deferFlush: deferQueueFlush,
		});
	}

	async enqueueRetryableSync(
		item: SyncTarget,
		error: Error,
	): Promise<SyncCompletionOutcome> {
		if (isDocument(item) && isDocumentConflicted(item)) {
			this.ledger.clearFailure(failureKey("sync", item.guid));
			return "completed";
		}
		if (this.queue.has("sync", item.guid)) {
			return (
				this.sharedSessionPromise(item.guid) ??
				Promise.resolve("completed")
			);
		}
		const wrapped = this.wrapItem("sync", this.makeSessionItem(item));
		const settle = this.queue.admitForRetry(wrapped, error);
		const promise = settle
			? this.mapAndCache(
					"sync",
					wrapped.view,
					settle,
					this.mapSessionSettle(wrapped.view),
				)
			: null;
		if (!promise) {
			return Promise.reject(error);
		}
		return promise;
	}

	/**
	 * Enqueue a local-authoritative upload before markUploaded(). For
	 * documents, this seeds remoteDoc from the enrolled local CRDT before
	 * provider sync resolves; other file types use their normal sync
	 * mechanics.
	 *
	 * The resolved outcome tells the caller whether the transfer actually
	 * completed: cancellation settles the completion (resolve, not reject)
	 * so the pipeline behind it drains, but it resolves "cancelled" so the
	 * caller's markUploaded can stand down instead of publishing membership
	 * for content that only partially transferred.
	 */
	async enqueueUpload(item: SyncTarget): Promise<SyncCompletionOutcome> {
		if (isDocument(item) && isDocumentConflicted(item)) {
			this.ledger.clearFailure(failureKey("sync", item.guid));
			return "completed";
		}

		if (this.queue.has("sync", item.guid)) {
			const queuedWork = this.queue.findQueued("sync", item.guid);
			const queued = queuedWork ? this.viewOf(queuedWork) : undefined;
			if (queued) {
				// The verb changes, so the bound work order changes with it.
				queued.syncIntent = "upload";
				queued.run = this.bindSessionRun(queued);
				return (
					this.sharedSessionPromise(item.guid) ??
					Promise.resolve("completed")
				);
			}

			const active = this.activeSync.find(
				(activeItem) => activeItem.guid === item.guid,
			);
			if (active?.syncIntent === "upload") {
				return (
					this.sharedSessionPromise(item.guid) ??
					Promise.resolve("completed")
				);
			}

			return this.enqueueUploadAfterCurrentSync(item);
		}

		this.ledger.clearFailure(failureKey("sync", item.guid));
		return this.admitSession(
			this.makeSessionItem(item, { syncIntent: "upload" }),
		);
	}

	private async enqueueUploadAfterCurrentSync(
		item: SyncTarget,
	): Promise<SyncCompletionOutcome> {
		try {
			const outcome = await (this.sharedSessionPromise(item.guid) ??
				Promise.resolve<SyncCompletionOutcome>("completed"));
			// A cancellation of the current operation targets this guid's
			// identity, and the flag clears when it settles. The waiting
			// upload must stand down with it — re-enqueueing would launder
			// the cancellation into a "completed" that licenses publication.
			if (outcome === "cancelled") return "cancelled";
		} catch {
			// The upload request is the stronger follow-up operation. Let it run
			// even if the weaker sync attempt failed.
		}
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		// Teardown while waiting: no transfer ran, so nothing may publish.
		if (this.destroyed) return "cancelled";
		return this.enqueueUpload(item);
	}

	enqueueDownload(
		item: SyncTarget,
		userVisible = true,
	): Promise<Uint8Array | undefined> {
		if (this.queue.has("download", item.guid)) {
			return (
				this.sharedTransferPromise(item.guid) ??
				Promise.resolve(undefined)
			);
		}
		this.ledger.clearFailure(failureKey("download", item.guid));
		return this.admitTransfer(this.makeTransferItem(item, { userVisible }));
	}

	/**
	 * Immediate-lane download: a fetch whose consumer is waiting (live-edit
	 * gap recovery) runs on dedicated slots instead of waiting behind
	 * queued sweep work, parking into the background queue only when it
	 * cannot start. Shares the download identity table with enqueueDownload.
	 */
	downloadNow(item: SyncTarget): Promise<Uint8Array | undefined> {
		this.ledger.clearFailure(failureKey("download", item.guid));
		const view = this.makeTransferItem(item, { userVisible: false });
		const existing = this.sharedTransferPromise(view.guid);
		if (existing && this.queue.has("download", view.guid)) {
			// Promote a queued same-key item onto an immediate slot.
			void this.queue.runNow(this.wrapItem("download", view));
			return existing;
		}
		return this.mapAndCache(
			"download",
			view,
			this.queue.runNow(this.wrapItem("download", view)),
			this.mapTransferSettle(view),
		);
	}

	/**
	 * Folder pass: the decider's selection resets the folder's progress
	 * group to its own totals, and the requests are admitted pre-counted
	 * with one ordering flush per queue. An item already in flight stays
	 * counted — its settle credits this pass.
	 */
	enqueuePass(sharedFolder: SharedFolder, requests: FolderPassRequest[]): void {
		const selection = {
			total: requests.length,
			syncs: 0,
			downloads: 0,
			userDownloads: 0,
		};
		for (const request of requests) {
			if (request.intent === "fetch") {
				selection.downloads++;
				if (request.userVisible) selection.userDownloads++;
			} else {
				selection.syncs++;
			}
		}
		this.ledger.beginFolderPass(sharedFolder, selection);
		if (requests.length === 0) return;

		this.sortRequestsByPath(requests);
		const sessionBefore = this.queue.queuedCountIn("sync");
		const transferBefore = this.queue.queuedCountIn("download");
		for (const request of requests) {
			if (request.intent === "fetch") {
				this.admitFetchForPass(request.target, request.userVisible ?? false);
			} else {
				this.admitForFolderPass(request.target);
			}
		}
		if (
			this.queue.queuedCountIn("sync") > sessionBefore ||
			this.queue.queuedCountIn("download") > transferBefore
		) {
			this.queue.flush("group");
		}
		this.ledger.finishFolderPassRegistration(sharedFolder);
	}

	private admitFetchForPass(item: SyncTarget, userVisible: boolean): void {
		if (this.queue.has("download", item.guid)) {
			// Already in flight: the pass's totals count it, so its settle
			// must credit this pass's era.
			const view = this.findView("download", item.guid);
			if (view) this.ledger.adoptIntoCurrentPass(view);
			return;
		}
		this.ledger.clearFailure(failureKey("download", item.guid));
		this.admitTransfer(this.makeTransferItem(item, { userVisible }), {
			deferFlush: true,
			preCounted: true,
		})
			.catch(() => {
				// Terminal failures are recorded as failure rows; the pass has
				// no caller waiting on individual completions.
			});
	}

	/**
	 * Pass admissions are pre-counted: the pass registered the folder's
	 * totals up front, so admission must not grow them again. An item
	 * already in flight stays counted — its settle credits this pass.
	 */
	private admitForFolderPass(item: SyncTarget): void {
		if (isDocument(item) && isDocumentConflicted(item)) {
			this.ledger.clearFailure(failureKey("sync", item.guid));
			return;
		}
		if (this.queue.has("sync", item.guid)) {
			const view = this.findView("sync", item.guid);
			if (view) this.ledger.adoptIntoCurrentPass(view);
			return;
		}
		this.ledger.clearFailure(failureKey("sync", item.guid));
		this.admitSession(this.makeSessionItem(item), {
			deferFlush: true,
			preCounted: true,
		})
			.catch(() => {
				// Terminal failures are recorded as failure rows; the pass has
				// no caller waiting on individual completions.
			});
	}

	private admitLCABackfillDoc(doc: Document): void {
		if (isDocumentConflicted(doc)) {
			this.ledger.clearFailure(failureKey("sync", doc.guid));
			return;
		}
		if (this.queue.has("sync", doc.guid)) return;
		this.ledger.clearFailure(failureKey("sync", doc.guid));
		this.admitSession(this.makeSessionItem(doc, { syncIntent: "lca-backfill" }), {
			deferFlush: true,
		})
			.catch(() => {
				// Recorded as a failure row; backfill has no awaiting caller.
			});
	}

	/**
	 * Admit a decider's batch: each request enters its queue with the flush
	 * deferred, then each queue that grew sorts, notifies, and drains once.
	 * Duplicate guids inside one batch collapse through admission
	 * deduplication in array order, so a converge listed before a
	 * backfill-baseline for the same document wins.
	 */
	enqueueMany(requests: SyncWorkRequest[]): void {
		const sessionBefore = this.queue.queuedCountIn("sync");
		const transferBefore = this.queue.queuedCountIn("download");
		for (const request of requests) {
			switch (request.intent) {
				case "converge":
					this.enqueueSync(request.target, true).catch(() => {
						// Recorded as a failure row; batch emission has no caller.
					});
					break;
				case "publish":
					this.enqueueUpload(request.target).catch(() => {
						// Same: the outcome is observed through failure rows.
					});
					break;
				case "fetch":
					this.enqueueDownload(
						request.target,
						request.userVisible ?? true,
					).catch(() => {
						// Same: the outcome is observed through failure rows.
					});
					break;
				case "backfill-baseline":
					if (isDocument(request.target)) {
						this.admitLCABackfillDoc(request.target);
					}
					break;
			}
		}
		if (
			this.queue.queuedCountIn("sync") > sessionBefore ||
			this.queue.queuedCountIn("download") > transferBefore
		) {
			this.queue.flush("batch");
		}
	}

	/**
	 * Work for one target serializes across intents: pending or active
	 * work on either queue means deciders do not re-select the target,
	 * and the queues' cross-direction gates park an admission while the
	 * other direction's work for the guid runs.
	 */
	isQueuedOrActive(guid: string, queue?: "session" | "transfer"): boolean {
		if (queue === "session") return this.queue.has("sync", guid);
		if (queue === "transfer") return this.queue.has("download", guid);
		return this.queue.has("sync", guid) || this.queue.has("download", guid);
	}

	cancelDocumentWork(guid: string): void {
		this.queue.cancel(guid);
		this.ledger.clearFailure(failureKey("sync", guid));
		this.ledger.clearFailure(failureKey("download", guid));
	}

	// ---- bare fetches ----

	downloadItem(item: Document | Canvas): Promise<RequestUrlResponse> {
		return this.ops.downloadItem(item);
	}

	downloadByGuid(
		sharedFolder: SharedFolder,
		guid: string,
		path: string,
		kind: "doc" | "canvas" = "doc",
	): Promise<Uint8Array | undefined> {
		return this.ops.downloadByGuid(sharedFolder, guid, path, kind);
	}

	// ---- progress and snapshots ----

	getFolderSyncSnapshot(sharedFolder: SharedFolder): FolderSyncSnapshot {
		const state = this.ledger.getFolderWorkState(sharedFolder);
		return buildFolderSyncSnapshot({
			group: state.group,
			queued: state.queued,
			active: state.active,
			isPaused: this.paused,
			failureCount: state.failureCount,
			canResync: sharedFolder.connected && !sharedFolder.localOnly,
			folderActivity: state.resyncActive ? "checking" : null,
			activeItem: state.activeItem,
			queuedReason: this.queuedReasonForSnapshot(
				sharedFolder,
				state.active,
				state.queued,
			),
		});
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

	subscribeToFolderSyncSnapshot(
		sharedFolder: SharedFolder,
		callback: Subscriber<FolderSyncSnapshot>,
	): Unsubscriber {
		const state = this.getFolderSnapshotSubscription(sharedFolder);
		state.subscribers.add(callback);
		if (state.latestSnapshot) callback(state.latestSnapshot);

		return () => {
			state.subscribers.delete(callback);
			if (state.subscribers.size === 0) {
				this.disposeFolderSnapshotSubscription(sharedFolder, state);
			}
		};
	}

	/**
	 * One subscription bundle per folder, attached to that folder's ledger
	 * observable and connection state only. Another folder's work never
	 * rebuilds this folder's snapshot — the scoped-refresh contract a
	 * per-folder UI surface relies on.
	 */
	private getFolderSnapshotSubscription(
		sharedFolder: SharedFolder,
	): FolderSnapshotSubscription {
		const existing = this.folderSnapshotSubscriptions.get(sharedFolder);
		if (existing) return existing;

		const state: FolderSnapshotSubscription = {
			smoother: null as unknown as FolderSyncSnapshotSmoother,
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
			this.ledger.onFolderChanged(sharedFolder, state.emit),
			sharedFolder.subscribe(folderStateKey, state.emit),
		];
		this.folderSnapshotSubscriptions.set(sharedFolder, state);
		state.emit();
		return state;
	}

	private disposeFolderSnapshotSubscription(
		sharedFolder: SharedFolder,
		state: FolderSnapshotSubscription,
	): void {
		if (this.folderSnapshotSubscriptions.get(sharedFolder) !== state) return;
		this.folderSnapshotSubscriptions.delete(sharedFolder);
		state.unsubscribers.forEach((unsubscribe) => unsubscribe());
		state.smoother.destroy();
		state.subscribers.clear();
		state.latestSnapshot = null;
	}

	getQueueStatus(): QueueStatus {
		return {
			syncsQueued: this.queue.queuedCountIn("sync"),
			syncsActive: this.queue.activeCountIn("sync"),
			downloadsQueued: this.queue.queuedCountIn("download"),
			downloadsActive: this.queue.activeCountIn("download"),
			isPaused: this.paused,
		};
	}

	// ---- failures ----

	private recordFailure(
		kind: BackgroundSyncFailure["kind"],
		item: QueueItem,
		error: unknown,
	): void {
		this.ledger.setFailure({
			id: failureKey(kind, item.guid),
			guid: item.guid,
			path: item.doc.path,
			kind,
			message: this.ops.errorMessage(error),
			sharedFolder: item.sharedFolder,
			retryable: isRetryableSyncError(error),
			recordedAt: this.timeProvider.now(),
		});
	}

	getFailures(sharedFolder: SharedFolder): BackgroundSyncFailure[] {
		return this.ledger.getFailures(sharedFolder);
	}

	clearFailure(id: string): void {
		this.ledger.clearFailure(id);
	}

	beginFolderResync(sharedFolder: SharedFolder): Unsubscriber {
		return this.ledger.beginResync(sharedFolder);
	}

	/**
	 * A file transfer that exhausted its queue retries must stay claimable:
	 * nothing else re-enqueues an unchanged file within a session (the folder
	 * poll covers documents and canvases; membership deltas only fire when
	 * metadata changes), so without this pass one outage lasting longer than
	 * the backoff window strands the file until plugin reload. Re-enqueue
	 * transient failures once the reclaim interval has elapsed. Permanent
	 * classes stay parked: retrying cannot heal an auth or permission
	 * refusal, and re-driving them would ping the server forever.
	 */
	reclaimStalledSyncFiles(): void {
		const now = this.timeProvider.now();
		for (const failure of this.ledger.reclaimableSyncFileFailures(
			now,
			SYNC_FILE_RECLAIM_INTERVAL_MS,
		)) {
			if (
				!failure.sharedFolder.connected ||
				failure.sharedFolder.intent === "disconnected"
			) {
				continue;
			}
			if (
				this.queue.has("sync", failure.guid) ||
				this.queue.has("download", failure.guid)
			) {
				continue;
			}
			const file = failure.sharedFolder.files.get(failure.guid);
			if (!isSyncFile(file) || file.destroyed) continue;
			this.debug(
				`[reclaim] re-enqueueing stalled file transfer for ${failure.path}`,
			);
			if (failure.kind === "download") {
				this.enqueueDownload(file, false).catch(() => {
					// The failure is re-recorded by the queue; the next reclaim
					// pass paces itself from the fresh record.
				});
			} else {
				this.enqueueSync(file).catch(() => {
					// Same: the queue re-records the failure on rejection.
				});
			}
		}
	}

	// ---- lifecycle ----

	pause(): void {
		this.paused = true;
		this.queueStatusChanged.notifyListeners();
		this.ledger.notifyAllFolders();
	}

	resume(): void {
		this.debug("starting");
		this.paused = false;
		this.queueStatusChanged.notifyListeners();
		this.ledger.notifyAllFolders();
		this.queue.drain();
	}
	start = this.resume;

	destroy(): void {
		this.destroyed = true;
		for (const interval of this.intervals) {
			this.timeProvider.clearInterval(interval);
		}
		this.intervals = [];

		this.queue.destroy("BackgroundSync destroyed");
		this.mapped.clear();
		this.activeSync.destroy();
		this.activeDownloads.destroy();

		for (const [sharedFolder, state] of [
			...this.folderSnapshotSubscriptions.entries(),
		]) {
			this.disposeFolderSnapshotSubscription(sharedFolder, state);
		}

		for (const unsubscribe of this.folderQueueWakeups.values()) {
			unsubscribe();
		}
		this.folderQueueWakeups.clear();

		this.deadlines.destroy();
		this.ledger.destroy();
		this.queueStatusChanged.destroy();

		this.loginManager = null as never;
		this.timeProvider = null as never;

		this.subscriptions.forEach((off) => off());
	}

	// ---- wakeups and timers ----

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

	private wakeQueues(): void {
		if (this.destroyed) return;
		this.queue.drain();
	}

	private sortRequestsByPath(requests: SyncWorkRequest[]): void {
		if (requests.length < 2) return;
		const sortStart = performance.now();
		requests.sort((a, b) => compareFilePaths(a.target, b.target));
		metrics.observeBgSyncSort(
			"sync",
			"group",
			requests.length,
			(performance.now() - sortStart) / 1000,
		);
	}

	private recordTickDelay(
		tick: "queue" | "folder_poll",
		lastTickAt: number,
		now: number,
		intervalMs: number,
	): void {
		const delayMs = Math.max(0, now - lastTickAt - intervalMs);
		metrics.observeBgSyncTickDelay(tick, delayMs / 1000);
	}
}
