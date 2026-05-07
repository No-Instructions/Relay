import type { QueueItem } from "../../src/BackgroundSync";
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

	test("recent activity hides ambiguous pending and actionable rows", () => {
		expect(shouldShowRecentActivity("synced", "")).toBe(true);
		expect(shouldShowRecentActivity("synced", "you")).toBe(false);
		expect(shouldShowRecentActivity("pending", "")).toBe(false);
		expect(shouldShowRecentActivity("conflict", "")).toBe(false);
		expect(shouldShowRecentActivity("error", "")).toBe(false);
	});
});
