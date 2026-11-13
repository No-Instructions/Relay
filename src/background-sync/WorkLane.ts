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

const MAX_HIGH_PRIORITY_BURST = 8;

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

interface PendingEntry {
	item: QueueItem;
	token: number;
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
 * Items are stored in reverse priority and path order so the next item sits at
 * the array tail: draining a ready queue pops without shifting or filtering
 * every remaining item.
 */
export class WorkLane {
	readonly operation: LaneOperation;
	readonly active = new ObservableSet<QueueItem>();
	/** Path/priority order, with stale entries removed lazily from its tail. */
	private queue: PendingEntry[] = [];
	/** Normal work by age, oldest at the tail for the background turn. */
	private normalByAge: PendingEntry[] = [];
	private normalAgeDirty = true;
	private pendingTokens = new Map<QueueItem, number>();
	private pendingByFolder = new Map<QueueItem["sharedFolder"], number>();
	private nextPendingToken = 0;
	private claims = new Map<string, LaneClaim>();
	private cancelled = new Set<string>();
	private highPriorityStarts = 0;
	private normalQueued = 0;
	private priorityOrderDirty = false;

	constructor(
		readonly scope: WorkScope,
		private deps: WorkLaneDeps,
	) {
		this.operation = laneOperation(scope);
	}

	/** Items waiting to start, in storage order. */
	get pending(): readonly QueueItem[] {
		return this.queue
			.filter((entry) => this.isPending(entry))
			.map((entry) => entry.item);
	}

	get queuedCount(): number {
		return this.pendingTokens.size;
	}

