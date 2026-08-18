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
	/**
	 * The direction lane the item belongs to ("sync" | "download" today).
	 * Sharing and supersession act within a channel; the identity table
	 * spans channels — one target never runs work in two channels at once.
	 */
	readonly channel: string;
	/** Identity: one item per key per channel over queued-plus-active. */
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

export interface WorkChannelBudget {
	concurrency: number;
	/**
	 * Slots for the immediate lane (`runNow`), independent of the
	 * background drain's concurrency. Defaults to `concurrency`.
	 */
	immediateConcurrency?: number;
}

export interface WorkQueueConfig {
	/** Per-channel slot budgets; channel names are the metric labels. */
	channels: Record<string, WorkChannelBudget>;
	timeProvider: TimeProvider;
	isPaused(): boolean;
	/** Path comparison for the total order. */
	comparePaths(a: string, b: string): number;
	isRetryable(error: unknown): boolean;
	retryReasonOf(error: unknown): string;
	listener: WorkQueueListener;
}

/**
 * The background work queue: admission and per-channel deduplication with
 * one shared settle promise, same-key rank supersession, path-ordered
 * draining, per-channel bounded concurrency, exponential backoff for
 * retryable failures, and cancellation that resolves. One settle path
 * classifies every outcome. One identity table spans channels and lanes:
 * while a key's work runs in any channel, other channels' items for that
 * key park in the queue and drain when the running work settles. The
 * queue knows nothing about what items do.
 */
export class WorkQueue extends HasLogging {
	private queue: WorkItem[] = [];
	private activeItems = new Set<WorkItem>();
	private immediateItems = new Set<WorkItem>();
	/** Background-lane running counts per channel. */
	private activeByChannel = new Map<string, number>();
	/** Immediate-lane running counts per channel. */
	private immediateByChannel = new Map<string, number>();
	/** Queued counts per channel (metrics without scans). */
	private queuedByChannel = new Map<string, number>();
	/** Keys with running work in any channel or lane: the identity gate. */
	private activeKeys = new Map<string, number>();
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

	private ckey(channel: string, key: string): string {
		return `${channel}:${key}`;
	}

	private budget(channel: string): WorkChannelBudget {
		const budget = this.config.channels[channel];
		if (!budget) {
			throw new Error(`unknown work channel: ${channel}`);
		}
		return budget;
	}

	private bumpChannel(map: Map<string, number>, channel: string, by: number) {
		map.set(channel, Math.max(0, (map.get(channel) ?? 0) + by));
	}

	get pending(): readonly WorkItem[] {
		return this.queue;
	}

	pendingIn(channel: string): WorkItem[] {
		return this.queue.filter((item) => item.channel === channel);
	}

	get queuedCount(): number {
		return this.queue.length;
	}

	queuedCountIn(channel: string): number {
		return this.queuedByChannel.get(channel) ?? 0;
	}

	get activeCount(): number {
		return this.activeItems.size + this.immediateItems.size;
	}

	activeCountIn(channel: string): number {
		return (
			(this.activeByChannel.get(channel) ?? 0) +
			(this.immediateByChannel.get(channel) ?? 0)
		);
	}

	/** True while the key is queued or active in the channel. */
	has(channel: string, key: string): boolean {
		return this.completions.has(this.ckey(channel, key));
	}

	isCancelled(channel: string, key: string): boolean {
		return this.cancelledKeys.has(this.ckey(channel, key));
	}

	findQueued(channel: string, key: string): WorkItem | undefined {
		return this.queue.find(
			(item) => item.channel === channel && item.key === key,
		);
	}

