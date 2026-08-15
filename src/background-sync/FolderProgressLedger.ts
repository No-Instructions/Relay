import { Observable, type Unsubscriber } from "../observable/Observable";
import { ObservableMap } from "../observable/ObservableMap";
import type { SharedFolder } from "../SharedFolder";
import { isSyncFile } from "../SyncFile";
import type { FolderSyncWorkItemInput } from "../BackgroundSyncProgress";
import type { TransferOperation } from "./DeadlineRegistry";
import type { DirectionTerminal } from "./DirectionQueue";
import {
	createEmptySyncGroup,
	type BackgroundSyncFailure,
	type QueueItem,
	type SyncGroup,
} from "./types";

export interface FolderPassSelection {
	total: number;
	syncs: number;
	downloads: number;
	userDownloads: number;
}

/** The per-folder inputs a snapshot needs, all maintained incrementally. */
export interface FolderWorkState {
	group: SyncGroup | null;
	queued: number;
	active: number;
	activeItem: FolderSyncWorkItemInput | null;
	resyncActive: boolean;
	failureCount: number;
}

interface FolderAccount {
	queuedSyncs: number;
	queuedDownloads: number;
	activeSyncs: Set<QueueItem>;
	activeDownloads: Set<QueueItem>;
	resyncActive: boolean;
	/** The folder's current pass era; settles credit only a matching era. */
	passEpoch: number;
	changed: Observable<void>;
}

/**
 * The single accounting projection over queue lifecycle events. Owns the
 * per-folder progress counters (the SyncGroup map consumers observe), the
 * incrementally-maintained queued/active counts that make folder snapshots
 * O(1), the failure rows, and the per-folder change observables that keep
 * one folder's events from waking every folder's subscribers.
 *
 * Counters move only here, and only in response to a lifecycle event or an
 * explicit ledger operation — no enqueue path mutates them directly.
 */
export class FolderProgressLedger {
	readonly syncGroups = new ObservableMap<SharedFolder, SyncGroup>();
	private failures = new ObservableMap<string, BackgroundSyncFailure>(
		"BackgroundSyncEngine.failures",
	);
	private accounts = new Map<SharedFolder, FolderAccount>();

	private account(folder: SharedFolder): FolderAccount {
		let account = this.accounts.get(folder);
		if (!account) {
			account = {
				queuedSyncs: 0,
				queuedDownloads: 0,
				activeSyncs: new Set(),
				activeDownloads: new Set(),
				resyncActive: false,
				passEpoch: 0,
				changed: new Observable<void>("BackgroundSyncEngine.folder"),
			};
			this.accounts.set(folder, account);
		}
		return account;
	}

	private notifyFolder(folder: SharedFolder): void {
		this.accounts.get(folder)?.changed.notifyListeners();
	}

	/** Subscribe to one folder's work changes; other folders never fire it. */
	onFolderChanged(folder: SharedFolder, listener: () => void): Unsubscriber {
		return this.account(folder).changed.on(listener);
	}

	notifyAllFolders(): void {
		for (const account of this.accounts.values()) {
			account.changed.notifyListeners();
		}
	}

	// ---- lifecycle events ----

	admitted(operation: TransferOperation, item: QueueItem, preCounted: boolean): void {
		const folder = item.sharedFolder;
		const account = this.account(folder);
		item.passEpoch = account.passEpoch;
		if (operation === "sync") {
			account.queuedSyncs++;
		} else {
			account.queuedDownloads++;
		}
		if (!preCounted) {
			const group = this.syncGroups.get(folder) ?? createEmptySyncGroup(folder);
			group.total++;
			if (operation === "sync") {
				group.syncs++;
			} else {
				group.downloads++;
				if (item.userVisible) {
					group.userDownloads++;
				}
			}
			group.status = "running";
			this.syncGroups.set(folder, group);
		}
		this.notifyFolder(folder);
	}

	started(operation: TransferOperation, item: QueueItem): void {
		const account = this.account(item.sharedFolder);
		if (operation === "sync") {
			account.queuedSyncs = Math.max(0, account.queuedSyncs - 1);
			account.activeSyncs.add(item);
		} else {
			account.queuedDownloads = Math.max(0, account.queuedDownloads - 1);
			account.activeDownloads.add(item);
		}
		this.notifyFolder(item.sharedFolder);
	}

