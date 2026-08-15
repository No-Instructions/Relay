import { ObservableSet } from "../observable/ObservableSet";
import type { TimeProvider } from "../TimeProvider";
import { compareFilePaths } from "../FolderSort";
import {
	WorkQueue,
	type WorkItem,
	type WorkSettle,
	type WorkSortReason,
} from "./WorkQueue";
import type { QueueItem } from "./types";

export type DirectionTerminal = "completed" | "failed" | "skipped";

/** The per-direction lifecycle stream the ledger projects from. */
export interface DirectionQueueListener {
	onAdmitted(item: QueueItem, preCounted: boolean): void;
	onStarted(item: QueueItem): void;
	onSettled(item: QueueItem, terminal: DirectionTerminal, error?: unknown): void;
	onRequeued(item: QueueItem, delayMs: number): void;
	onCancelledQueued(item: QueueItem): void;
	onQueueChanged(): void;
}

export interface DirectionQueueConfig<R> {
	label: "sync" | "download";
	concurrency: number;
	timeProvider: TimeProvider;
	isPaused(): boolean;
	/** Stable teardown predicate (destroyed doc); consulted before runs. */
	isMoot(item: QueueItem): boolean;
	/**
	 * Cross-direction identity gate: while true the item parks in the
	 * queue instead of starting (e.g. the other direction runs this guid).
	 */
	isBlocked?(item: QueueItem): boolean;
	/**
	 * Failure classifier consulted only after a run threw (e.g. committed
	 * membership vanished mid-transfer). Defaults to `isMoot`.
	 */
	isFailureMoot?(item: QueueItem): boolean;
	run(item: QueueItem): Promise<unknown>;
	/** Map a completed settle's result to the caller-facing value. */
	successValue(item: QueueItem, result: unknown): R;
	/** The resolution cancellation and mootness settle with. */
	cancelledValue(): R;
	isRetryable(error: unknown): boolean;
	retryReasonOf(error: unknown): "provider" | "s3";
	listener: DirectionQueueListener;
}

interface DirectionWorkItem extends WorkItem {
	view: QueueItem;
}

/**
 * A per-direction facade over the generic WorkQueue: it builds WorkItems
 * from the legacy QueueItem views the public API exposes, translates the
 * generic settle outcomes into each direction's caller-facing values, and
 * maintains the direction's observable active set. This is the
 * compatibility layer of the generic-executor migration; the immediate
 * lane and the single-queue merge consume WorkQueue directly and erode
 * this facade.
 */
export class DirectionQueue<R> {
	private work: WorkQueue;
	readonly active = new ObservableSet<QueueItem>();
	// One stable caller-facing promise per key: callers compare and share
	// these, so mapping must not mint a new promise per read.
	private mapped = new Map<string, Promise<R>>();

	constructor(private config: DirectionQueueConfig<R>) {
		this.work = new WorkQueue({
			label: config.label,
			concurrency: config.concurrency,
			timeProvider: config.timeProvider,
			isPaused: () => config.isPaused(),
			comparePaths: (a, b) =>
				compareFilePaths({ path: a }, { path: b }),
			isRetryable: (error) => config.isRetryable(error),
			retryReasonOf: (error) => config.retryReasonOf(error),
			listener: {
				onAdmitted: (item, preCounted) =>
					config.listener.onAdmitted(this.viewOf(item), preCounted),
				onStarted: (item) => {
					const view = this.viewOf(item);
					view.status = "running";
					this.active.add(view);
					config.listener.onStarted(view);
				},
				onSettled: (item, outcome, error) => {
					const view = this.viewOf(item);
					view.status = outcome === "failed" ? "failed" : "completed";
					this.active.delete(view);
					config.listener.onSettled(
						view,
						outcome === "cancelled" ? "skipped" : outcome,
						error,
					);
				},
				onRequeued: (item, delayMs) => {
					const view = this.viewOf(item);
					view.status = "pending";
					view.retryAttempts = item.retryAttempts;
					view.nextAttemptAt = item.nextAttemptAt;
					view.retryReason = item.retryReason as QueueItem["retryReason"];
					this.active.delete(view);
					config.listener.onRequeued(view, delayMs);
				},
				onCancelledQueued: (item) =>
					config.listener.onCancelledQueued(this.viewOf(item)),
				onQueueChanged: () => config.listener.onQueueChanged(),
			},
		});
	}

	private viewOf(item: WorkItem): QueueItem {
		return (item as DirectionWorkItem).view;
	}

