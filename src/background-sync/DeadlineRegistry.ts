import type { TimeProvider } from "../TimeProvider";
import { RetryableProviderSyncError } from "./errors";

export type TransferOperation = "sync" | "download";

// A provider-bound sync or download operation that has not settled in this long
// is treated as timed out. Generous by design — a healthy but slow transfer
// must never trip it — because the deadline only detects a wedged await (a dead
// or stranded connection whose promise never resolves) and converts it into a
// legible, retryable failure. It never schedules recovery: reconnection and the
// queue's own retry/backoff do that.
export const PROVIDER_OP_DEADLINE_MS = 5 * 60_000;

// Identity for a single in-flight provider-bound operation, minted by
// withDeadline and threaded through the operation's call chain. Warm
// leases acquired inside the operation register their releases against the
// token, so a deadline sweep can only ever release what its own operation
// holds — never a concurrent operation's lease on the same document. The
// sweep marks the token abandoned; a lease registered afterwards (an
// abandoned operation resuming on a late settle) is released immediately
// instead of parking with no deadline left to watch it.
export interface ProviderOperationToken {
	abandoned: boolean;
}

// A provider-bound operation abandoned after PROVIDER_OP_DEADLINE_MS. Retryable
// like any provider sync error so the queue re-drives it, but a distinct type so
// a genuine operation error and a stalled transport are never conflated.
export class ProviderTimeoutError extends RetryableProviderSyncError {
	constructor(
		readonly operation: TransferOperation,
		readonly awaited: string,
		readonly guid: string,
		readonly deadlineMs: number,
	) {
		super(
			`timed out awaiting provider ${awaited} for ${guid} after ` +
				`${Math.round(deadlineMs / 1000)}s`,
		);
		this.name = "ProviderTimeoutError";
	}
}

/**
 * Runs provider-bound operations under a deadline and tracks the warm-lease
 * releases they hold, keyed by each operation's own token. A deadlined
 * operation is abandoned with its finally blocks suspended behind the hung
 * await, so its lease release never runs on its own — the deadline path
 * releases through this registry instead. Releases are idempotent, so an
 * abandoned operation that eventually settles double-releases as a no-op.
 */
export class DeadlineRegistry {
	private heldLeaseReleases = new Map<ProviderOperationToken, Set<() => void>>();

	constructor(private timeProvider: TimeProvider) {}

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
	// ProviderTimeoutError, which the queue's catch classifies as a
	// provider failure, frees the slot, and reschedules. A settled op clears
	// the timer; a genuinely hung underlying promise is left to be
	// garbage-collected once its references drop, and any warm leases its
	// operation registered are released through the token so the abandoned
	// work cannot pin its document against hibernation for the rest of the
	// session.
	withDeadline<T>(
		work: (token: ProviderOperationToken) => Promise<T>,
		operation: TransferOperation,
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

	/**
	 * Invoke every release still registered by an in-flight operation and
	 * drop the registry: a hung operation's lease must not outlive the
	 * bookkeeping that was going to release it. Marking each token abandoned
	 * makes any post-destroy registration self-release.
	 */
	destroy(): void {
		for (const [token, releases] of [...this.heldLeaseReleases]) {
			token.abandoned = true;
			for (const release of [...releases]) release();
		}
		this.heldLeaseReleases.clear();
	}
}
