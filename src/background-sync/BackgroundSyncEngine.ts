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
import type { ObservableSet } from "../observable/ObservableSet";
import { compareFilePaths } from "../FolderSort";
import {
	buildFolderSyncSnapshot,
	FolderSyncSnapshotSmoother,
	type FolderSyncSnapshot,
} from "../BackgroundSyncProgress";
import { isRetryableSyncError, retryReason } from "./errors";
import { DeadlineRegistry } from "./DeadlineRegistry";
import { DirectionQueue } from "./DirectionQueue";
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
 * The background sync scheduler assembled from single-purpose parts: two
 * DirectionQueues over the generic WorkQueue own scheduling,
 * SyncOperations owns the transfers, the
 * DeadlineRegistry guards provider-bound awaits, and the
 * FolderProgressLedger projects lifecycle events into every progress and
 * failure surface. This class wires them together, owns the timers and
 * folder wakeups, and implements the public BackgroundSyncApi.
 */
export class BackgroundSyncEngine extends HasLogging implements BackgroundSyncApi {
	private ops: SyncOperations;
	private deadlines: DeadlineRegistry;
	private ledger = new FolderProgressLedger();
	private sessionQueue: DirectionQueue<SyncCompletionOutcome>;
	private transferQueue: DirectionQueue<Uint8Array | undefined>;

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
				doc.destroyed || this.transferQueue.isCancelledGuid(doc.guid),
			enqueueSync: (item) => {
				this.enqueueSync(item).catch(() => {
					// The turnaround upload's failure is recorded by the queue;
					// the download that requested it already settled.
				});
			},
		});

		this.sessionQueue = new DirectionQueue<SyncCompletionOutcome>({
			label: "sync",
			concurrency,
			timeProvider,
			isPaused: () => this.paused,
			run: (item) => item.run!(),
			successValue: () => "completed",
			cancelledValue: () => "cancelled",
			// Cancellation flags live in the queue; mootness here is only
			// the target's own teardown.
			isMoot: (item) => item.doc.destroyed,
			// One identity per target across directions: a session parks
			// while the guid's download runs instead of racing it.
			isBlocked: (item) => this.transferQueue.isActiveGuid(item.guid),
			isRetryable: isRetryableSyncError,
			retryReasonOf: (error) => retryReason(error as Error),
			listener: {
				onAdmitted: (item, preCounted) =>
					this.ledger.admitted("sync", item, preCounted),
				onStarted: (item) => this.ledger.started("sync", item),
				onSettled: (item, terminal, error) => {
					if (terminal === "failed" && error !== undefined) {
						this.error(
							`[Sync Failed]: ${this.ops.errorMessage(error)}`,
							error,
						);
						this.recordFailure("sync", item, error);
					}
					this.ledger.settled("sync", item, terminal);
					// A settle may unblock the guid's parked cross-direction
					// work before the next pump tick.
					queueMicrotask(() => this.transferQueue?.drain());
				},
				onRequeued: (item) => this.ledger.requeued("sync", item),
				onCancelledQueued: (item) =>
					this.ledger.cancelledQueued("sync", item),
				onQueueChanged: () => this.queueStatusChanged.notifyListeners(),
			},
		});

		this.transferQueue = new DirectionQueue<Uint8Array | undefined>({
			label: "download",
			concurrency,
			timeProvider,
			isPaused: () => this.paused,
			run: (item) => item.run!(),
			// A transfer that completed after its cancellation delivers
			// nothing; the queue maps cancelled and moot completions before
			// this value is consulted.
			successValue: (item, result) => result as Uint8Array | undefined,
			cancelledValue: () => undefined,
			// Absent committed meta cannot distinguish a deletion from a doc
			// mid-materialization, so the deleted-target compound classifies
			// only failures; before a run, mootness is teardown alone.
			isMoot: (item) => item.doc.destroyed,
			isFailureMoot: (item) => this.downloadTargetDeleted(item),
			isBlocked: (item) => this.sessionQueue.isActiveGuid(item.guid),
			isRetryable: isRetryableSyncError,
			retryReasonOf: (error) => retryReason(error as Error),
			listener: {
				onAdmitted: (item, preCounted) =>
					this.ledger.admitted("download", item, preCounted),
				onStarted: (item) => this.ledger.started("download", item),
				onSettled: (item, terminal, error) => {
					if (terminal === "failed" && error !== undefined) {
						this.error(
							`[Download Failed]: ${this.ops.errorMessage(error)}`,
							error,
						);
						this.recordFailure("download", item, error);
					}
					this.ledger.settled("download", item, terminal);
					queueMicrotask(() => this.sessionQueue?.drain());
				},
				onRequeued: (item) => this.ledger.requeued("download", item),
				onCancelledQueued: (item) =>
					this.ledger.cancelledQueued("download", item),
				onQueueChanged: () => this.queueStatusChanged.notifyListeners(),
			},
		});

		this.activeSync = this.sessionQueue.active;
		this.activeDownloads = this.transferQueue.active;

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
				this.sessionQueue.drain();
				this.transferQueue.drain();
			}, QUEUE_PUMP_INTERVAL_MS),
		);

		// Long-tail reclaim of parked retryable failures. Folders own their
		// disk-poll cadence themselves ([[sync work routing]]).
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
		return this.sessionQueue.pending;
	}

	get pendingDownloads(): readonly QueueItem[] {
		return this.transferQueue.pending;
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

	// ---- gates ----

	private isSyncCancelledDoc(doc: SyncTarget): boolean {
		return doc.destroyed || this.sessionQueue.isCancelledGuid(doc.guid);
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
		if (this.sessionQueue.has(item.guid)) {
			return (
				this.sessionQueue.sharedPromise(item.guid) ??
				Promise.resolve("completed")
			);
		}
		this.ledger.clearFailure(failureKey("sync", item.guid));
		return this.sessionQueue.admit(this.makeSessionItem(item), {
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
		if (this.sessionQueue.has(item.guid)) {
			return (
				this.sessionQueue.sharedPromise(item.guid) ??
				Promise.resolve("completed")
			);
		}
		const promise = this.sessionQueue.admitForRetry(
			this.makeSessionItem(item),
			error,
		);
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

		if (this.sessionQueue.has(item.guid)) {
			const queued = this.sessionQueue.findQueued(item.guid);
			if (queued) {
				// The verb changes, so the bound work order changes with it.
				queued.syncIntent = "upload";
				queued.run = this.bindSessionRun(queued);
				return (
					this.sessionQueue.sharedPromise(item.guid) ??
					Promise.resolve("completed")
				);
			}

			const active = this.activeSync.find(
				(activeItem) => activeItem.guid === item.guid,
			);
			if (active?.syncIntent === "upload") {
				return (
					this.sessionQueue.sharedPromise(item.guid) ??
					Promise.resolve("completed")
				);
			}

			return this.enqueueUploadAfterCurrentSync(item);
		}

		this.ledger.clearFailure(failureKey("sync", item.guid));
		return this.sessionQueue.admit(
			this.makeSessionItem(item, { syncIntent: "upload" }),
		);
	}

	private async enqueueUploadAfterCurrentSync(
		item: SyncTarget,
	): Promise<SyncCompletionOutcome> {
		try {
			const outcome = await (this.sessionQueue.sharedPromise(item.guid) ??
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
		if (this.transferQueue.has(item.guid)) {
			return (
				this.transferQueue.sharedPromise(item.guid) ??
				Promise.resolve(undefined)
			);
		}
		this.ledger.clearFailure(failureKey("download", item.guid));
		return this.transferQueue.admit(this.makeTransferItem(item, { userVisible }));
	}

	/**
	 * Immediate-lane download: a fetch whose consumer is waiting (live-edit
	 * gap recovery) runs on dedicated slots instead of waiting behind
	 * queued sweep work, parking into the background queue only when it
	 * cannot start. Shares the download identity table with enqueueDownload.
	 */
	downloadNow(item: SyncTarget): Promise<Uint8Array | undefined> {
		this.ledger.clearFailure(failureKey("download", item.guid));
		return this.transferQueue.runNow(
			this.makeTransferItem(item, { userVisible: false }),
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
		const sessionBefore = this.sessionQueue.queuedCount;
		const transferBefore = this.transferQueue.queuedCount;
		for (const request of requests) {
			if (request.intent === "fetch") {
				this.admitFetchForPass(request.target, request.userVisible ?? false);
			} else {
				this.admitForFolderPass(request.target);
			}
		}
		if (this.sessionQueue.queuedCount > sessionBefore) {
			this.sessionQueue.flush("group");
		}
		if (this.transferQueue.queuedCount > transferBefore) {
			this.transferQueue.flush("group");
		}
		this.ledger.finishFolderPassRegistration(sharedFolder);
	}

	private admitFetchForPass(item: SyncTarget, userVisible: boolean): void {
		if (this.transferQueue.has(item.guid)) {
			// Already in flight: the pass's totals count it, so its settle
			// must credit this pass's era.
			const view = this.transferQueue.findView(item.guid);
			if (view) this.ledger.adoptIntoCurrentPass(view);
			return;
		}
		this.ledger.clearFailure(failureKey("download", item.guid));
		this.transferQueue
			.admit(this.makeTransferItem(item, { userVisible }), {
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
		if (this.sessionQueue.has(item.guid)) {
			const view = this.sessionQueue.findView(item.guid);
			if (view) this.ledger.adoptIntoCurrentPass(view);
			return;
		}
		this.ledger.clearFailure(failureKey("sync", item.guid));
		this.sessionQueue
			.admit(this.makeSessionItem(item), { deferFlush: true, preCounted: true })
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
		if (this.sessionQueue.has(doc.guid)) return;
		this.ledger.clearFailure(failureKey("sync", doc.guid));
		this.sessionQueue
			.admit(this.makeSessionItem(doc, { syncIntent: "lca-backfill" }), {
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
		const sessionBefore = this.sessionQueue.queuedCount;
		const transferBefore = this.transferQueue.queuedCount;
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
		if (this.sessionQueue.queuedCount > sessionBefore) {
			this.sessionQueue.flush("batch");
		}
		if (this.transferQueue.queuedCount > transferBefore) {
			this.transferQueue.flush("batch");
		}
	}

	/**
	 * Work for one target serializes across intents: pending or active
	 * work on either queue means deciders do not re-select the target,
	 * and the queues' cross-direction gates park an admission while the
	 * other direction's work for the guid runs.
	 */
	isQueuedOrActive(guid: string, queue?: "session" | "transfer"): boolean {
		if (queue === "session") return this.sessionQueue.has(guid);
		if (queue === "transfer") return this.transferQueue.has(guid);
		return this.sessionQueue.has(guid) || this.transferQueue.has(guid);
	}

	cancelDocumentWork(guid: string): void {
		this.sessionQueue.cancel(guid);
		this.transferQueue.cancel(guid);
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
			syncsQueued: this.sessionQueue.queuedCount,
			syncsActive: this.sessionQueue.activeCount,
			downloadsQueued: this.transferQueue.queuedCount,
			downloadsActive: this.transferQueue.activeCount,
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

	async refreshLocalFileFailures(sharedFolder: SharedFolder): Promise<void> {
		const liveLocalFailureIds = new Set<string>();
		for (const file of sharedFolder.files.values()) {
			if (!isCanvas(file)) continue;
			const id = failureKey("local", file.guid);
			liveLocalFailureIds.add(id);
			const message = await this.ops.getCanvasLocalStateFailure(file);
			if (message) {
				this.ledger.setFailure({
					id,
					guid: file.guid,
					path: file.path,
					kind: "local",
					message,
					sharedFolder,
					retryable: false,
					recordedAt: this.timeProvider.now(),
				});
			} else {
				this.ledger.clearFailure(id);
			}
		}

		for (const failure of this.ledger.allFailures()) {
			if (
				failure.sharedFolder === sharedFolder &&
				failure.kind === "local" &&
				!liveLocalFailureIds.has(failure.id)
			) {
				this.ledger.clearFailure(failure.id);
			}
		}
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
				this.sessionQueue.has(failure.guid) ||
				this.transferQueue.has(failure.guid)
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
		this.sessionQueue.drain();
		this.transferQueue.drain();
	}
	start = this.resume;

	destroy(): void {
		this.destroyed = true;
		for (const interval of this.intervals) {
			this.timeProvider.clearInterval(interval);
		}
		this.intervals = [];

		this.sessionQueue.destroy("BackgroundSync destroyed");
		this.transferQueue.destroy("BackgroundSync destroyed");

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
		this.sessionQueue.drain();
		this.transferQueue.drain();
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
