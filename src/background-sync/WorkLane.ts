import { ObservableSet } from "../observable/ObservableSet";
import { compareFilePaths } from "../FolderSort";
import { metrics } from "../debug";
import type {
	QueueItem,
	RetryReason,
	WorkCompletion,
	WorkIntent,
	WorkRequest,
	WorkScope,
} from "./WorkRequest";

/** A lane's metric label; dashboards keep the historical operation names. */
export type LaneOperation = "sync" | "download";
export type LaneSortReason = "enqueue" | "retry" | "batch" | "group";

export function laneOperation(scope: WorkScope): LaneOperation {
	return scope === "transfer" ? "download" : "sync";
}

/**
 * A claim is one guid's unit of work in a lane: the queued-or-running item
 * plus the completion every caller who asked for that work shares. The claim
 * lives from admission until the work settles, across retries.
 */
interface LaneClaim {
	item: QueueItem;
	completion: Promise<WorkCompletion>;
	resolve: (completion: WorkCompletion) => void;
	reject: (error: Error) => void;
}

export type AdmissionDecision =
	/** A new unit of work was queued. */
	| { kind: "admitted"; item: QueueItem; completion: Promise<WorkCompletion> }
	/** An existing claim already covers the request; the caller shares it. */
	| { kind: "shared"; item: QueueItem; completion: Promise<WorkCompletion> }
	/**
	 * A still-queued weaker item was replaced in place by the stronger
	 * request; the claim (and its completion) carried over.
	 */
	| { kind: "upgraded"; item: QueueItem; completion: Promise<WorkCompletion> }
	/**
	 * The stronger request collides with weaker work that is already ACTIVE.
	 * An in-place upgrade is only legal against queued work, so the caller
	 * must let the active work settle and admit again.
	 */
	| { kind: "after-active"; active: QueueItem; settled: Promise<unknown> };

/** The decisions retry admission can reach: it never upgrades or defers. */
export type RetryAdmissionDecision = Extract<
	AdmissionDecision,
	{ kind: "admitted" | "shared" }
>;

/**
 * Relative strength of intents within a lane. A stronger request supersedes
 * a weaker queued one (an upload replaces a queued converge pass, since the
 * upload's local-authoritative transfer subsumes it); a weaker or equal
 * request shares the claim already held.
 */
function intentStrength(intent: WorkIntent): number {
	return intent === "upload" ? 2 : 1;
}

export interface WorkLaneDeps {
	now(): number;
	/** Whether an item's folder can currently carry work. */
	isDrainable(item: QueueItem): boolean;
	/** A queued item whose target was destroyed before it could start. */
	onDiscarded(item: QueueItem): void;
	/** An item entered or left the active set. */
	onActiveChanged(item: QueueItem): void;
	/** The queue's membership or an item's intent changed. */
	onQueueChanged(items: readonly QueueItem[]): void;
}

/**
 * One dedup scope's queue: admission, ordering, offline retention, retry
 * scheduling, and cancellation for units of work, with no knowledge of what
 * the work is. The engine owns execution and pass accounting; the lane owns
 * which guid holds which claim and which item starts next.
 *
 * Items are stored in reverse path order so the next item normally sits at
 * the array tail: draining a ready queue pops without shifting or filtering
 * every remaining item.
 */
export class WorkLane {
	readonly operation: LaneOperation;
	readonly active = new ObservableSet<QueueItem>();
	private queue: QueueItem[] = [];
	private claims = new Map<string, LaneClaim>();
	private cancelled = new Set<string>();

	constructor(
		readonly scope: WorkScope,
		private deps: WorkLaneDeps,
	) {
		this.operation = laneOperation(scope);
	}

	/** Items waiting to start, in storage order. */
	get pending(): readonly QueueItem[] {
		return this.queue;
	}

	get queuedCount(): number {
		return this.queue.length;
	}

	/** Whether the guid holds a claim in this lane (queued or running). */
	isClaimed(guid: string): boolean {
		return this.claims.has(guid);
	}

	// =========================================================================
	// Admission
	// =========================================================================

