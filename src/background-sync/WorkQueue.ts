import { HasLogging, metrics } from "../debug";
import type { TimeProvider } from "../TimeProvider";

export const MAX_WORK_RETRIES = 5;
const RETRY_DELAY_CEILING_MS = 30_000;
export const WORK_DRAIN_BUDGET_MS = 8;

export type WorkSortReason = "enqueue" | "retry" | "batch" | "group";

/** How a settled item resolved. Callers map outcomes; the queue never does. */
export type WorkOutcome = "completed" | "cancelled" | "skipped" | "failed";

/**
 * Accounting tag carried by every item, opaque to the queue. The ledger
 * groups by it; nothing here influences scheduling.
 */
export interface WorkReport {
	group: string;
	kind: string;
	userVisible?: boolean;
	/** Registered totals epoch; settles credit only a matching epoch. */
	epoch?: number;
}

/**
 * One unit of work. The queue reads only this interface: identity, order,
 * gates, and the run itself belong to the item — the queue imports nothing
 * from the domain.
 */
export interface WorkItem {
	/** Identity: one item per key across the queued-plus-active window. */
	readonly key: string;
	/**
	 * Same-key supersession only: a higher-ranked admission replaces a
	 * queued lower-ranked item for the same key. Never compared across
	 * keys.
	 */
	readonly rank?: number;
	/** Total order within the queue; determinism, not priority. */
	readonly path: string;
	readonly report: WorkReport;
	/** May this item start now (its own gates: folder connected, …)? */
	ready(): boolean;
	/**
	 * Is the item's target torn down? Consulted at take time (discard as
	 * skipped without running) and after a successful run (settle
	 * cancelled). Must be free of false positives: a target mid-setup is
	 * not moot, so predicates that cannot distinguish "not yet" from
	 * "gone" belong in `failureIsMoot`, where a failure has already
	 * happened and the only question is how to classify it.
	 */
	moot(): boolean;
	/**
	 * Failure classifier: does the target's state explain a failed run as
	 * mootness (settle skipped) rather than error? Consulted only after
	 * the run threw. Defaults to `moot()`.
	 */
	failureIsMoot?(): boolean;
	/** The transfer. Retryability is signalled by thrown error class. */
	run(): Promise<unknown>;
	// Retry bookkeeping, owned by the queue but stored on the item so a
	// requeued item carries its history.
	retryAttempts?: number;
	nextAttemptAt?: number;
	retryReason?: string;
	/** Set by the queue for observers; items never write it. */
	status?: "pending" | "running" | "completed" | "failed";
	enqueuedAt?: number;
}

export interface WorkSettle {
	outcome: WorkOutcome;
	/** The run's return value, delivered on completed settles. */
	result?: unknown;
}

export interface WorkQueueListener {
	onAdmitted(item: WorkItem, preCounted: boolean): void;
	onStarted(item: WorkItem): void;
	onSettled(item: WorkItem, outcome: WorkOutcome, error?: unknown): void;
	onRequeued(item: WorkItem, delayMs: number): void;
	onCancelledQueued(item: WorkItem): void;
	onQueueChanged(): void;
}

export interface WorkQueueConfig {
	/** Metrics dimension only. */
	label: string;
	concurrency: number;
	/**
	 * Slots for the immediate lane (`runNow`), independent of the
	 * background drain's concurrency. Defaults to `concurrency`.
	 */
	immediateConcurrency?: number;
	timeProvider: TimeProvider;
	isPaused(): boolean;
	/** Path comparison for the total order. */
	comparePaths(a: string, b: string): number;
	isRetryable(error: unknown): boolean;
	retryReasonOf(error: unknown): string;
	listener: WorkQueueListener;
}

/**
 * The background work queue: admission and per-key deduplication with one
 * shared settle promise, same-key rank supersession, path-ordered
 * draining, bounded concurrency, exponential backoff for retryable
 * failures, and cancellation that resolves. One settle path classifies
 * every outcome. The queue knows nothing about what items do.
 */
export class WorkQueue extends HasLogging {
	private queue: WorkItem[] = [];
	private activeItems = new Set<WorkItem>();
	private immediateItems = new Set<WorkItem>();
	private completions = new Map<
		string,
		{
			resolve: (settle: WorkSettle) => void;
			reject: (error: Error) => void;
			promise: Promise<WorkSettle>;
		}
	>();
	private cancelledKeys = new Set<string>();
	private draining = false;
	private destroyed = false;

	constructor(private config: WorkQueueConfig) {
		super();
	}

