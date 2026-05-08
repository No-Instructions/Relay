import type { SharedFolder } from "../SharedFolder";
import type { MergeTransitionInfo } from "../merge-hsm/MergeManager";
import type { SyncStatus } from "../merge-hsm/types";
import type { TimeProvider } from "../TimeProvider";

const MAX_ACTIVITY = 30;

export interface SyncStatusActivityEntry {
	id: number;
	guid: string;
	path: string;
	timestamp: number;
	status: string;
	description: string;
	author: string;
}

type ActivitySubscriber = (entries: SyncStatusActivityEntry[]) => void;

class ActivityRingBuffer<T> {
	private readonly slots: Array<T | undefined>;
	private next = 0;
	private count = 0;

	constructor(private readonly capacity: number) {
		this.slots = new Array(capacity);
	}

	push(entry: T): void {
		this.slots[this.next] = entry;
		this.next = (this.next + 1) % this.capacity;
		this.count = Math.min(this.count + 1, this.capacity);
	}

	upsert(entry: T, matches: (existing: T) => boolean): T | undefined {
		for (let offset = 0; offset < this.count; offset++) {
			const index = (this.next - 1 - offset + this.capacity) % this.capacity;
			const existing = this.slots[index];
			if (existing && matches(existing)) {
				this.slots[index] = entry;
				return existing;
			}
		}
		this.push(entry);
		return undefined;
	}

	find(matches: (existing: T) => boolean): T | undefined {
		for (let offset = 0; offset < this.count; offset++) {
			const index = (this.next - 1 - offset + this.capacity) % this.capacity;
			const existing = this.slots[index];
			if (existing && matches(existing)) {
				return existing;
			}
		}
		return undefined;
	}

	valuesNewestFirst(): T[] {
		const values: T[] = [];
		for (let offset = 0; offset < this.count; offset++) {
			const index = (this.next - 1 - offset + this.capacity) % this.capacity;
			const entry = this.slots[index];
			if (entry) values.push(entry);
		}
		return values;
	}
}

export class SyncStatusActivityStore {
	private readonly buffer = new ActivityRingBuffer<SyncStatusActivityEntry>(MAX_ACTIVITY);
	private readonly subscribers = new Set<ActivitySubscriber>();
	private readonly prevSnapshot = new Map<string, string>();
	private readonly lastSeededActivityByGuid = new Map<
		string,
		{ timestamp: number; userId?: string }
	>();
	private unsubscribeSyncStatus?: () => void;
	private unsubscribeRemoteActivity?: () => void;
	private unsubscribeHsmTransitions?: () => void;
	private nextEntryId = 1;
	private destroyed = false;

	private readonly handleHsmTransition = (
		guid: string,
		_path: string,
		info: MergeTransitionInfo,
	): void => {
		if (this.destroyed || info.to !== "idle.diskAhead") return;
		if (
			info.event.type !== "DISK_CHANGED" &&
			info.event.type !== "SET_MODE_IDLE"
		) return;
		if (!this.sharedFolder.files.has(guid)) return;

		this.pushActivity({
			guid,
			timestamp: this.timeProvider.now(),
			status: "pending",
			description: "External edit",
			author: "",
		});
		this.notify();
	};

	constructor(
		private readonly sharedFolder: SharedFolder,
		private readonly timeProvider: TimeProvider,
	) {
		this.initializeSnapshot();
		this.seedFromRemoteActivity();
		this.unsubscribeRemoteActivity = sharedFolder.subscribeToRemoteActivity(() => {
			if (this.seedFromRemoteActivity()) {
				this.notify();
			}
		});
		this.unsubscribeSyncStatus = sharedFolder.mergeManager.syncStatus.subscribe(() => {
			this.recordActivity();
		});
		this.unsubscribeHsmTransitions = sharedFolder.mergeManager.subscribeToTransitions(
			this.handleHsmTransition,
		);
		sharedFolder.onDestroy(() => this.destroy());
	}

	subscribe(run: ActivitySubscriber): () => void {
		if (this.destroyed) {
			run([]);
			return () => {};
		}
		this.subscribers.add(run);
		run(this.entries());
		return () => {
			this.subscribers.delete(run);
		};
	}

	entries(): SyncStatusActivityEntry[] {
		return this.buffer
			.valuesNewestFirst()
			.sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.unsubscribeSyncStatus?.();
		this.unsubscribeSyncStatus = undefined;
		this.unsubscribeRemoteActivity?.();
		this.unsubscribeRemoteActivity = undefined;
		this.unsubscribeHsmTransitions?.();
		this.unsubscribeHsmTransitions = undefined;
		this.subscribers.clear();
		activityStores.delete(this.sharedFolder);
	}