	/**
	 * Admit a request. Dedups against queued-or-active work for the same
	 * guid: an equal-or-weaker request shares the held claim, a stronger
	 * request upgrades queued work in place, and a stronger request against
	 * active work is deferred to the caller (see `after-active`).
	 *
	 * Admission never sorts or flushes — the caller decides when a batch is
	 * complete (see `sortQueue` / the engine's drain).
	 */
	admit(request: WorkRequest): AdmissionDecision {
		const held = this.claims.get(request.guid);
		if (held) {
			const stronger =
				intentStrength(request.intent) > intentStrength(held.item.intent);
			if (!stronger) {
				return { kind: "shared", item: held.item, completion: held.completion };
			}
			if (held.item.status === "pending") {
				const replaced = held.item;
				const index = this.queue.indexOf(replaced);
				// The stronger request takes over the queued work's place in
				// line AND its retry bookkeeping: a parked backoff window and
				// the attempts already spent carry over, so an upgrade never
				// jumps a backoff or refreshes the retry budget.
				const upgraded: QueueItem = {
					...this.queuedItem(request, held.item.enqueuedAt),
					retryAttempts: held.item.retryAttempts,
					nextAttemptAt: held.item.nextAttemptAt,
					retryReason: held.item.retryReason,
				};
				if (index >= 0) {
					this.queue[index] = upgraded;
				} else {
					this.queue.push(upgraded);
				}
				held.item = upgraded;
				this.deps.onQueueChanged([replaced, upgraded]);
				return { kind: "upgraded", item: upgraded, completion: held.completion };
			}
			return {
				kind: "after-active",
				active: held.item,
				settled: held.completion.then(
					() => undefined,
					() => undefined,
				),
			};
		}

		const item = this.queuedItem(request, this.deps.now());
		const claim = this.createClaim(item);
		this.queue.push(item);
		this.deps.onQueueChanged([item]);
		return { kind: "admitted", item, completion: claim.completion };
	}

	/**
	 * Admit an item straight into its backoff window: the caller already
	 * observed a retryable failure for it (outside the lane) and wants the
	 * lane's retry policy to re-drive it. Returns null if retries are spent.
	 */
	admitForRetry(
		request: WorkRequest,
		reason: RetryReason,
		maxRetries: number,
	): RetryAdmissionDecision | null {
		const held = this.claims.get(request.guid);
		if (held) {
			return { kind: "shared", item: held.item, completion: held.completion };
		}
		const item = this.queuedItem(request, this.deps.now());
		const claim = this.createClaim(item);
		if (!this.scheduleRetry(item, reason, maxRetries)) {
			this.claims.delete(item.guid);
			return null;
		}
		return { kind: "admitted", item, completion: claim.completion };
	}

	private queuedItem(request: WorkRequest, enqueuedAt: number): QueueItem {
		return { ...request, status: "pending", enqueuedAt };
	}

	private createClaim(item: QueueItem): LaneClaim {
		let resolve!: (completion: WorkCompletion) => void;
		let reject!: (error: Error) => void;
		const completion = new Promise<WorkCompletion>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		// A claim nobody awaits must not surface as an unhandled rejection:
		// the engine records failures on its own surface.
		completion.catch(() => {});
		const claim: LaneClaim = { item, completion, resolve, reject };
		this.claims.set(item.guid, claim);
		return claim;
	}

	// =========================================================================
	// Ordering and draining
	// =========================================================================

	/** Re-sort the queue after a batch of admissions. */
	sortQueue(reason: LaneSortReason): void {
		WorkLane.sortByPath(this.queue, this.operation, reason, true);
	}

	static sortByPath<T extends { path: string }>(
		items: T[],
		operation: LaneOperation,
		reason: LaneSortReason,
		reverse = false,
	): T[] {
		if (items.length < 2) return items;
		const sortStart = performance.now();
		items.sort(reverse ? (a, b) => compareFilePaths(b, a) : compareFilePaths);
		metrics.observeBgSyncSort(
			operation,
			reason,
			items.length,
			(performance.now() - sortStart) / 1000,
		);
		return items;
	}

	/**
	 * Take the next item that can start: its folder is drainable and its
	 * backoff window (if any) has elapsed. Items for disconnected folders
	 * stay queued — work admitted while offline must survive until the
	 * folder reconnects, not be dropped at admission — and destroyed targets
	 * are discarded on the way past.
	 */
	takeNext(now: number): QueueItem | undefined {
		for (let index = this.queue.length - 1; index >= 0; index--) {
			const item = this.queue[index];
			if (item.target.destroyed) {
				this.removeAt(index);
				this.discard(item);
				continue;
			}
			if (
				this.deps.isDrainable(item) &&
				(item.nextAttemptAt === undefined || item.nextAttemptAt <= now)
			) {
				return this.removeAt(index);
			}
		}
		return undefined;
	}

