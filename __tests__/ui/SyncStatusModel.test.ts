import type { QueueItem } from "../../src/BackgroundSync";
import type { FolderSyncSnapshot } from "../../src/BackgroundSyncProgress";
import {
	buildFolderSyncStatusModel,
	deriveFileSyncStatus,
	shouldShowRecentActivity,
	summarizeFolderQueue,
} from "../../src/ui/SyncStatusModel";

function queueItem(
	guid: string,
	path = "Vault/note.md",
	overrides: Partial<QueueItem> = {},
): QueueItem {
	return {
		guid,
		path,
		status: "pending",
		doc: {} as QueueItem["doc"],
		sharedFolder: {} as QueueItem["sharedFolder"],
		userVisible: false,
		...overrides,
	};
}

describe("SyncStatusModel", () => {
	test("only queue-backed file work is shown as syncing", () => {
		const queue = summarizeFolderQueue({
			isPaused: false,
			syncQueued: [queueItem("guid-a")],
		});

		expect(
			deriveFileSyncStatus({
				syncStatus: { status: "pending" },
				statePath: "idle.localAhead",
			}).status,
		).not.toBe("syncing");

		expect(
			deriveFileSyncStatus({
				syncStatus: { status: "pending" },
				statePath: "idle.localAhead",
				queueItem: queue.itemsByGuid.get("guid-a"),
			}).status,
		).toBe("syncing");
	});

	test("paused queue is a queue state and does not expose a syncing count", () => {
		const queue = summarizeFolderQueue({
			isPaused: true,
			syncQueued: [queueItem("guid-a")],
			downloadQueued: [queueItem("guid-b", "Vault/other.md")],
		});

		expect(queue.runState).toBe("stopped");
		expect(queue.label).toBe("Paused");
		expect(queue.total).toBe(2);
		expect(queue.showSyncingCount).toBe(false);
	});

	test("empty running queue is labeled synced", () => {
		const queue = summarizeFolderQueue({
			isPaused: false,
		});

		expect(queue.runState).toBe("idle");
		expect(queue.label).toBe("Synced");
		expect(queue.showSyncingCount).toBe(false);
	});

	test("conflict data wins over generic pending state", () => {
		const status = deriveFileSyncStatus({
			syncStatus: { status: "pending" },
			statePath: "idle.conflict",
			hasConflictData: true,
		});

		expect(status.status).toBe("conflict");
		expect(status.category).toBe("conflict");
		expect(status.actionable).toBe(true);
	});

	test("idle.diverged without conflict data is not surfaced as an error", () => {
		const status = deriveFileSyncStatus({
			syncStatus: { status: "pending" },
			statePath: "idle.diverged",
			hasConflictData: false,
		});

		expect(status.status).not.toBe("error");
		expect(status.category).toBeNull();
		expect(status.actionable).toBe(false);
	});

	test("background sync failures are surfaced as dismissible errors", () => {
		const sharedFolder = {
			files: new Map(),
			backgroundSync: {
				pendingSyncs: [],
				pendingDownloads: [],
				activeSync: { filter: () => [] },
				activeDownloads: { filter: () => [] },
				getQueueStatus: () => ({
					syncsQueued: 0,
					syncsActive: 0,
					downloadsQueued: 0,
					downloadsActive: 0,
					isPaused: false,
				}),
				getFailures: () => [
					{
						id: "sync:canvas-guid",
						guid: "canvas-guid",
						path: "/canvas.canvas",
						kind: "sync",
						message: "Canvas file does not match local sync state.",
						sharedFolder: null,
					},
				],
			},
			getPath: (path: string) => path,
		} as any;

		const model = buildFolderSyncStatusModel(sharedFolder);

		expect(model.snapshot).toEqual(
			expect.objectContaining({
				visibleState: "sync-issue",
				label: "Sync issue",
				progressStatus: "failed",
			}),
		);
		expect(model.actionableFiles).toEqual([
			expect.objectContaining({
				id: "sync:canvas-guid",
				guid: "canvas-guid",
				path: "/canvas.canvas",
				category: "error",
				label: "Canvas file does not match local sync state.",
				source: "backgroundSync",
			}),
		]);

		const dismissed = buildFolderSyncStatusModel(
			sharedFolder,
			new Set(["sync:canvas-guid"]),
		);
		expect(dismissed.actionableFiles).toHaveLength(0);
	});

	test("normalizes background sync object-string failure messages", () => {
		const sharedFolder = {
			files: new Map(),
			backgroundSync: {
				pendingSyncs: [],
				pendingDownloads: [],
				activeSync: { filter: () => [] },
				activeDownloads: { filter: () => [] },
				getQueueStatus: () => ({
					syncsQueued: 0,
					syncsActive: 0,
					downloadsQueued: 0,
					downloadsActive: 0,
					isPaused: false,
				}),
				getFailures: () => [
					{
						id: "sync:object-guid",
						guid: "object-guid",
						path: "/object.md",
						kind: "sync",
						message: "[object Object]",
						sharedFolder: null,
					},
				],
			},
			getPath: (path: string) => path,
		} as any;

		const model = buildFolderSyncStatusModel(sharedFolder);

		expect(model.actionableFiles).toEqual([
			expect.objectContaining({
				label: "Sync failed",
			}),
		]);
	});

	test("normalizes HSM object error payloads", () => {
		const sharedFolder = {
			files: new Map([
				[
					"hsm-guid",
					{
						path: "/hsm.md",
						hsm: {
							statePath: "idle.error",
							state: {
								error: {
									response: {
										data: {
											message: "Unable to read local file",
										},
									},
								},
							},
							getSyncStatus: () => ({ status: "error" }),
						},
					},
				],
			]),
			backgroundSync: {
				pendingSyncs: [],
				pendingDownloads: [],
				activeSync: { filter: () => [] },
				activeDownloads: { filter: () => [] },
				getQueueStatus: () => ({
					syncsQueued: 0,
					syncsActive: 0,
					downloadsQueued: 0,
					downloadsActive: 0,
					isPaused: false,
				}),
				getFailures: () => [],
			},
			getPath: (path: string) => path,
		} as any;

		const model = buildFolderSyncStatusModel(sharedFolder);

		expect(model.snapshot).toEqual(
			expect.objectContaining({
				visibleState: "sync-issue",
				label: "Sync issue",
				failureCount: 1,
				latestActivity: "1 sync issue",
			}),
		);
		expect(model.actionableFiles).toEqual([
			expect.objectContaining({
				guid: "hsm-guid",
				category: "error",
				label: "Unable to read local file",
			}),
		]);
	});

	test("keeps active sync activity visible while errors are listed", () => {
		const activeItem = queueItem("active-guid", "/Folder/current.md");
		const sharedFolder = {
			files: new Map([
				[
					"hsm-guid",
					{
						path: "/hsm.md",
						hsm: {
							statePath: "idle.error",
							state: { error: new Error("Local document failed") },
							getSyncStatus: () => ({ status: "error" }),
						},
					},
				],
			]),
			backgroundSync: {
				pendingSyncs: [],
				pendingDownloads: [],
				activeSync: {
					filter: (predicate: (item: QueueItem) => boolean) =>
						[activeItem].filter(predicate),
				},
				activeDownloads: { filter: () => [] },
				getQueueStatus: () => ({
					syncsQueued: 0,
					syncsActive: 1,
					downloadsQueued: 0,
					downloadsActive: 0,
					isPaused: false,
				}),
				getFailures: () => [
					{
						id: "sync:canvas-guid",
						guid: "canvas-guid",
						path: "/canvas.canvas",
						kind: "sync",
						message: "Canvas file does not match local sync state.",
						sharedFolder: null,
					},
				],
				getFolderSyncSnapshot: () => ({
					percent: 0,
					syncPercent: 0,
					downloadPercent: 0,
					showProgress: false,
					progressStatus: "failed",
					visibleState: "syncing",
					label: "Syncing",
					latestActivity: "Syncing current.md",
					syncAction: "pause",
					queued: 0,
					active: 1,
					total: 0,
					failureCount: 1,
					isPaused: false,
				}),
			},
			getPath: (path: string) => path,
		} as any;
		activeItem.sharedFolder = sharedFolder;

		const model = buildFolderSyncStatusModel(sharedFolder);

		expect(model.snapshot).toEqual(
			expect.objectContaining({
				visibleState: "syncing",
				label: "Syncing",
				latestActivity: "Syncing current.md",
				syncAction: "pause",
				failureCount: 2,
			}),
		);
		expect(model.actionableFiles.filter((file) => file.category === "error"))
			.toHaveLength(2);
	});

	test("uses the background sync folder snapshot as the model source", () => {
		const folderSnapshot = {
			percent: 25,
			syncPercent: 25,
			downloadPercent: 0,
			showProgress: true,
			progressStatus: "running",
			visibleState: "queued",
			label: "Queued",
			latestActivity: "Waiting for connection",
			syncAction: null,
			queued: 1,
			active: 0,
			total: 4,
			failureCount: 0,
			isPaused: false,
		};
		const getFolderSyncSnapshot = jest.fn(() => folderSnapshot);
		const sharedFolder = {
			files: new Map(),
			backgroundSync: {
				pendingSyncs: [],
				pendingDownloads: [],
				activeSync: { filter: () => [] },
				activeDownloads: { filter: () => [] },
				getQueueStatus: () => ({
					syncsQueued: 0,
					syncsActive: 0,
					downloadsQueued: 0,
					downloadsActive: 0,
					isPaused: false,
				}),
				getFailures: () => [],
				getFolderSyncSnapshot,
			},
			getPath: (path: string) => path,
		} as any;

		const model = buildFolderSyncStatusModel(sharedFolder);

		expect(model.snapshot).toBe(folderSnapshot);
		expect(getFolderSyncSnapshot).toHaveBeenCalledWith(sharedFolder);
	});

	test("uses a provided display snapshot instead of recomputing raw folder state", () => {
		const rawSnapshot: FolderSyncSnapshot = {
			percent: 100,
			syncPercent: 100,
			downloadPercent: 100,
			showProgress: false,
			progressStatus: "completed",
			visibleState: "synced",
			label: "Synced",
			latestActivity: null,
			syncAction: "resync",
			queued: 0,
			active: 0,
			total: 1,
			failureCount: 0,
			isPaused: false,
		};
		const displaySnapshot: FolderSyncSnapshot = {
			...rawSnapshot,
			percent: 85,
			showProgress: true,
			progressStatus: "running",
			visibleState: "syncing",
			label: "Syncing",
			latestActivity: "Finalizing...",
			syncAction: null,
		};
		const getFolderSyncSnapshot = jest.fn(() => rawSnapshot);
		const sharedFolder = {
			files: new Map(),
			backgroundSync: {
				pendingSyncs: [],
				pendingDownloads: [],
				activeSync: { filter: () => [] },
				activeDownloads: { filter: () => [] },
				getQueueStatus: () => ({
					syncsQueued: 0,
					syncsActive: 0,
					downloadsQueued: 0,
					downloadsActive: 0,
					isPaused: false,
				}),
				getFailures: () => [],
				getFolderSyncSnapshot,
			},
			getPath: (path: string) => path,
		} as any;

		const model = buildFolderSyncStatusModel(
			sharedFolder,
			new Set(),
			displaySnapshot,
		);

		expect(model.snapshot).toBe(displaySnapshot);
		expect(getFolderSyncSnapshot).not.toHaveBeenCalled();
	});

	test("recent activity hides ambiguous pending and actionable rows", () => {
		expect(shouldShowRecentActivity("synced", "")).toBe(true);
		expect(shouldShowRecentActivity("synced", "you")).toBe(false);
		expect(shouldShowRecentActivity("pending", "")).toBe(false);
		expect(shouldShowRecentActivity("conflict", "")).toBe(false);
		expect(shouldShowRecentActivity("error", "")).toBe(false);
	});
});