	get pending(): readonly WorkItem[] {
		return this.queue;
	}

	get active(): ReadonlySet<WorkItem> {
		return this.activeItems;
	}

	get queuedCount(): number {
		return this.queue.length;
	}

	get activeCount(): number {
		return this.activeItems.size + this.immediateItems.size;
	}

	/** True while the key is queued or active (the deduplication window). */
	has(key: string): boolean {
		return this.completions.has(key);
	}

	isActive(key: string): boolean {
		for (const item of this.activeItems) {
			if (item.key === key) return true;
		}
		for (const item of this.immediateItems) {
			if (item.key === key) return true;
		}
		return false;
	}

	isCancelled(key: string): boolean {
		return this.cancelledKeys.has(key);
	}

	findQueued(key: string): WorkItem | undefined {
		return this.queue.find((item) => item.key === key);
	}

	sharedPromise(key: string): Promise<WorkSettle> | undefined {
		return this.completions.get(key)?.promise;
	}

	/**
	 * Admit an item. A same-key admission shares the existing settle
	 * promise; a higher-ranked admission replaces a queued lower-ranked
	 * item in place (the shared promise carries over).
	 */
	admit(
		item: WorkItem,
		opts: { deferFlush?: boolean; preCounted?: boolean } = {},
	): Promise<WorkSettle> {
		const existing = this.completions.get(item.key);
		if (existing) {
			const queued = this.findQueued(item.key);
			if (
				queued &&
				(item.rank ?? 0) > (queued.rank ?? 0)
			) {
				// Supersession: the stronger intent replaces the queued item;
				// callers sharing the promise observe the superseding work.
				const index = this.queue.indexOf(queued);
				item.enqueuedAt = queued.enqueuedAt;
				item.status = "pending";
				this.queue[index] = item;
				this.config.listener.onQueueChanged();
			}
			this.debug(
				`[${this.config.label}] ${item.key} already admitted, sharing settle`,
			);
			return existing.promise;
		}

		const completion = this.createCompletion(item.key);
		item.status = "pending";
		item.enqueuedAt = this.config.timeProvider.now();
		this.queue.push(item);
		this.config.listener.onAdmitted(item, opts.preCounted ?? false);
		if (!opts.deferFlush) {
			this.flush("enqueue");
		}
		return completion.promise;
	}

	/**
	 * Admit directly into the backoff path, as if the item had just failed
	 * retryably. Returns null when the retry budget is already exhausted.
	 */
	admitForRetry(item: WorkItem, error: Error): Promise<WorkSettle> | null {
		const existing = this.completions.get(item.key);
		if (existing) return existing.promise;

		const completion = this.createCompletion(item.key);
		this.config.listener.onAdmitted(item, false);
		if (!this.requeueRetryable(item, error)) {
			this.completions.delete(item.key);
			this.config.listener.onSettled(item, "failed", error);
			return null;
		}
		return completion.promise;
	}

	/**
	 * The immediate lane: run the item now on its own bounded slots,
	 * sharing the one identity table with the background queue. Work that
	 * cannot start — paused, not ready, or no immediate slot free — parks
	 * into the background queue instead of failing; a transient failure
	 * parks through the ordinary backoff path. A same-key admission shares
	 * the existing settle, promoting a queued item onto an immediate slot
	 * so demanded work never waits behind the sweep it was queued with.
	 */
	runNow(item: WorkItem): Promise<WorkSettle> {
		const existing = this.completions.get(item.key);
		if (existing) {
			this.promoteQueued(item.key);
			return existing.promise;
		}
		if (item.moot()) {
			return Promise.resolve({ outcome: "skipped" });
		}
		if (!this.hasImmediateSlot() || !item.ready()) {
			return this.admit(item);
		}
		const completion = this.createCompletion(item.key);
		item.status = "pending";
		item.enqueuedAt = this.config.timeProvider.now();
		this.config.listener.onAdmitted(item, false);
		this.startItem(item, this.immediateItems);
		return completion.promise;
	}

	private hasImmediateSlot(): boolean {
		return (
			!this.destroyed &&
			!this.config.isPaused() &&
			this.immediateItems.size <
				(this.config.immediateConcurrency ?? this.config.concurrency)
		);
	}