	/**
	 * Admit an item. A same-channel same-key admission shares the existing
	 * settle promise; a higher-ranked admission replaces a queued
	 * lower-ranked item in place (the shared promise carries over).
	 */
	admit(
		item: WorkItem,
		opts: { deferFlush?: boolean; preCounted?: boolean } = {},
	): Promise<WorkSettle> {
		const ckey = this.ckey(item.channel, item.key);
		const existing = this.completions.get(ckey);
		if (existing) {
			const queued = this.findQueued(item.channel, item.key);
			if (queued && (item.rank ?? 0) > (queued.rank ?? 0)) {
				// Supersession: the stronger intent replaces the queued item;
				// callers sharing the promise observe the superseding work.
				const index = this.queue.indexOf(queued);
				item.enqueuedAt = queued.enqueuedAt;
				item.status = "pending";
				this.queue[index] = item;
				this.config.listener.onQueueChanged();
			}
			this.debug(
				`[${item.channel}] ${item.key} already admitted, sharing settle`,
			);
			return existing.promise;
		}

		const completion = this.createCompletion(ckey);
		item.status = "pending";
		item.enqueuedAt = this.config.timeProvider.now();
		this.queue.push(item);
		this.bumpChannel(this.queuedByChannel, item.channel, 1);
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
		const ckey = this.ckey(item.channel, item.key);
		const existing = this.completions.get(ckey);
		if (existing) return existing.promise;

		const completion = this.createCompletion(ckey);
		this.config.listener.onAdmitted(item, false);
		if (!this.requeueRetryable(item, error)) {
			this.completions.delete(ckey);
			this.config.listener.onSettled(item, "failed", error);
			return null;
		}
		return completion.promise;
	}

	/**
	 * The immediate lane: run the item now on its channel's bounded
	 * immediate slots, sharing the one identity table with the background
	 * queue. Work that cannot start — paused, not ready, no slot, or the
	 * key running in another channel — parks into the background queue
	 * instead of failing; a transient failure parks through the ordinary
	 * backoff path. A same-channel same-key admission shares the existing
	 * settle, promoting a queued item onto an immediate slot so demanded
	 * work never waits behind the sweep it was queued with.
	 */
	runNow(item: WorkItem): Promise<WorkSettle> {
		const ckey = this.ckey(item.channel, item.key);
		const existing = this.completions.get(ckey);
		if (existing) {
			this.promoteQueued(item.channel, item.key);
			return existing.promise;
		}
		if (item.moot()) {
			return Promise.resolve({ outcome: "skipped" });
		}
		if (!this.hasImmediateSlot(item.channel) || !item.ready() || this.activeKeys.has(item.key)) {
			return this.admit(item);
		}
		const completion = this.createCompletion(ckey);
		item.status = "pending";
		item.enqueuedAt = this.config.timeProvider.now();
		this.config.listener.onAdmitted(item, false);
		this.startItem(item, this.immediateItems);
		return completion.promise;
	}

	private hasImmediateSlot(channel: string): boolean {
		const budget = this.budget(channel);
		return (
			!this.destroyed &&
			!this.config.isPaused() &&
			(this.immediateByChannel.get(channel) ?? 0) <
				(budget.immediateConcurrency ?? budget.concurrency)
		);
	}

	/**
	 * Move a queued item onto an immediate slot. Backoff pacing does not
	 * hold a promoted item: a consumer demanding the work now is new
	 * evidence that outranks the retry schedule.
	 */
	private promoteQueued(channel: string, key: string): void {
		if (!this.hasImmediateSlot(channel) || this.activeKeys.has(key)) return;
		const index = this.queue.findIndex(
			(queued) => queued.channel === channel && queued.key === key,
		);
		if (index < 0) return;
		const item = this.queue[index];
		if (!item.ready() || item.moot()) return;
		this.removeAt(index);
		this.bumpChannel(this.queuedByChannel, channel, -1);
		this.publishQueueLengths();
		this.config.listener.onQueueChanged();
		this.startItem(item, this.immediateItems);
	}

	flush(reason: WorkSortReason): void {
		this.sortQueue(reason);
		this.publishQueueLengths();
		this.config.listener.onQueueChanged();
		this.drain();
	}

	/**
	 * Remove the key's queued items in every channel, flag active work as
	 * cancelled, and settle the shared promises with the cancelled outcome
	 * (resolution, never rejection). Returns whether a queued item was
	 * removed.
	 */
	cancel(key: string): boolean {
		let removed = false;
		for (let index = this.queue.length - 1; index >= 0; index--) {
			if (this.queue[index].key !== key) continue;
			const [item] = this.queue.splice(index, 1);
			this.bumpChannel(this.queuedByChannel, item.channel, -1);
			this.config.listener.onCancelledQueued(item);
			removed = true;
		}

		for (const channel of Object.keys(this.config.channels)) {
			const ckey = this.ckey(channel, key);
			if (!this.completions.has(ckey)) continue;
			if (this.isRunning(channel, key)) {
				this.cancelledKeys.add(ckey);
			} else {
				this.resolveCancellation(ckey);
			}
		}

		if (removed) {
			this.publishQueueLengths();
			this.config.listener.onQueueChanged();
		}
		return removed;
	}