	queuedCountFor(sharedFolder: QueueItem["sharedFolder"]): number {
		return this.pendingByFolder.get(sharedFolder) ?? 0;
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
	 * request or a registered target whose transfer can materialize its missing
	 * file upgrades queued provisional work in place, and either replacement
	 * against active work is deferred to the caller (see `after-active`).
	 *
	 * Admission never sorts or flushes — the caller decides when a batch is
	 * complete (see `sortQueue` / the engine's drain).
	 */
	admit(request: WorkRequest): AdmissionDecision {
		const held = this.claims.get(request.guid);
		if (held) {
			if (request.priority === "high" && held.item.priority !== "high") {
				if (held.item.status === "pending") {
					this.normalQueued--;
					this.priorityOrderDirty = true;
				}
				held.item.priority = "high";
				this.deps.onQueueChanged([held.item]);
			}
			const replacesProvisionalTarget =
				held.item.target.provisional === true &&
				request.target.provisional !== true &&
				held.item.target !== request.target &&
				request.target.materializesOnTransfer === true;
			const replacesDestroyedProvisionalTarget =
				held.item.target.provisional === true &&
				request.target.provisional === true &&
				held.item.target !== request.target &&
				held.item.target.destroyed;
			const sharesActiveProvisional =
				held.item.status === "running" &&
				replacesProvisionalTarget &&
				held.item.target.sharesActiveWorkWith?.(request.target) === true;
			const stronger = replacesProvisionalTarget || replacesDestroyedProvisionalTarget ||
				intentStrength(request.intent) > intentStrength(held.item.intent);
			if (!stronger || sharesActiveProvisional) {
				return { kind: "shared", item: held.item, completion: held.completion };
			}
			if (held.item.status === "pending") {
				const replaced = held.item;
				// The stronger request takes over the queued work's place in
				// line AND its retry bookkeeping: a parked backoff window and
				// the attempts already spent carry over, so an upgrade never
				// jumps a backoff or refreshes the retry budget.
				const upgraded: QueueItem = {
					...this.queuedItem(request, held.item.enqueuedAt),
					priority: held.item.priority === "high" ? "high" : request.priority,
					retryAttempts: held.item.retryAttempts,
					nextAttemptAt: held.item.nextAttemptAt,
					retryReason: held.item.retryReason,
				};
				this.removePending(replaced);
				this.push(upgraded);
				this.priorityOrderDirty = true;
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
		this.push(item);
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
		const items = [...this.pendingTokens.keys()];
		WorkLane.sortByPriorityAndPath(items, this.operation, reason, true);
		this.queue = items.map((item) => ({
			item,
			token: this.pendingTokens.get(item)!,
		}));
		this.normalByAge = [];
		this.normalAgeDirty = true;
		this.priorityOrderDirty = false;
	}

	private ensureNormalAgeIndex(): void {
		if (!this.normalAgeDirty) return;
		this.normalByAge = this.queue
			.filter((entry) => this.isPending(entry) && entry.item.priority !== "high")
			.sort((a, b) =>
				b.item.enqueuedAt - a.item.enqueuedAt ||
				compareFilePaths(b.item, a.item),
			);
		this.normalAgeDirty = false;
	}

	static sortByPriorityAndPath<T extends { path: string; priority?: string }>(
		items: T[],
		operation: LaneOperation,
		reason: LaneSortReason,
		reverse = false,
	): T[] {
		if (items.length < 2) return items;
		const sortStart = performance.now();
		const compare = (a: T, b: T) =>
			Number(b.priority === "high") - Number(a.priority === "high") || compareFilePaths(a, b);
		items.sort(reverse ? (a, b) => compare(b, a) : compare);
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
		if (this.priorityOrderDirty) this.sortQueue("enqueue");
		const backgroundTurn = this.highPriorityStarts >= MAX_HIGH_PRIORITY_BURST && this.normalQueued > 0;
		// One turn for the oldest ready background item after an urgent burst.
		// The age index avoids walking all urgent work to find it. If normal
		// work is offline or backing off, urgency can continue from path order.
		if (backgroundTurn) {
			this.ensureNormalAgeIndex();
			const background = this.takeReady(this.normalByAge, now, true);
			if (background) {
				this.highPriorityStarts = 0;
				return background;
			}
		}
		const item = this.takeReady(this.queue, now, false);
		if (!item) return undefined;
		this.highPriorityStarts = item.priority === "high" ? this.highPriorityStarts + 1 : 0;
		return item;
	}

	private push(item: QueueItem): void {
		const token = ++this.nextPendingToken;
		this.pendingTokens.set(item, token);
		this.pendingByFolder.set(
			item.sharedFolder,
			(this.pendingByFolder.get(item.sharedFolder) ?? 0) + 1,
		);
		if (item.priority !== "high") this.normalQueued++;
		const entry = { item, token };
		this.queue.push(entry);
		this.normalAgeDirty = true;
	}

	private isPending(entry: PendingEntry): boolean {
		return this.pendingTokens.get(entry.item) === entry.token;
	}

	private removePending(item: QueueItem): boolean {
		if (!this.pendingTokens.delete(item)) return false;
		const folderCount = (this.pendingByFolder.get(item.sharedFolder) ?? 1) - 1;
		if (folderCount > 0) this.pendingByFolder.set(item.sharedFolder, folderCount);
		else this.pendingByFolder.delete(item.sharedFolder);
		if (item.priority !== "high") this.normalQueued--;
		return true;
	}

	private takeReady(
		entries: PendingEntry[],
		now: number,
		normalOnly: boolean,
	): QueueItem | undefined {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			const item = entry.item;
			if (!this.isPending(entry) || (normalOnly && item.priority === "high")) {
				if (index === entries.length - 1) entries.pop();
				continue;
			}
			if (item.target.destroyed) {
				this.removePending(item);
				if (index === entries.length - 1) entries.pop();
				this.discard(item);
				continue;
			}
			if (!this.deps.isDrainable(item) ||
				(item.nextAttemptAt !== undefined && item.nextAttemptAt > now)) continue;
			this.removePending(item);
			if (index === entries.length - 1) entries.pop();
			return item;
		}
		return undefined;
	}

	private discard(item: QueueItem): void {
		const claim = this.claims.get(item.guid);
		if (claim?.item === item) {
			this.claims.delete(item.guid);
			claim.resolve({ outcome: "cancelled" });
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
		if (!this.pendingTokens.has(item)) {
			this.push(item);
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
		const claim = this.claims.get(guid);
		if (claim && this.removePending(claim.item)) {
			removed.push(claim.item);
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
		this.normalByAge = [];
		this.normalAgeDirty = true;
		this.pendingTokens.clear();
		this.pendingByFolder.clear();
		this.normalQueued = 0;
		this.priorityOrderDirty = false;
		this.highPriorityStarts = 0;
		this.active.destroy();
	}
}
