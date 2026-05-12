import type { TimeProvider } from "./TimeProvider";

export interface FolderPillProgressDecisionInput {
	hasQueuedOrActiveWork: boolean;
	userDownloads: number;
	completedUserDownloads: number;
	failedUserDownloads: number;
	skippedUserDownloads?: number;
}

export type FolderSyncVisibleState =
	| "synced"
	| "syncing"
	| "queued"
	| "paused"
	| "sync-issue";

export type FolderSyncAction = "pause" | "resume" | "resync" | null;

export type FolderSyncProgressStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed";

export interface FolderSyncGroupInput {
	total: number;
	completed: number;
	status: FolderSyncProgressStatus;
	downloads: number;
	syncs: number;
	completedDownloads: number;
	completedSyncs: number;
	failedDownloads?: number;
	failedSyncs?: number;
	skippedDownloads?: number;
	skippedSyncs?: number;
	userDownloads: number;
	completedUserDownloads: number;
	failedUserDownloads: number;
	skippedUserDownloads?: number;
}

export interface FolderSyncWorkItemInput {
	kind: "sync" | "download";
	path: string;
}

export interface FolderSyncSnapshotInput {
	group?: FolderSyncGroupInput | null;
	queued: number;
	active: number;
	isPaused: boolean;
	failureCount: number;
	canResync?: boolean;
	folderActivity?: "checking" | null;
	activeItem?: FolderSyncWorkItemInput | null;
	queuedReason?:
		| "connection"
		| "reconnecting"
		| null;
}

export interface FolderSyncSnapshot {
	percent: number;
	syncPercent: number;
	downloadPercent: number;
	showProgress: boolean;
	progressStatus: FolderSyncProgressStatus;
	visibleState: FolderSyncVisibleState;
	label: "Synced" | "Syncing" | "Queued" | "Paused" | "Sync issue";
	latestActivity: string | null;
	syncAction: FolderSyncAction;
	queued: number;
	active: number;
	total: number;
	failureCount: number;
	isPaused: boolean;
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
		input.completedUserDownloads +
		input.failedUserDownloads +
		(input.skippedUserDownloads ?? 0);
	return (
		input.userDownloads > 0 &&
		visibleDownloadsFinished < input.userDownloads
	);
}

export function buildFolderSyncSnapshot(
	input: FolderSyncSnapshotInput,
): FolderSyncSnapshot {
	const progress = computeFolderProgress({
		group: input.group,
		queued: input.queued,
		active: input.active,
		isPaused: input.isPaused,
		failureCount: input.failureCount,
	});
	const visibleState = deriveVisibleState({
		isPaused: input.isPaused,
		active: input.active,
		queued: input.queued,
		failureCount: input.failureCount,
	});
	return {
		...progress,
		showProgress: shouldShowProgress(progress.percent, progress.progressStatus),
		visibleState,
		label: labelForVisibleState(visibleState),
		latestActivity: latestActivityForSnapshot(input, visibleState),
		syncAction: actionForVisibleState(
			visibleState,
			input.active + input.queued,
			input.canResync ?? true,
		),
		queued: input.queued,
		active: input.active,
		total: progress.total,
		failureCount: input.failureCount,
		isPaused: input.isPaused,
	};
}

const PROGRESS_TRANSITION_MS = 1000;

export class FolderSyncSnapshotSmoother {
	private latestSnapshot: FolderSyncSnapshot | null = null;
	private displayedPercent = 0;
	private targetPercent = 0;
	private progressTimer: number | null = null;
	private transitionStartedAt: number | null = null;
	private transitionEndsAt: number | null = null;
	private lastEmittedSnapshot: FolderSyncSnapshot | null = null;
	private hasBaseline = false;
	private hasProgressActivity = false;

	constructor(
		private readonly timeProvider: TimeProvider,
		private readonly emit: (snapshot: FolderSyncSnapshot) => void,
	) {}

	update(snapshot: FolderSyncSnapshot): void {
		const target = normalizeProgress(snapshot.percent);
		this.latestSnapshot = snapshot;

		if (!this.hasBaseline) {
			this.hasBaseline = true;
			this.displayedPercent = target;
			this.targetPercent = target;
			this.emitCurrent(false);
			return;
		}

		if (target < this.displayedPercent) {
			this.displayedPercent = target;
			this.targetPercent = target;
			this.hasProgressActivity = false;
			this.transitionStartedAt = null;
			this.transitionEndsAt = null;
			this.clearTimer();
			this.emitCurrent(false);
			return;
		}

		if (target !== this.targetPercent) {
			this.targetPercent = target;
			this.hasProgressActivity = true;
			if (this.transitionStartedAt === null) {
				this.transitionStartedAt = this.timeProvider.now();
				this.transitionEndsAt =
					this.transitionStartedAt + PROGRESS_TRANSITION_MS;
			}
			this.clearTimer();
			this.scheduleProgressStep();
			return;
		}

		this.emitCurrent();
	}