	settled(
		operation: TransferOperation,
		item: QueueItem,
		terminal: DirectionTerminal,
	): void {
		const folder = item.sharedFolder;
		const account = this.account(folder);
		this.retireItem(operation, account, item);

		// A straggler from an earlier era leaves the queued/active counts
		// but must not credit the current group: its totals never counted it.
		const group =
			item.passEpoch === account.passEpoch
				? this.syncGroups.get(folder)
				: undefined;
		if (group) {
			if (operation === "sync") {
				if (terminal === "completed") {
					group.completedSyncs++;
					group.completed++;
				} else if (terminal === "failed") {
					group.failedSyncs++;
				} else {
					group.skippedSyncs++;
				}
			} else {
				if (terminal === "completed") {
					group.completedDownloads++;
					group.completed++;
					if (item.userVisible) group.completedUserDownloads++;
				} else if (terminal === "failed") {
					group.failedDownloads++;
					if (item.userVisible) group.failedUserDownloads++;
				} else {
					group.skippedDownloads++;
					if (item.userVisible) group.skippedUserDownloads++;
				}
			}
			updateGroupTerminalStatus(group);
			this.syncGroups.set(folder, group);
		}
		this.notifyFolder(folder);
	}

	/**
	 * A retry re-entering the queue. Only a running item moves back from
	 * active to queued; an item admitted straight into the backoff path is
	 * already counted as queued and must not count twice.
	 */
	requeued(operation: TransferOperation, item: QueueItem): void {
		const account = this.account(item.sharedFolder);
		if (operation === "sync") {
			if (account.activeSyncs.delete(item)) {
				account.queuedSyncs++;
			}
		} else {
			if (account.activeDownloads.delete(item)) {
				account.queuedDownloads++;
			}
		}
		this.clearFailure(failureKey(operation, item.guid));
		this.notifyFolder(item.sharedFolder);
	}

	cancelledQueued(operation: TransferOperation, item: QueueItem): void {
		const folder = item.sharedFolder;
		const account = this.account(folder);
		if (operation === "sync") {
			account.queuedSyncs = Math.max(0, account.queuedSyncs - 1);
		} else {
			account.queuedDownloads = Math.max(0, account.queuedDownloads - 1);
		}
		const group =
			item.passEpoch === account.passEpoch
				? this.syncGroups.get(folder)
				: undefined;
		if (group) {
			group.total = Math.max(0, group.total - 1);
			if (operation === "sync") {
				group.syncs = Math.max(0, group.syncs - 1);
			} else {
				group.downloads = Math.max(0, group.downloads - 1);
				if (item.userVisible) {
					group.userDownloads = Math.max(0, group.userDownloads - 1);
				}
			}
			updateGroupTerminalStatus(group);
			this.syncGroups.set(folder, group);
		}
		this.notifyFolder(folder);
	}

	/**
	 * An item leaving the queues: active if it started, still queued if it
	 * was discarded during take-next (destroyed doc).
	 */
	private retireItem(
		operation: TransferOperation,
		account: FolderAccount,
		item: QueueItem,
	): void {
		if (operation === "sync") {
			if (!account.activeSyncs.delete(item)) {
				account.queuedSyncs = Math.max(0, account.queuedSyncs - 1);
			}
		} else {
			if (!account.activeDownloads.delete(item)) {
				account.queuedDownloads = Math.max(0, account.queuedDownloads - 1);
			}
		}
	}

	/**
	 * A folder pass replaces the folder's group so the pass's progress is
	 * scoped to its own selection instead of accumulating forever.
	 */
	beginFolderPass(folder: SharedFolder, selection: FolderPassSelection): void {
		this.account(folder).passEpoch++;
		const group = createEmptySyncGroup(folder);
		group.total = selection.total;
		group.syncs = selection.syncs;
		group.downloads = selection.downloads;
		group.userDownloads = selection.userDownloads;
		group.status = selection.total > 0 ? "pending" : "completed";
		this.syncGroups.set(folder, group);
		this.notifyFolder(folder);
	}

	/**
	 * A pass selecting an item already queued or in flight adopts it: the
	 * pass's totals count it, so its settle must credit this era.
	 */
	adoptIntoCurrentPass(item: QueueItem): void {
		item.passEpoch = this.account(item.sharedFolder).passEpoch;
	}

	finishFolderPassRegistration(folder: SharedFolder): void {
		const group = this.syncGroups.get(folder);
		if (!group) return;
		updateGroupTerminalStatus(group);
		this.syncGroups.set(folder, group);
		this.notifyFolder(folder);
	}

	// ---- snapshot input ----

	getFolderWorkState(folder: SharedFolder): FolderWorkState {
		const account = this.accounts.get(folder);
		if (!account) {
			return {
				group: this.syncGroups.get(folder) ?? null,
				queued: 0,
				active: 0,
				activeItem: null,
				resyncActive: false,
				failureCount: this.getFailures(folder).length,
			};
		}
		return {
			group: this.syncGroups.get(folder) ?? null,
			queued: account.queuedSyncs + account.queuedDownloads,
			active:
				account.activeSyncs.size +
				account.activeDownloads.size +
				(account.resyncActive ? 1 : 0),
			activeItem: this.activeItemFor(account),
			resyncActive: account.resyncActive,
			failureCount: this.getFailures(folder).length,
		};
	}

