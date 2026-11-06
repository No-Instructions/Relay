import { getPatcher } from "./Patcher";

const METHODS = ["exists", "stat", "read", "readBinary", "write", "writeBinary", "append", "process", "mkdir", "rmdir", "remove", "rename", "copy", "list", "trashSystem", "trashLocal"] as const;
const MAX_TEXT = 1024;
const DEFAULT_CAPACITY = 500;

type Context = { operation: string; path?: string; destination?: string };
export type DiskQueueTraceEntry = Context & {
	id: number;
	state: "waiting" | "running" | "completed" | "failed";
	submittedAt: number;
	startedAt?: number;
	settledAt?: number;
	waitMs: number;
	runMs: number | null;
};
export type DiskQueueTraceSnapshot = {
	recording: boolean;
	startedAt: number | null;
	stoppedAt: number | null;
	capturedAt: number;
	capacity: number;
	omitted: number;
	evicted: number;
	pending: DiskQueueTraceEntry[];
	recent: DiskQueueTraceEntry[];
};
type Entry = Context & { id: number; submitted: number; started?: number; settled?: number; failed?: boolean };

/** Local, bounded metadata; never retains callbacks, file contents, or errors. */
export class DiskQueueTrace {
	private context: Context | null = null;
	private removePatch: (() => void) | null = null;
	private pending = new Map<number, Entry>();
	private recent: Entry[] = [];
	private nextRecent = 0;
	private nextId = 0;
	private started: number | null = null;
	private stopped: number | null = null;
	private wallStart: number | null = null;
	private omitted = 0;
	private evicted = 0;
	recording = false;

	constructor(
		private adapter: object,
		private now: () => number,
		private wallNow: () => number = Date.now,
		private capacity = DEFAULT_CAPACITY,
	) {
		if (!Number.isInteger(capacity) || capacity < 1 || capacity > 5000) {
			throw new Error("Trace capacity must be between 1 and 5000");
		}
	}

	start(): void {
		if (this.recording) return;
		this.pending.clear();
		this.recent = [];
		this.nextRecent = 0;
		this.omitted = this.evicted = 0;
		this.started = this.now();
		this.wallStart = this.wallNow();
		this.stopped = null;
		this.recording = true;
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- Preserve the adapter receiver in each method wrapper.
		const recorder = this;
		const patches: Record<string, unknown> = {};
		for (const method of METHODS) {
			if (typeof (this.adapter as Record<string, unknown>)[method] !== "function") continue;
			patches[method] = (original: (this: unknown, ...args: unknown[]) => unknown) => function (this: unknown, ...args: unknown[]) {
				const previous = recorder.context;
				// Attribute synchronous submissions only; an async continuation
				// has no reliable originating context.
				recorder.context = {
					operation: method,
					path: typeof args[0] === "string" ? args[0].slice(0, MAX_TEXT) : undefined,
					destination: (method === "rename" || method === "copy") && typeof args[1] === "string"
						? args[1].slice(0, MAX_TEXT) : undefined,
				};
				try { return original.apply(this, args); }
				finally { recorder.context = previous; }
			};
		}
		try { this.removePatch = getPatcher().patch(this.adapter, patches); }
		catch (error) { this.recording = false; throw error; }
	}

	submit(submitted: number): number | undefined {
		if (!this.recording) return;
		if (this.pending.size >= this.capacity) { this.omitted++; return; }
		const id = ++this.nextId;
		this.pending.set(id, { id, submitted, ...(this.context ?? { operation: "unattributed" }) });
		return id;
	}

	begin(id: number | undefined, started: number): void {
		if (!this.recording || id === undefined) return;
		const entry = this.pending.get(id);
		if (entry) entry.started = started;
	}

	finish(id: number | undefined, settled: number, failed: boolean): void {
		if (!this.recording || id === undefined) return;
		const entry = this.pending.get(id);
		if (!entry) return;
		this.pending.delete(id);
		entry.settled = settled;
		entry.failed = failed;
		if (this.recent.length < this.capacity) this.recent.push(entry);
		else {
			this.recent[this.nextRecent] = entry;
			this.nextRecent = (this.nextRecent + 1) % this.capacity;
			this.evicted++;
		}
	}

	stop(): void {
		if (!this.recording) return;
		this.stopped = this.now();
		this.recording = false;
		this.removePatch?.();
		this.removePatch = null;
		this.context = null;
	}

	snapshot(): DiskQueueTraceSnapshot {
		const now = this.stopped ?? this.now();
		const wall = (value: number) => this.wallStart! + value - this.started!;
		const entry = (item: Entry): DiskQueueTraceEntry => ({
			id: item.id, operation: item.operation, path: item.path, destination: item.destination,
			state: item.settled !== undefined ? (item.failed ? "failed" : "completed") : item.started !== undefined ? "running" : "waiting",
			submittedAt: wall(item.submitted),
			startedAt: item.started === undefined ? undefined : wall(item.started),
			settledAt: item.settled === undefined ? undefined : wall(item.settled),
			waitMs: Math.max(0, (item.started ?? item.settled ?? now) - item.submitted),
			runMs: item.started === undefined ? null : Math.max(0, (item.settled ?? now) - item.started),
		});
		const recent = [...this.recent.slice(this.nextRecent), ...this.recent.slice(0, this.nextRecent)];
		return {
			recording: this.recording, startedAt: this.wallStart,
			stoppedAt: this.stopped === null ? null : wall(this.stopped),
			capturedAt: this.wallNow(), capacity: this.capacity, omitted: this.omitted, evicted: this.evicted,
			pending: [...this.pending.values()].map(entry), recent: recent.map(entry),
		};
	}

	destroy(): void {
		this.stop();
		this.pending.clear();
		this.recent = [];
	}
}
