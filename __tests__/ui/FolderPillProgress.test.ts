import {
	shouldShowCompletedFolderPillProgress,
	shouldUseUserVisibleFolderProgress,
} from "../../src/BackgroundSyncProgress";

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
	});
});
