import {
	buildFolderSyncSnapshot,
	FolderSyncSnapshotSmoother,
	shouldShowCompletedFolderPillProgress,
	shouldUseUserVisibleFolderProgress,
	type FolderSyncSnapshot,
} from "../../src/BackgroundSyncProgress";
import type { TimeProvider } from "../../src/TimeProvider";

class ManualTimeProvider implements TimeProvider {
	private currentTime = 0;
	private nextTimerId = 1;
	private readonly timers = new Map<
		number,
		{ callback: () => void; runAt: number }
	>();

	now(): number {
		return this.currentTime;
	}

	setTimeout(callback: () => void, ms: number): number {
		const timerId = this.nextTimerId++;
		this.timers.set(timerId, {
			callback,
			runAt: this.currentTime + ms,
		});
		return timerId;
	}

	clearTimeout(timerId: number): void {
		this.timers.delete(timerId);
	}

	setInterval(callback: () => void, ms: number): number {
		return this.setTimeout(callback, ms);
	}

	clearInterval(timerId: number): void {
		this.clearTimeout(timerId);
	}

	destroy(): void {
		this.timers.clear();
	}

	debounce<T extends (...args: any[]) => void>(
		func: T,
		_delay: number = 0,
	): (...args: Parameters<T>) => void {
		return (...args: Parameters<T>) => func(...args);
	}

	advance(ms: number): void {
		const endTime = this.currentTime + ms;
		for (;;) {
			const next = Array.from(this.timers.entries())
				.filter(([, timer]) => timer.runAt <= endTime)
				.sort(([, a], [, b]) => a.runAt - b.runAt)[0];
			if (!next) break;
			const [timerId, timer] = next;
			this.currentTime = timer.runAt;
			this.timers.delete(timerId);
			timer.callback();
		}
		this.currentTime = endTime;
	}
}