	destroy(): void {
		this.clearTimer();
	}

	private scheduleProgressStep(): void {
		if (!this.latestSnapshot) return;
		if (this.displayedPercent === this.targetPercent) {
			this.transitionStartedAt = null;
			this.transitionEndsAt = null;
			this.emitCurrent();
			return;
		}

		const remainingMs = Math.max(
			0,
			(this.transitionEndsAt ?? this.timeProvider.now()) -
				this.timeProvider.now(),
		);
		const remainingSteps = Math.abs(this.targetPercent - this.displayedPercent);
		const stepDelayMs =
			remainingMs > 0
				? Math.max(1, Math.ceil(remainingMs / remainingSteps))
				: 1;

		this.progressTimer = this.timeProvider.setTimeout(() => {
			this.progressTimer = null;
			this.advanceProgress();
		}, stepDelayMs);
	}

	private advanceProgress(): void {
		if (!this.latestSnapshot) return;
		if (this.displayedPercent === this.targetPercent) {
			this.scheduleProgressStep();
			return;
		}

		this.displayedPercent +=
			this.displayedPercent < this.targetPercent ? 1 : -1;
		this.emitCurrent();
		this.scheduleProgressStep();
	}

	private emitCurrent(forceHide = false): void {
		if (!this.latestSnapshot) return;
		const isFinalizing = this.isFinalizingProgress();
		const progressStatus = isFinalizing
			? "running"
			: this.latestSnapshot.progressStatus;
		const visibleState = isFinalizing
			? "syncing"
			: this.latestSnapshot.visibleState;
		const next = {
			...this.latestSnapshot,
			percent: this.displayedPercent,
			progressStatus,
			visibleState,
			label: isFinalizing ? "Syncing" : this.latestSnapshot.label,
			latestActivity: isFinalizing
				? (this.latestSnapshot.latestActivity ?? "Finalizing...")
				: this.latestSnapshot.latestActivity,
			syncAction: isFinalizing ? null : this.latestSnapshot.syncAction,
			showProgress:
				!forceHide &&
				this.hasProgressActivity &&
				shouldShowProgress(this.displayedPercent, progressStatus),
		};
		if (shallowFolderSyncSnapshotEqual(this.lastEmittedSnapshot, next)) return;
		this.lastEmittedSnapshot = { ...next };
		this.emit(next);
	}

	private isFinalizingProgress(): boolean {
		if (!this.latestSnapshot) return false;
		if (!this.hasProgressActivity) return false;
		if (this.displayedPercent === this.targetPercent) return false;
		return this.latestSnapshot.visibleState === "synced";
	}

	private clearTimer(): void {
		if (this.progressTimer === null) return;
		this.timeProvider.clearTimeout(this.progressTimer);
		this.progressTimer = null;
	}
}

function normalizeProgress(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function shallowFolderSyncSnapshotEqual(
	a: FolderSyncSnapshot | null,
	b: FolderSyncSnapshot,
): boolean {
	if (a === null) return false;
	const aKeys = Object.keys(a) as Array<keyof FolderSyncSnapshot>;
	const bKeys = Object.keys(b) as Array<keyof FolderSyncSnapshot>;
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
		if (!Object.is(a[key], b[key])) return false;
	}
	return true;
}

function shouldShowProgress(
	percent: number,
	status: FolderSyncProgressStatus,
): boolean {
	return (
		percent > 0 &&
		(status === "running" ||
			status === "failed" ||
			(status === "completed" && percent < 100))
	);
}

function computeFolderProgress(input: {
	group?: FolderSyncGroupInput | null;
	queued: number;
	active: number;
	isPaused: boolean;
	failureCount: number;
}): Pick<
	FolderSyncSnapshot,
	"percent" | "syncPercent" | "downloadPercent" | "progressStatus" | "total"