	/**
	 * Move a queued item onto an immediate slot. Backoff pacing does not
	 * hold a promoted item: a consumer demanding the work now is new
	 * evidence that outranks the retry schedule.
	 */
	private promoteQueued(key: string): void {
		if (!this.hasImmediateSlot()) return;
		const index = this.queue.findIndex((queued) => queued.key === key);
		if (index < 0) return;
		const item = this.queue[index];
		if (!item.ready() || item.moot()) return;
		this.removeAt(index);
		metrics.setBgSyncQueueLength(this.config.label, this.queue.length);
		this.config.listener.onQueueChanged();
		this.startItem(item, this.immediateItems);
	}

	flush(reason: WorkSortReason): void {
		this.sortQueue(reason);
		metrics.setBgSyncQueueLength(this.config.label, this.queue.length);
		this.config.listener.onQueueChanged();
		this.drain();
	}

	/**
	 * Remove the key's queued item, flag active work as cancelled, and
	 * settle the shared promise with the cancelled outcome (resolution,
	 * never rejection). Returns whether a queued item was removed.
	 */
	cancel(key: string): boolean {
		let removed = false;
		for (let index = this.queue.length - 1; index >= 0; index--) {
			if (this.queue[index].key !== key) continue;
			const [item] = this.queue.splice(index, 1);
			this.config.listener.onCancelledQueued(item);
			removed = true;
		}

		if (this.isActive(key)) {
			this.cancelledKeys.add(key);
		} else {
			this.resolveCancellation(key);
		}

		if (removed) {
			metrics.setBgSyncQueueLength(this.config.label, this.queue.length);
			this.config.listener.onQueueChanged();
		}
		return removed;
	}

	drain(): void {
		if (this.destroyed || this.draining || this.config.isPaused()) return;
		const drainStart = performance.now();
		let itemsStarted = 0;
		this.draining = true;
		try {
			const now = this.config.timeProvider.now();
			while (this.activeItems.size < this.config.concurrency) {
				const item = this.takeNext(now);
				if (!item) break;
				itemsStarted++;
				this.startItem(item);
			}
		} finally {
			this.draining = false;
			metrics.setBgSyncQueueLength(this.config.label, this.queue.length);
			metrics.observeBgSyncDrain(
				this.config.label,
				(performance.now() - drainStart) / 1000,
				itemsStarted,
				WORK_DRAIN_BUDGET_MS,
			);
		}
	}

	destroy(rejectionMessage: string): void {
		this.destroyed = true;
		for (const [key, completion] of this.completions) {
			completion.reject(new Error(rejectionMessage));
			this.completions.delete(key);
		}
		this.queue = [];
		this.activeItems.clear();
		this.immediateItems.clear();
		this.cancelledKeys.clear();
	}

	private createCompletion(key: string) {
		let resolve!: (settle: WorkSettle) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<WorkSettle>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const completion = { resolve, reject, promise };
		this.completions.set(key, completion);
		return completion;
	}

	private resolveCancellation(key: string): void {
		const completion = this.completions.get(key);
		if (completion) completion.resolve({ outcome: "cancelled" });
		this.completions.delete(key);
		this.cancelledKeys.delete(key);
	}

	/**
	 * Queue items are stored in reverse path order so the next item sits
	 * at the array tail; draining pops without shifting the rest.
	 */
	private sortQueue(reason: WorkSortReason): void {
		if (this.queue.length < 2) return;
		const sortStart = performance.now();
		this.queue.sort((a, b) => this.config.comparePaths(b.path, a.path));
		metrics.observeBgSyncSort(
			this.config.label,
			reason,
			this.queue.length,
			(performance.now() - sortStart) / 1000,
		);
	}

	private takeNext(now: number): WorkItem | undefined {
		for (let index = this.queue.length - 1; index >= 0; index--) {
			const item = this.queue[index];
			if (item.moot()) {
				this.removeAt(index);
				this.discardMoot(item);
				continue;
			}
			if (
				item.ready() &&
				(item.nextAttemptAt === undefined || item.nextAttemptAt <= now)
			) {
				return this.removeAt(index);
			}
		}
		return undefined;
	}

	private removeAt(index: number): WorkItem {
		if (index === this.queue.length - 1) {
			return this.queue.pop()!;
		}
		return this.queue.splice(index, 1)[0];
	}

	/**
	 * A moot item leaving the queue at take time settles skipped — a
	 * resolution, because mootness is not failure. Callers that treat a
	 * vanished target as an error map the outcome themselves.
	 */
	private discardMoot(item: WorkItem): void {
		const completion = this.completions.get(item.key);
		if (completion) {
			completion.resolve({ outcome: "skipped" });
		}
		this.completions.delete(item.key);
		this.cancelledKeys.delete(item.key);
		this.config.listener.onSettled(item, "skipped");
	}