describe("BackgroundSync folder pill progress", () => {
	test("hides stale failed group progress after the folder queue drains", () => {
		expect(
			shouldShowCompletedFolderPillProgress({
				hasQueuedOrActiveWork: false,
				userDownloads: 0,
				completedUserDownloads: 0,
				failedUserDownloads: 0,
			}),
		).toBe(true);
	});

	test("keeps showing progress while folder work is still queued", () => {
		expect(
			shouldShowCompletedFolderPillProgress({
				hasQueuedOrActiveWork: true,
				userDownloads: 0,
				completedUserDownloads: 0,
				failedUserDownloads: 0,
			}),
		).toBe(false);
	});

	test("prefers user-visible download progress only while visible downloads remain", () => {
		expect(
			shouldUseUserVisibleFolderProgress({
				hasQueuedOrActiveWork: true,
				userDownloads: 2,
				completedUserDownloads: 1,
				failedUserDownloads: 0,
			}),
		).toBe(true);

		expect(
			shouldUseUserVisibleFolderProgress({
				hasQueuedOrActiveWork: true,
				userDownloads: 2,
				completedUserDownloads: 1,
				failedUserDownloads: 1,
			}),
		).toBe(false);

		expect(
			shouldUseUserVisibleFolderProgress({
				hasQueuedOrActiveWork: true,
				userDownloads: 2,
				completedUserDownloads: 1,
				failedUserDownloads: 0,
				skippedUserDownloads: 1,
			}),
		).toBe(false);
	});

	test("builds a single syncing snapshot with filename activity", () => {
		const snapshot = buildFolderSyncSnapshot({
			group: {
				total: 4,
				completed: 1,
				status: "running",
				downloads: 2,
				syncs: 2,
				completedDownloads: 1,
				completedSyncs: 0,
				userDownloads: 2,
				completedUserDownloads: 1,
				failedUserDownloads: 0,
			},
			queued: 1,
			active: 1,
			isPaused: false,
			failureCount: 0,
			activeItem: { kind: "download", path: "Vault/Folder/note.md" },
			queuedReason: null,
		});

		expect(snapshot).toEqual(
			expect.objectContaining({
				percent: 50,
				downloadPercent: 50,
				progressStatus: "running",
				visibleState: "syncing",
				label: "Syncing",
				latestActivity: "Downloading note.md",
				syncAction: "pause",
			}),
		);
	});

	test("uses queued language without offering a sync action", () => {
		const snapshot = buildFolderSyncSnapshot({
			group: null,
			queued: 2,
			active: 0,
			isPaused: false,
			failureCount: 0,
			activeItem: null,
			queuedReason: "connection",
		});

		expect(snapshot).toEqual(
			expect.objectContaining({
				percent: 100,
				showProgress: false,
				progressStatus: "completed",
				visibleState: "queued",
				label: "Queued",
				latestActivity: "Waiting for connection",
				syncAction: null,
			}),
		);
	});

	test("counts failed and skipped items as terminal progress outcomes", () => {
		const snapshot = buildFolderSyncSnapshot({
			group: {
				total: 4,
				completed: 1,
				status: "failed",
				downloads: 2,
				syncs: 2,
				completedDownloads: 0,
				completedSyncs: 1,
				failedDownloads: 0,
				failedSyncs: 1,
				skippedDownloads: 1,
				skippedSyncs: 0,
				userDownloads: 0,
				completedUserDownloads: 0,
				failedUserDownloads: 0,
			},
			queued: 0,
			active: 1,
			isPaused: false,
			failureCount: 1,
			activeItem: { kind: "download", path: "Vault/Folder/other.md" },
			queuedReason: null,
		});

		expect(snapshot).toEqual(
			expect.objectContaining({
				percent: 75,
				syncPercent: 100,
				downloadPercent: 50,
				progressStatus: "failed",
				visibleState: "sync-issue",
				label: "Sync issue",
			}),
		);
	});

	test("shows folder checking activity during folder-level sync work", () => {
		const snapshot = buildFolderSyncSnapshot({
			group: null,
			queued: 0,
			active: 1,
			isPaused: false,
			failureCount: 0,
			folderActivity: "checking",
			activeItem: null,
			queuedReason: null,
		});

		expect(snapshot).toEqual(
			expect.objectContaining({
				percent: 0,
				progressStatus: "running",
				visibleState: "syncing",
				label: "Syncing",
				latestActivity: "Checking folder",
				syncAction: "pause",
			}),
		);
	});

	test("marks issue snapshots as failed even when no progress group exists", () => {
		const snapshot = buildFolderSyncSnapshot({
			group: null,
			queued: 0,
			active: 0,
			isPaused: false,
			failureCount: 1,
			activeItem: null,
			queuedReason: null,
		});

		expect(snapshot).toEqual(
			expect.objectContaining({
				percent: 100,
				progressStatus: "failed",
				visibleState: "sync-issue",
				label: "Sync issue",
				latestActivity: "1 sync issue",
				syncAction: "resync",
			}),
		);
	});

	test("does not offer resync when the folder cannot resync", () => {
		const snapshot = buildFolderSyncSnapshot({
			group: null,
			queued: 0,
			active: 0,
			isPaused: false,
			failureCount: 0,
			canResync: false,
			activeItem: null,
			queuedReason: null,
		});

		expect(snapshot).toEqual(
			expect.objectContaining({
				visibleState: "synced",
				label: "Synced",
				syncAction: null,
			}),
		);
	});

	test("does not emit unchanged smoothed folder snapshots", () => {
		const timeProvider = new ManualTimeProvider();
		const emitted: FolderSyncSnapshot[] = [];
		const smoother = new FolderSyncSnapshotSmoother(timeProvider, (snapshot) => {
			emitted.push(snapshot);
		});
		const buildSnapshot = (path: string) =>
			buildFolderSyncSnapshot({
				group: {
					total: 1,
					completed: 0,
					status: "running",
					downloads: 0,
					syncs: 1,
					completedDownloads: 0,
					completedSyncs: 0,
					userDownloads: 0,
					completedUserDownloads: 0,
					failedUserDownloads: 0,
				},
				queued: 0,
				active: 1,
				isPaused: false,
				failureCount: 0,
				activeItem: { kind: "sync", path },
				queuedReason: null,
			});

		const initialSnapshot = buildSnapshot("Folder/note.md");
		smoother.update(initialSnapshot);
		smoother.update({ ...initialSnapshot });
		smoother.update(buildSnapshot("Folder/note.md"));

		expect(emitted).toHaveLength(1);

		smoother.update(buildSnapshot("Folder/other.md"));

		expect(emitted).toHaveLength(2);
		expect(emitted[1].latestActivity).toBe("Syncing other.md");
	});

	test("keeps the visible folder state syncing while completed progress finishes animating", () => {
		const timeProvider = new ManualTimeProvider();
		const emitted: FolderSyncSnapshot[] = [];
		const smoother = new FolderSyncSnapshotSmoother(timeProvider, (snapshot) => {
			emitted.push(snapshot);
		});

		smoother.update(
			buildFolderSyncSnapshot({
				group: {
					total: 1,
					completed: 0,
					status: "running",
					downloads: 0,
					syncs: 1,
					completedDownloads: 0,
					completedSyncs: 0,
					userDownloads: 0,
					completedUserDownloads: 0,
					failedUserDownloads: 0,
				},
				queued: 0,
				active: 1,
				isPaused: false,
				failureCount: 0,
				activeItem: { kind: "sync", path: "Folder/note.md" },
				queuedReason: null,
			}),
		);

		smoother.update(
			buildFolderSyncSnapshot({
				group: {
					total: 1,
					completed: 1,
					status: "completed",
					downloads: 0,
					syncs: 1,
					completedDownloads: 0,
					completedSyncs: 1,
					userDownloads: 0,
					completedUserDownloads: 0,
					failedUserDownloads: 0,
				},
				queued: 0,
				active: 0,
				isPaused: false,
				failureCount: 0,
				activeItem: null,
				queuedReason: null,
			}),
		);

		timeProvider.advance(10);
		expect(emitted[emitted.length - 1]).toEqual(
			expect.objectContaining({
				percent: 1,
				showProgress: true,
				progressStatus: "running",
				visibleState: "syncing",
				label: "Syncing",
				latestActivity: "Finalizing...",
				syncAction: null,
			}),
		);

		timeProvider.advance(1000);
		expect(emitted[emitted.length - 1]).toEqual(
			expect.objectContaining({
				percent: 100,
				showProgress: false,
				progressStatus: "completed",
				visibleState: "synced",
				label: "Synced",
				latestActivity: null,
			}),
		);
	});

});
