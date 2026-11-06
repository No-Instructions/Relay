import { getPatcher } from "./Patcher";
import { DiskQueueTrace, type DiskQueueTraceSnapshot } from "./DiskQueueTrace";
import type { TimeProvider } from "./TimeProvider";
import type { IObsidianMetricsAPI, MetricInstance } from "./types/obsidian-metrics";

type QueueCallback = (this: unknown, ...args: unknown[]) => unknown;
type QueueMethod = (this: unknown, callback: QueueCallback, ...args: unknown[]) => Promise<unknown>;
type Operation = { submitted: number; started?: number; traceId?: number };
type QueueMetrics = {
	active: MetricInstance;
	depth: MetricInstance;
	oldest: MetricInstance;
	wait: MetricInstance;
	run: MetricInstance;
	completed: MetricInstance;
};

const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 120, 300];

/**
 * Observes submissions to Obsidian's private adapter.queue method, when present.
 * This includes every caller of the adapter, not only Relay. Work submitted before
 * attachment is absent from the counts, but can contribute to measured wait time.
 *
 * Running time ends when the queue's promise settles. A desktop watchdog can
 * release the queue while its underlying native operation is still outstanding.
 * These metrics describe queue occupancy, not native filesystem concurrency.
 */
export class DiskQueueMetrics {
	private metrics: QueueMetrics | null = null;
	private waiting = new Map<Operation, number>();
	private running = new Map<Operation, number>();
	private removePatch: (() => void) | null = null;
	private interval: number | null = null;
	private attached = false;
	private destroyed = false;
	private trace: DiskQueueTrace;

	constructor(
		private adapter: object,
		private time: Pick<TimeProvider, "setInterval" | "clearInterval">,
		private now: () => number = () => performance.now(),
	) {
		this.trace = new DiskQueueTrace(adapter, now);
	}

	startTrace(): void {
		if (this.destroyed || typeof (this.adapter as { queue?: unknown }).queue !== "function") return;
		this.observe(() => {
			if (!this.removePatch) this.attach();
			this.trace.start();
		});
	}

	stopTrace(): void {
		this.observe(() => this.trace.stop());
		if (!this.metrics) {
			this.observe(() => this.removePatch?.());
			this.removePatch = null;
			this.attached = false;
			this.waiting.clear();
			this.running.clear();
		}
	}

	getTrace(): DiskQueueTraceSnapshot {
		return this.trace.snapshot();
	}

	/** Metrics sampling starts when a store is available; tracing can also attach observation. */
	initializeFromAPI(api: IObsidianMetricsAPI): void {
		if (this.destroyed) return;
		this.observe(() => {
			this.metrics = {
				active: api.createGauge({
					name: "relay_disk_queue_observer_active",
					help: "Whether Obsidian adapter queue observation is attached (all callers).",
				}),
				depth: api.createGauge({
					name: "relay_disk_queue_operations",
					help: "Observed adapter queue operations by state; excludes submissions before attachment.",
					labelNames: ["state"],
				}),
				oldest: api.createGauge({
					name: "relay_disk_queue_oldest_seconds",
					help: "Age in the current state of the oldest observed adapter queue operation.",
					labelNames: ["state"],
				}),
				wait: api.createHistogram({
					name: "relay_disk_queue_wait_seconds",
					help: "Time from adapter queue submission until the callback starts (all callers).",
					buckets: DURATION_BUCKETS,
				}),
				run: api.createHistogram({
					name: "relay_disk_queue_run_seconds",
					help: "Time from callback start until the adapter queue promise settles, including watchdog release.",
					buckets: DURATION_BUCKETS,
				}),
				completed: api.createCounter({
					name: "relay_disk_queue_operations_total",
					help: "Settled observed adapter queue operations by result (all callers).",
					labelNames: ["result"],
				}),
			};
			if (!this.removePatch && typeof (this.adapter as { queue?: unknown }).queue === "function") {
				this.attach();
			}
			if (this.attached && this.interval === null) {
				this.interval = this.time.setInterval(() => this.sample(), 1000);
			}
			this.metrics.active.set(this.attached ? 1 : 0);
			this.sample();
		});
	}

	private attach(): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- Both wrappers must preserve the caller's receiver.
		const observer = this;
		this.removePatch = getPatcher().patch(this.adapter, {
			queue(original: QueueMethod): QueueMethod {
				observer.attached = true;
				return function (callback, ...args) {
					if (observer.destroyed || (!observer.metrics && !observer.trace.recording) || typeof callback !== "function") {
						return original.call(this, callback, ...args);
					}
					let operation: Operation | undefined;
					observer.observe(() => {
						operation = { submitted: observer.now() };
						operation.traceId = observer.trace.submit(operation.submitted);
						if (observer.metrics) observer.waiting.set(operation, operation.submitted);
					});
					observer.sample();
					let result: Promise<unknown>;
					try {
						result = original.call(this, function (...callbackArgs) {
							observer.start(operation);
							return callback.apply(this, callbackArgs);
						}, ...args);
					} catch (error) {
						observer.finish(operation, "failed");
						throw error;
					}
					if (typeof result?.then !== "function") {
						// An adapter with a different queue contract cannot be observed.
						observer.destroy();
						return result;
					}
					// Observe the original promise without replacing it or adding a
					// dependency to Obsidian's promise chain. Observer callbacks never throw.
					observer.observe(() => {
						void result.then(
							() => observer.finish(operation, "completed"),
							() => observer.finish(operation, "failed"),
						);
					});
					return result;
				};
			},
		});
	}

	private start(operation?: Operation): void {
		if (!operation || this.destroyed) return;
		this.observe(() => {
			operation.started = this.now();
			this.trace.begin(operation.traceId, operation.started);
			this.waiting.delete(operation);
			if (this.metrics) this.running.set(operation, operation.started);
			this.metrics?.wait.observe(this.secondsSince(operation.submitted, operation.started));
		});
		this.sample();
	}

	private finish(operation: Operation | undefined, result: "completed" | "failed"): void {
		if (!operation || this.destroyed) return;
		this.waiting.delete(operation);
		this.running.delete(operation);
		this.observe(() => {
			this.trace.finish(operation.traceId, this.now(), result === "failed");
			if (operation.started !== undefined) {
				this.metrics?.run.observe(this.secondsSince(operation.started, this.now()));
			}
			this.metrics?.completed.inc(1, { result });
		});
		this.sample();
	}

	private sample(): void {
		this.observe(() => {
			if (!this.metrics) return;
			const now = this.now();
			for (const [state, operations] of [["waiting", this.waiting], ["running", this.running]] as const) {
				this.metrics.depth.set(operations.size, { state });
				const oldest = operations.values().next().value;
				this.metrics.oldest.set(oldest === undefined ? 0 : this.secondsSince(oldest, now), { state });
			}
		});
	}

	private secondsSince(start: number, end: number): number {
		return Math.max(0, end - start) / 1000;
	}

	/** Metrics failure must neither fail disk work nor write logs into this queue. */
	private observe(action: () => void): void {
		try {
			action();
		} catch {
			// TSDB handles can be unavailable while its plugin reloads.
		}
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.observe(() => this.trace.destroy());
		this.observe(() => this.removePatch?.());
		this.removePatch = null;
		if (this.interval !== null) {
			this.observe(() => this.time.clearInterval(this.interval!));
			this.interval = null;
		}
		this.attached = false;
		this.waiting.clear();
		this.running.clear();
		this.observe(() => this.metrics?.active.set(0));
		this.sample();
		this.metrics = null;
	}
}