	private observeItemStart(item: WorkItem, now: number): void {
		metrics.observeBgSyncItemAge(
			this.config.label,
			item.report.kind,
			Math.max(0, now - (item.enqueuedAt ?? now)) / 1000,
		);
		if (item.nextAttemptAt !== undefined && item.retryReason) {
			metrics.observeBgSyncRetryLateness(
				this.config.label,
				item.retryReason,
				Math.max(0, now - item.nextAttemptAt) / 1000,
			);
		}
	}

	private startItem(item: WorkItem, lane: Set<WorkItem> = this.activeItems): void {
		this.observeItemStart(item, this.config.timeProvider.now());
		item.nextAttemptAt = undefined;
		item.retryReason = undefined;
		item.status = "running";
		lane.add(item);
		metrics.setBgSyncActive(this.config.label, this.activeCount);
		metrics.setBgSyncQueueLength(this.config.label, this.queue.length);
		this.config.listener.onStarted(item);
		void this.runItem(item);
	}

	/**
	 * The single settle path. Every outcome of a started item — success,
	 * clean cancellation, moot failure, retryable failure, terminal
	 * failure — is classified here and nowhere else.
	 */
	private async runItem(item: WorkItem): Promise<void> {
		const opStart = performance.now();
		try {
			const result = await item.run();
			item.status = "completed";
			metrics.incBgSyncOps(this.config.label, "completed");
			const completion = this.completions.get(item.key);
			if (completion) {
				completion.resolve(
					this.cancelledKeys.has(item.key) || item.moot()
						? { outcome: "cancelled" }
						: { outcome: "completed", result },
				);
				this.completions.delete(item.key);
			}
			this.config.listener.onSettled(item, "completed");
		} catch (error) {
			const failureMoot = item.failureIsMoot
				? item.failureIsMoot()
				: item.moot();
			if (this.cancelledKeys.has(item.key) || failureMoot) {
				item.status = "completed";
				this.resolveCancellation(item.key);
				this.config.listener.onSettled(item, "skipped");
			} else if (
				this.config.isRetryable(error) &&
				this.requeueRetryable(item, error as Error)
			) {
				// Shared promise stays pending; the item is back in the queue.
			} else {
				item.status = "failed";
				metrics.incBgSyncOps(this.config.label, "failed");
				const completion = this.completions.get(item.key);
				if (completion) {
					completion.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
					this.completions.delete(item.key);
				}
				this.config.listener.onSettled(item, "failed", error);
			}
		} finally {
			metrics.observeBgSyncOp(
				this.config.label,
				(performance.now() - opStart) / 1000,
			);
			this.activeItems.delete(item);
			this.immediateItems.delete(item);
			metrics.setBgSyncActive(this.config.label, this.activeCount);
			if (item.status !== "pending") {
				this.completions.delete(item.key);
				this.cancelledKeys.delete(item.key);
			}
			queueMicrotask(() => {
				if (this.destroyed) return;
				this.drain();
			});
		}
	}

	private requeueRetryable(item: WorkItem, error: Error): boolean {
		const retries = (item.retryAttempts ?? 0) + 1;
		item.retryAttempts = retries;
		if (retries > MAX_WORK_RETRIES) {
			item.nextAttemptAt = undefined;
			item.retryReason = undefined;
			this.warn(
				`[${this.config.label}] retryable work failed after ${MAX_WORK_RETRIES} retries for ${item.path}: ${error.message}`,
			);
			return false;
		}

		const delayMs = Math.min(
			RETRY_DELAY_CEILING_MS,
			1000 * 2 ** Math.min(retries - 1, 5),
		);
		const reason = this.config.retryReasonOf(error);
		item.status = "pending";
		item.nextAttemptAt = this.config.timeProvider.now() + delayMs;
		item.retryReason = reason;
		metrics.recordBgSyncRetry(this.config.label, reason, retries, delayMs / 1000);

		if (!this.queue.some((queued) => queued.key === item.key)) {
			this.queue.push(item);
			this.sortQueue("retry");
		}
		this.debug(
			`[${this.config.label}] retryable failure for ${item.path}: ${error.message}; retrying in ${delayMs}ms`,
		);
		metrics.setBgSyncQueueLength(this.config.label, this.queue.length);
		this.config.listener.onRequeued(item, delayMs);
		this.config.listener.onQueueChanged();
		return true;
	}
}