	private isRunning(channel: string, key: string): boolean {
		for (const item of this.activeItems) {
			if (item.channel === channel && item.key === key) return true;
		}
		for (const item of this.immediateItems) {
			if (item.channel === channel && item.key === key) return true;
		}
		return false;
	}

	drain(): void {
		if (this.destroyed || this.draining || this.config.isPaused()) return;
		const drainStart = performance.now();
		const startedByChannel = new Map<string, number>();
		this.draining = true;
		try {
			const now = this.config.timeProvider.now();
			while (this.hasFreeBackgroundSlot()) {
				const item = this.takeNext(now);
				if (!item) break;
				startedByChannel.set(
					item.channel,
					(startedByChannel.get(item.channel) ?? 0) + 1,
				);
				this.startItem(item);
			}
		} finally {
			this.draining = false;
			this.publishQueueLengths();
			// One structure drains every channel; the observation stays a
			// per-channel dimension.
			const seconds = (performance.now() - drainStart) / 1000;
			for (const channel of Object.keys(this.config.channels)) {
				metrics.observeBgSyncDrain(
					channel,
					seconds,
					startedByChannel.get(channel) ?? 0,
					WORK_DRAIN_BUDGET_MS,
				);
			}
		}
	}

	private hasFreeBackgroundSlot(): boolean {
		for (const [channel, budget] of Object.entries(this.config.channels)) {
			if ((this.activeByChannel.get(channel) ?? 0) < budget.concurrency) {
				return true;
			}
		}
		return false;
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
		this.activeByChannel.clear();
		this.immediateByChannel.clear();
		this.queuedByChannel.clear();
		this.activeKeys.clear();
		this.cancelledKeys.clear();
	}

	private createCompletion(ckey: string) {
		let resolve!: (settle: WorkSettle) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<WorkSettle>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const completion = { resolve, reject, promise };
		this.completions.set(ckey, completion);
		return completion;
	}

	private resolveCancellation(ckey: string): void {
		const completion = this.completions.get(ckey);
		if (completion) completion.resolve({ outcome: "cancelled" });
		this.completions.delete(ckey);
		this.cancelledKeys.delete(ckey);
	}

	/**
	 * Queue items are stored in reverse path order so the next item sits
	 * at the array tail; draining pops without shifting the rest.
	 */
	private sortQueue(reason: WorkSortReason): void {
		if (this.queue.length < 2) return;
		const sortStart = performance.now();
		this.queue.sort((a, b) => this.config.comparePaths(b.path, a.path));
		const seconds = (performance.now() - sortStart) / 1000;
		for (const channel of Object.keys(this.config.channels)) {
			const size = this.queuedCountIn(channel);
			if (size > 0) {
				metrics.observeBgSyncSort(channel, reason, size, seconds);
			}
		}
	}