	private initializeSnapshot(): void {
		const syncStatusMap = this.sharedFolder.mergeManager.syncStatus;
		for (const [guid] of this.sharedFolder.files) {
			const syncStatus = syncStatusMap.get<SyncStatus>(guid);
			this.prevSnapshot.set(guid, syncStatus?.status ?? "unknown");
		}
	}

	private recordActivity(): void {
		const timestamp = this.timeProvider.now();
		const syncStatusMap = this.sharedFolder.mergeManager.syncStatus;
		let changed = this.seedFromRemoteActivity();

		for (const [guid] of this.sharedFolder.files) {
			const syncStatus = syncStatusMap.get<SyncStatus>(guid);
			const currentStatus = syncStatus?.status ?? "unknown";
			const prevStatus = this.prevSnapshot.get(guid) ?? "unknown";

			if (currentStatus !== prevStatus && prevStatus !== "unknown") {
				const remoteAuthor = this.sharedFolder.getRemoteActivity(guid)?.userId;
				const actionable = currentStatus === "conflict" || currentStatus === "error";
				if (remoteAuthor || actionable) {
					this.pushActivity({
						guid,
						timestamp,
						status: currentStatus,
						description: describeStatus(currentStatus),
						author: this.resolveAuthorName(remoteAuthor),
					});
					changed = true;
				}
			}

			this.prevSnapshot.set(guid, currentStatus);
		}

		if (changed) {
			this.notify();
		}
	}

	private seedFromRemoteActivity(): boolean {
		if (this.destroyed) return false;

		const seeds = this.sharedFolder
			.getRecentRemoteActivity(MAX_ACTIVITY)
			.filter((entry) => {
				if (!this.sharedFolder.files.has(entry.guid)) return false;
				const lastSeeded = this.lastSeededActivityByGuid.get(entry.guid);
				return (
					!lastSeeded ||
					entry.timestamp > lastSeeded.timestamp ||
					entry.userId !== lastSeeded.userId
				);
			});
		if (seeds.length === 0) return false;

		seeds.sort((a, b) => a.timestamp - b.timestamp);
		for (const seed of seeds) {
			this.pushActivity({
				guid: seed.guid,
				timestamp: seed.timestamp,
				status: "synced",
				description: "Synced",
				author: this.resolveAuthorName(seed.userId),
			});
			this.lastSeededActivityByGuid.set(seed.guid, {
				timestamp: seed.timestamp,
				userId: seed.userId,
			});
		}
		return true;
	}

	private pushActivity(
		entry: Omit<SyncStatusActivityEntry, "id" | "path">,
	): void {
		const existing = this.buffer.find(
			(candidate) => candidate.guid === entry.guid,
		);
		this.buffer.upsert({
			...entry,
			id: existing?.id ?? this.nextEntryId++,
			path: this.guidToPath(entry.guid),
		}, (candidate) => candidate.guid === entry.guid);
	}

	private guidToPath(guid: string): string {
		const file = this.sharedFolder.files.get(guid);
		return file ? relativePath(this.sharedFolder, file.path) : guid.slice(0, 8);
	}

	private resolveAuthorName(userId: string | undefined): string {
		if (!userId) return "";
		if (this.sharedFolder.isLocalUserId(userId)) return "you";
		const knownUserName = this.sharedFolder.getUserDisplayName(userId);
		if (knownUserName) return knownUserName;
		const awareness = this.sharedFolder._provider?.awareness;
		if (awareness) {
			for (const [, state] of awareness.getStates()) {
				const user = state?.user;
				if (user?.id === userId && user?.name) {
					return user.name;
				}
			}
		}
		return "";
	}

	private notify(): void {
		const entries = this.entries();
		for (const subscriber of this.subscribers) {
			subscriber(entries);
		}
	}
}

const activityStores = new WeakMap<SharedFolder, SyncStatusActivityStore>();

export function getSyncStatusActivityStore(
	sharedFolder: SharedFolder,
	timeProvider: TimeProvider,
): SyncStatusActivityStore {
	let store = activityStores.get(sharedFolder);
	if (!store) {
		store = new SyncStatusActivityStore(sharedFolder, timeProvider);
		activityStores.set(sharedFolder, store);
	}
	return store;
}

function describeStatus(status: string): string {
	switch (status) {
		case "synced":
			return "Synced";
		case "pending":
			return "Queued";
		case "conflict":
			return "Conflict detected";
		case "error":
			return "Error";
		default:
			return status;
	}
}

function relativePath(sharedFolder: SharedFolder, fullPath: string): string {
	if (fullPath.startsWith("/")) {
		return fullPath.slice(1);
	}
	if (fullPath.startsWith(sharedFolder.path + "/")) {
		return fullPath.slice(sharedFolder.path.length + 1);
	}
	return fullPath;
}