> {
	const hasQueuedOrActiveWork = input.queued + input.active > 0;
	const queuedWithoutActiveWork =
		!input.isPaused && input.active === 0 && input.queued > 0;
	const group = input.group;
	if (!group) {
		return {
			percent: hasQueuedOrActiveWork && !queuedWithoutActiveWork ? 0 : 100,
			syncPercent: hasQueuedOrActiveWork && !queuedWithoutActiveWork ? 0 : 100,
			downloadPercent:
				hasQueuedOrActiveWork && !queuedWithoutActiveWork ? 0 : 100,
			progressStatus:
				input.failureCount > 0
					? "failed"
					: hasQueuedOrActiveWork && !queuedWithoutActiveWork
						? "running"
						: "completed",
			total: 0,
		};
	}

	if (queuedWithoutActiveWork) {
		return {
			percent: 100,
			syncPercent: 100,
			downloadPercent: 100,
			progressStatus: input.failureCount > 0 ? "failed" : "completed",
			total: group.total,
		};
	}

	const progressInput: FolderPillProgressDecisionInput = {
		hasQueuedOrActiveWork,
		userDownloads: group.userDownloads,
		completedUserDownloads: group.completedUserDownloads,
		failedUserDownloads: group.failedUserDownloads,
		skippedUserDownloads: group.skippedUserDownloads,
	};

	if (shouldShowCompletedFolderPillProgress(progressInput)) {
		return {
			percent: 100,
			syncPercent: 100,
			downloadPercent: 100,
			progressStatus: input.failureCount > 0 ? "failed" : "completed",
			total: group.total,
		};
	}

	if (shouldUseUserVisibleFolderProgress(progressInput)) {
		const total = group.userDownloads;
		const finished =
			group.completedUserDownloads +
			group.failedUserDownloads +
			(group.skippedUserDownloads ?? 0);
		const percent = total > 0 ? (finished / total) * 100 : 0;
		const progressStatus =
			finished === total
				? group.failedUserDownloads > 0
					? "failed"
					: "completed"
				: group.status === "failed"
					? "failed"
					: "running";
		return {
			percent: Math.round(percent),
			syncPercent: 0,
			downloadPercent: Math.round(percent),
			progressStatus,
			total: group.total,
		};
	}

	const terminal = terminalCounts(group);
	const percent = group.total > 0 ? (terminal.total / group.total) * 100 : 0;
	const syncPercent =
		group.syncs > 0 ? (terminal.syncs / group.syncs) * 100 : 0;
	const downloadPercent =
		group.downloads > 0
			? (terminal.downloads / group.downloads) * 100
			: 0;
	const progressStatus =
		terminal.total >= group.total
			? terminal.failed > 0
				? "failed"
				: "completed"
			: group.status;
	return {
		percent: Math.round(percent),
		syncPercent: Math.round(syncPercent),
		downloadPercent: Math.round(downloadPercent),
		progressStatus,
		total: group.total,
	};
}

function terminalCounts(group: FolderSyncGroupInput): {
	total: number;
	syncs: number;
	downloads: number;
	failed: number;
} {
	const failedSyncs = group.failedSyncs ?? 0;
	const failedDownloads = group.failedDownloads ?? 0;
	const skippedSyncs = group.skippedSyncs ?? 0;
	const skippedDownloads = group.skippedDownloads ?? 0;
	const syncs = Math.min(
		group.syncs,
		group.completedSyncs + failedSyncs + skippedSyncs,
	);
	const downloads = Math.min(
		group.downloads,
		group.completedDownloads + failedDownloads + skippedDownloads,
	);
	return {
		total: Math.min(group.total, syncs + downloads),
		syncs,
		downloads,
		failed: failedSyncs + failedDownloads,
	};
}

function deriveVisibleState(input: {
	isPaused: boolean;
	active: number;
	queued: number;
	failureCount: number;
}): FolderSyncVisibleState {
	if (input.isPaused) return "paused";
	if (input.failureCount > 0) return "sync-issue";
	if (input.active > 0) return "syncing";
	if (input.queued > 0) return "queued";
	return "synced";
}

function labelForVisibleState(
	visibleState: FolderSyncVisibleState,
): FolderSyncSnapshot["label"] {
	switch (visibleState) {
		case "syncing":
			return "Syncing";
		case "queued":
			return "Queued";
		case "paused":
			return "Paused";
		case "sync-issue":
			return "Sync issue";
		case "synced":
		default:
			return "Synced";
	}
}

function actionForVisibleState(
	visibleState: FolderSyncVisibleState,
	workCount: number,
	canResync: boolean,
): FolderSyncAction {
	if (visibleState === "syncing") return "pause";
	if (visibleState === "paused" && workCount > 0) return "resume";
	if (
		canResync &&
		(visibleState === "synced" || visibleState === "sync-issue")
	) {
		return "resync";
	}
	return null;
}

function latestActivityForSnapshot(
	input: FolderSyncSnapshotInput,
	visibleState: FolderSyncVisibleState,
): string | null {
	if (visibleState === "syncing" && input.activeItem) {
		const filename = filenameFromPath(input.activeItem.path);
		return input.activeItem.kind === "download"
			? `Downloading ${filename}`
			: `Syncing ${filename}`;
	}
	if (visibleState === "syncing" && input.folderActivity === "checking") {
		return "Checking folder";
	}
	if (visibleState === "queued") {
		switch (input.queuedReason) {
			case "connection":
				return "Waiting for connection";
			case "reconnecting":
				return "Reconnecting";
			default:
				return "Queued";
		}
	}
	if (visibleState === "paused") return "Sync paused";
	if (visibleState === "sync-issue") {
		return input.failureCount === 1
			? "1 sync issue"
			: `${input.failureCount} sync issues`;
	}
	return null;
}

function filenameFromPath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	return parts[parts.length - 1] || normalized || "file";
}
