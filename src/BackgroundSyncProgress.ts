export interface FolderPillProgressDecisionInput {
	hasQueuedOrActiveWork: boolean;
	userDownloads: number;
	completedUserDownloads: number;
	failedUserDownloads: number;
}

export function shouldShowCompletedFolderPillProgress(
	input: FolderPillProgressDecisionInput,
): boolean {
	return !input.hasQueuedOrActiveWork;
}

export function shouldUseUserVisibleFolderProgress(
	input: FolderPillProgressDecisionInput,
): boolean {
	const visibleDownloadsFinished =
		input.completedUserDownloads + input.failedUserDownloads;
	return (
		input.userDownloads > 0 &&
		visibleDownloadsFinished < input.userDownloads
	);
}