	private removeAt(index: number): QueueItem {
		if (index === this.queue.length - 1) {
			return this.queue.pop()!;
		}
		return this.queue.splice(index, 1)[0];
	}

	private discard(item: QueueItem): void {
		const claim = this.claims.get(item.guid);
		if (claim?.item === item) {
			this.claims.delete(item.guid);
			claim.reject(new Error("Target destroyed"));
		}
		this.cancelled.delete(item.guid);
		this.deps.onDiscarded(item);
	}

	/** Mark an item running. */
	start(item: QueueItem): void {
		item.status = "running";
		item.nextAttemptAt = undefined;
		item.retryReason = undefined;
		this.active.add(item);
		this.deps.onActiveChanged(item);
	}

	private removeActive(item: QueueItem): void {
		if (this.active.delete(item)) {
			this.deps.onActiveChanged(item);
		}
	}

	// =========================================================================
	// Settlement
	// =========================================================================

	/**
	 * The work behind an item finished. Resolves the shared claim — as
	 * cancelled when a cancellation was raised while it ran — and releases
	 * the guid.
	 */
	settle(item: QueueItem, completion: WorkCompletion): void {
		item.status = "completed";
		const cancelled = this.isCancelled(item);
		this.removeActive(item);
		const claim = this.claims.get(item.guid);
		if (claim?.item === item) {
			this.claims.delete(item.guid);
			claim.resolve(cancelled ? { outcome: "cancelled" } : completion);
		}
		this.cancelled.delete(item.guid);
	}

	/** The work behind an item failed for good; reject the shared claim. */
	fail(item: QueueItem, error: Error): void {
		item.status = "failed";
		this.removeActive(item);
		const claim = this.claims.get(item.guid);
		if (claim?.item === item) {
			this.claims.delete(item.guid);
			claim.reject(error);
		}
		this.cancelled.delete(item.guid);
	}

	/**
	 * Park a failed item for another attempt after a backoff window. The
	 * claim survives, so callers sharing the completion stay attached across
	 * the retry. Returns false once the retry budget is spent; the item then
	 * stays out of the queue and the caller fails it.
	 */
	scheduleRetry(
		item: QueueItem,
		reason: RetryReason,
		maxRetries: number,
	): boolean {
		const retries = (item.retryAttempts ?? 0) + 1;
		item.retryAttempts = retries;
		this.removeActive(item);
		if (retries > maxRetries) {
			item.nextAttemptAt = undefined;
			item.retryReason = undefined;
			return false;
		}
		const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(retries - 1, 5));
		item.status = "pending";
		item.nextAttemptAt = this.deps.now() + delayMs;
		item.retryReason = reason;
		metrics.recordBgSyncRetry(this.operation, reason, retries, delayMs / 1000);
		if (!this.queue.includes(item)) {
			this.queue.push(item);
			this.sortQueue("retry");
		}
		this.deps.onQueueChanged([item]);
		return true;
	}

	// =========================================================================
	// Cancellation
	// =========================================================================

	/**
	 * Cancel a guid's work in this lane. Queued items leave the queue now and
	 * are returned for pass accounting. Active work keeps running — the
	 * pipeline consults `isCancelled` at its stage boundaries — and its claim
	 * settles as cancelled when it returns. With nothing active the claim
	 * settles as cancelled immediately.
	 */
	cancel(guid: string): { removed: QueueItem[]; activeRemains: boolean } {
		const removed: QueueItem[] = [];
		for (let index = this.queue.length - 1; index >= 0; index--) {
			if (this.queue[index].guid === guid) {
				removed.push(this.removeAt(index));
			}
		}
		const activeRemains = this.active.some((item) => item.guid === guid);
		if (activeRemains) {
			this.cancelled.add(guid);
		} else {
			const claim = this.claims.get(guid);
			if (claim) {
				this.claims.delete(guid);
				claim.resolve({ outcome: "cancelled" });
			}
			this.cancelled.delete(guid);
		}
		if (removed.length > 0) this.deps.onQueueChanged(removed);
		return { removed, activeRemains };
	}

	isCancelled(item: QueueItem): boolean {
		return item.target.destroyed || this.cancelled.has(item.guid);
	}

	// =========================================================================
	// Teardown
	// =========================================================================

	destroy(error: Error): void {
		for (const claim of this.claims.values()) {
			claim.reject(error);
		}
		this.claims.clear();
		this.cancelled.clear();
		this.queue = [];
		this.active.destroy();
	}
}