	private activeItemFor(account: FolderAccount): FolderSyncWorkItemInput | null {
		for (const item of account.activeDownloads) {
			return { kind: "download", path: item.path };
		}
		for (const item of account.activeSyncs) {
			return { kind: "sync", path: item.path };
		}
		return null;
	}

	// ---- failures ----

	setFailure(failure: BackgroundSyncFailure): void {
		const existing = this.failures.get(failure.id);
		if (
			existing &&
			existing.guid === failure.guid &&
			existing.path === failure.path &&
			existing.kind === failure.kind &&
			existing.message === failure.message &&
			existing.sharedFolder === failure.sharedFolder &&
			existing.retryable === failure.retryable
		) {
			// Keep the original recordedAt: an identical failure re-recorded
			// paces its reclaim from the first occurrence, not the latest.
			return;
		}
		this.failures.set(failure.id, failure);
		this.notifyFolder(failure.sharedFolder);
	}

	clearFailure(id: string): void {
		const existing = this.failures.get(id);
		if (!this.failures.delete(id)) return;
		if (existing) this.notifyFolder(existing.sharedFolder);
	}

	clearFailuresForFolder(folder: SharedFolder): void {
		for (const failure of this.failures.values()) {
			if (failure.sharedFolder === folder) {
				this.failures.delete(failure.id);
			}
		}
		this.notifyFolder(folder);
	}

	getFailures(folder: SharedFolder): BackgroundSyncFailure[] {
		this.clearVanishedFailures(folder);
		return this.failures
			.values()
			.filter((failure) => failure.sharedFolder === folder)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	allFailures(): BackgroundSyncFailure[] {
		return this.failures.values();
	}

	getFailure(id: string): BackgroundSyncFailure | undefined {
		return this.failures.get(id);
	}

	/**
	 * A failure survives only while its document is still registered. An
	 * external atomic write's temp file can register, fail a queued op with
	 * ENOENT, then unregister when the rename removes it — stranding a failure
	 * row for a path that resolves to no doc. Such a row is stale the moment its
	 * target is gone: drop it rather than let it hold the folder's "Sync issue"
	 * badge until a manual clear.
	 */
	private clearVanishedFailures(folder: SharedFolder): void {
		for (const failure of this.failures.values()) {
			if (failure.sharedFolder !== folder) continue;
			if (
				!folder.files.has(failure.guid) &&
				!folder.syncStore.getCommittedMeta(failure.path)
			) {
				this.failures.delete(failure.id);
			}
		}
	}

	/** Retryable attachment failures old enough for the reclaim pass. */
	reclaimableSyncFileFailures(
		now: number,
		reclaimIntervalMs: number,
	): BackgroundSyncFailure[] {
		return this.failures.values().filter((failure) => {
			if (failure.kind === "local" || !failure.retryable) return false;
			if (now - failure.recordedAt < reclaimIntervalMs) return false;
			const file = failure.sharedFolder.files.get(failure.guid);
			return isSyncFile(file) && !file.destroyed;
		});
	}

	// ---- resync marker ----

	beginResync(folder: SharedFolder): Unsubscriber {
		this.clearFailuresForFolder(folder);
		const account = this.account(folder);
		account.resyncActive = true;
		this.notifyFolder(folder);
		return () => {
			account.resyncActive = false;
			this.notifyFolder(folder);
		};
	}

	destroy(): void {
		for (const account of this.accounts.values()) {
			account.changed.destroy();
		}
		this.accounts.clear();
		this.syncGroups.destroy();
		this.failures.destroy();
	}
}

export function failureKey(
	kind: BackgroundSyncFailure["kind"] | TransferOperation,
	guid: string,
): string {
	return `${kind}:${guid}`;
}

function updateGroupTerminalStatus(group: SyncGroup): void {
	const finishedSyncs = Math.min(
		group.syncs,
		group.completedSyncs + group.failedSyncs + group.skippedSyncs,
	);
	const finishedDownloads = Math.min(
		group.downloads,
		group.completedDownloads + group.failedDownloads + group.skippedDownloads,
	);
	const finishedTotal = Math.min(group.total, finishedSyncs + finishedDownloads);
	const failures = group.failedSyncs + group.failedDownloads;
	if (finishedTotal >= group.total) {
		group.status = failures > 0 ? "failed" : "completed";
	} else if (failures > 0) {
		group.status = "failed";
	} else if (group.total > 0) {
		group.status = "running";
	} else {
		group.status = "completed";
	}
}