	private takeNext(now: number): WorkItem | undefined {
		for (let index = this.queue.length - 1; index >= 0; index--) {
			const item = this.queue[index];
			if (item.moot()) {
				this.removeAt(index);
				this.bumpChannel(this.queuedByChannel, item.channel, -1);
				this.discardMoot(item);
				continue;
			}
			// The identity gate: the key's work runs elsewhere — park.
			if (this.activeKeys.has(item.key)) continue;
			const budget = this.budget(item.channel);
			if ((this.activeByChannel.get(item.channel) ?? 0) >= budget.concurrency) {
				continue;
			}
			if (
				item.ready() &&
				(item.nextAttemptAt === undefined || item.nextAttemptAt <= now)
			) {
				this.bumpChannel(this.queuedByChannel, item.channel, -1);
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
		const ckey = this.ckey(item.channel, item.key);
		const completion = this.completions.get(ckey);
		if (completion) {
			completion.resolve({ outcome: "skipped" });
		}
		this.completions.delete(ckey);
		this.cancelledKeys.delete(ckey);
		this.config.listener.onSettled(item, "skipped");
	}

	private observeItemStart(item: WorkItem, now: number): void {
		metrics.observeBgSyncItemAge(
			item.channel,
			item.report.kind,
			Math.max(0, now - (item.enqueuedAt ?? now)) / 1000,
		);
		if (item.nextAttemptAt !== undefined && item.retryReason) {
			metrics.observeBgSyncRetryLateness(
				item.channel,
				item.retryReason,
				Math.max(0, now - item.nextAttemptAt) / 1000,
			);
		}
	}

	private startItem(
		item: WorkItem,
		lane: Set<WorkItem> = this.activeItems,
	): void {
		this.observeItemStart(item, this.config.timeProvider.now());
		item.nextAttemptAt = undefined;
		item.retryReason = undefined;
		item.status = "running";
		lane.add(item);
		this.bumpChannel(
			lane === this.immediateItems
				? this.immediateByChannel
				: this.activeByChannel,
			item.channel,
			1,
		);
		this.activeKeys.set(item.key, (this.activeKeys.get(item.key) ?? 0) + 1);
		metrics.setBgSyncActive(item.channel, this.activeCountIn(item.channel));
		this.publishQueueLengths();
		this.config.listener.onStarted(item);
		void this.runItem(item);
	}

	private publishQueueLengths(): void {
		for (const channel of Object.keys(this.config.channels)) {
			metrics.setBgSyncQueueLength(channel, this.queuedCountIn(channel));
		}
	}

	/**
	 * The single settle path. Every outcome of a started item — success,
	 * clean cancellation, moot failure, retryable failure, terminal
	 * failure — is classified here and nowhere else.
	 */
	private async runItem(item: WorkItem): Promise<void> {
		const ckey = this.ckey(item.channel, item.key);
		const opStart = performance.now();
		try {
			const result = await item.run();
			item.status = "completed";
			metrics.incBgSyncOps(item.channel, "completed");
			const completion = this.completions.get(ckey);
			if (completion) {
				completion.resolve(
					this.cancelledKeys.has(ckey) || item.moot()
						? { outcome: "cancelled" }
						: { outcome: "completed", result },
				);
				this.completions.delete(ckey);
			}
			this.config.listener.onSettled(item, "completed");
		} catch (error) {
			const failureMoot = item.failureIsMoot
				? item.failureIsMoot()
				: item.moot();
			if (this.cancelledKeys.has(ckey) || failureMoot) {
				item.status = "completed";
				this.resolveCancellation(ckey);
				this.config.listener.onSettled(item, "skipped");
			} else if (
				this.config.isRetryable(error) &&
				this.requeueRetryable(item, error as Error)
			) {
				// Shared promise stays pending; the item is back in the queue.
			} else {
				item.status = "failed";
				metrics.incBgSyncOps(item.channel, "failed");
				const completion = this.completions.get(ckey);
				if (completion) {
					completion.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
					this.completions.delete(ckey);
				}
				this.config.listener.onSettled(item, "failed", error);
			}
		} finally {
			metrics.observeBgSyncOp(
				item.channel,
				(performance.now() - opStart) / 1000,
			);
			if (this.activeItems.delete(item)) {
				this.bumpChannel(this.activeByChannel, item.channel, -1);
			}
			if (this.immediateItems.delete(item)) {
				this.bumpChannel(this.immediateByChannel, item.channel, -1);
			}
			const keyCount = this.activeKeys.get(item.key) ?? 0;
			if (keyCount <= 1) {
				this.activeKeys.delete(item.key);
			} else {
				this.activeKeys.set(item.key, keyCount - 1);
			}
			metrics.setBgSyncActive(item.channel, this.activeCountIn(item.channel));
			if (item.status !== "pending") {
				this.completions.delete(ckey);
				this.cancelledKeys.delete(ckey);
			}
			queueMicrotask(() => {
				if (this.destroyed) return;
				// The settle may have unparked the key's cross-channel work.
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
				`[${item.channel}] retryable work failed after ${MAX_WORK_RETRIES} retries for ${item.path}: ${error.message}`,
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
		metrics.recordBgSyncRetry(item.channel, reason, retries, delayMs / 1000);

		if (
			!this.queue.some(
				(queued) =>
					queued.channel === item.channel && queued.key === item.key,
			)
		) {
			this.queue.push(item);
			this.bumpChannel(this.queuedByChannel, item.channel, 1);
			this.sortQueue("retry");
		}
		this.debug(
			`[${item.channel}] retryable failure for ${item.path}: ${error.message}; retrying in ${delayMs}ms`,
		);
		this.publishQueueLengths();
		this.config.listener.onRequeued(item, delayMs);
		this.config.listener.onQueueChanged();
		return true;
	}
}