	private makeItem(view: QueueItem): DirectionWorkItem {
		const config = this.config;
		return {
			key: view.guid,
			rank: view.syncIntent === "upload" ? 1 : 0,
			path: view.path,
			report: {
				group: view.sharedFolder.guid,
				// Dynamic: an in-place upload upgrade changes the view's
				// intent after admission, and start-time metrics read it.
				get kind() {
					return config.label === "download"
						? "download"
						: (view.syncIntent ?? "sync");
				},
				userVisible: view.userVisible,
			},
			ready: () =>
				view.sharedFolder.connected &&
				view.sharedFolder.intent !== "disconnected" &&
				!(config.isBlocked?.(view) ?? false),
			moot: () => config.isMoot(view),
			failureIsMoot: config.isFailureMoot
				? () => config.isFailureMoot!(view)
				: undefined,
			run: () => config.run(view),
			view,
		};
	}

	/**
	 * Map a generic settle to the direction's caller-facing value. A
	 * skipped settle for a destroyed target keeps the legacy rejection so
	 * pipelines that treat teardown as an error still observe one.
	 */
	private mapSettle(view: QueueItem) {
		return (settle: WorkSettle): R => {
			if (settle.outcome === "completed") {
				return this.config.successValue(view, settle.result);
			}
			if (settle.outcome === "skipped" && view.doc.destroyed) {
				throw new Error("Document destroyed");
			}
			return this.config.cancelledValue();
		};
	}

	get pending(): readonly QueueItem[] {
		return this.work.pending.map((item) => this.viewOf(item));
	}

	get queuedCount(): number {
		return this.work.queuedCount;
	}

	get activeCount(): number {
		return this.work.activeCount;
	}

	has(guid: string): boolean {
		return this.work.has(guid);
	}

	isCancelledGuid(guid: string): boolean {
		return this.work.isCancelled(guid);
	}

	/** True while the guid's work is running (either lane). */
	isActiveGuid(guid: string): boolean {
		return this.work.isActive(guid);
	}

	findQueued(guid: string): QueueItem | undefined {
		const item = this.work.findQueued(guid);
		return item ? this.viewOf(item) : undefined;
	}

	/** The guid's view whether queued or in flight. */
	findView(guid: string): QueueItem | undefined {
		const queued = this.findQueued(guid);
		if (queued) return queued;
		let active: QueueItem | undefined;
		this.active.forEach((view) => {
			if (!active && view.guid === guid) active = view;
		});
		return active;
	}

	sharedPromise(guid: string): Promise<R> | undefined {
		return this.mapped.get(guid);
	}

	private mapAndCache(
		view: QueueItem,
		promise: Promise<WorkSettle>,
	): Promise<R> {
		const existing = this.mapped.get(view.guid);
		if (existing) return existing;
		const mapped = promise.then(this.mapSettle(view));
		this.mapped.set(view.guid, mapped);
		const cleanup = () => {
			if (this.mapped.get(view.guid) === mapped) {
				this.mapped.delete(view.guid);
			}
		};
		mapped.then(cleanup, cleanup);
		return mapped;
	}

	admit(
		view: QueueItem,
		opts: { deferFlush?: boolean; preCounted?: boolean } = {},
	): Promise<R> {
		const existing = this.mapped.get(view.guid);
		if (existing && this.work.has(view.guid)) {
			// Preserve supersession/sharing semantics on the underlying
			// queue, then hand back the stable caller-facing promise.
			void this.work.admit(this.makeItem(view), opts);
			return existing;
		}
		return this.mapAndCache(view, this.work.admit(this.makeItem(view), opts));
	}

	admitForRetry(view: QueueItem, error: Error): Promise<R> | null {
		const existing = this.mapped.get(view.guid);
		if (existing && this.work.has(view.guid)) return existing;
		const promise = this.work.admitForRetry(this.makeItem(view), error);
		if (!promise) return null;
		return this.mapAndCache(view, promise);
	}

	/**
	 * The immediate lane: run now on dedicated slots, park into the
	 * background queue when the item cannot start. Shares the direction's
	 * identity table and stable settle promises with `admit`.
	 */
	runNow(view: QueueItem): Promise<R> {
		const existing = this.mapped.get(view.guid);
		if (existing && this.work.has(view.guid)) {
			// Promote a queued same-key item onto an immediate slot.
			void this.work.runNow(this.makeItem(view));
			return existing;
		}
		return this.mapAndCache(view, this.work.runNow(this.makeItem(view)));
	}

	flush(reason: WorkSortReason): void {
		this.work.flush(reason);
	}

	cancel(guid: string): boolean {
		return this.work.cancel(guid);
	}

	drain(): void {
		this.work.drain();
	}

	destroy(rejectionMessage: string): void {
		this.work.destroy(rejectionMessage);
		this.mapped.clear();
		this.active.destroy();
	}
}
