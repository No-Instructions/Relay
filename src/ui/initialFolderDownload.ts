import type { TAbstractFile, Vault } from "obsidian";
import { SyncType, type Meta } from "../SyncTypes";
import type { TimeProvider } from "../TimeProvider";

export interface InitialDownloadProgress {
	percent: number;
	completed: number;
	total: number;
	complete: boolean;
	error?: unknown;
}

interface DownloadFolder {
	getPath(path: string): string;
	whenReady(): Promise<unknown>;
	syncStore: {
		forEach(callback: (meta: Meta, path: string) => void): void;
		subscribe(callback: () => void): () => void;
		typeRegistry: {
			canSync(path: string, meta?: Meta): boolean;
			getEnabledFileSyncTypes(): SyncType[];
		};
	};
}

/** Observe initial files reaching disk while background creation work runs. */
export function observeInitialFolderDownload(
	folder: DownloadFolder,
	vault: Pick<Vault, "getFileByPath" | "on" | "offref">,
	time: Pick<TimeProvider, "setTimeout" | "clearTimeout">,
	onProgress: (progress: InitialDownloadProgress) => void,
): () => void {
	let disposed = false;
	let ready = false;
	let error: unknown;
	let timer: number | undefined;
	const expected = new Set<string>();
	const completed = new Set<string>();

	function emit() {
		timer = undefined;
		if (disposed) return;
		const total = expected.size;
		const complete = ready && completed.size === total && !error;
		onProgress({
			percent: total ? (100 * completed.size) / total : complete ? 100 : 0,
			completed: completed.size,
			total,
			complete,
			...(error ? { error } : {}),
		});
	}
	function schedule() {
		if (!disposed && timer === undefined) timer = time.setTimeout(emit, 16);
	}
	function rebuild() {
		if (disposed) return;
		expected.clear();
		completed.clear();
		const enabledTypes = new Set(
			folder.syncStore.typeRegistry.getEnabledFileSyncTypes(),
		);
		folder.syncStore.forEach((meta, path) => {
			if (
				meta.type === SyncType.Folder ||
				!enabledTypes.has(meta.type) ||
				!folder.syncStore.typeRegistry.canSync(path, meta)
			)
				return;
			const diskPath = folder.getPath(path);
			expected.add(diskPath);
			if (vault.getFileByPath(diskPath)) completed.add(diskPath);
		});
		schedule();
	}
	function refresh(file: TAbstractFile) {
		if (disposed || !expected.has(file.path)) return;
		if (vault.getFileByPath(file.path)) completed.add(file.path);
		else completed.delete(file.path);
		schedule();
	}
	const unsubscribe = folder.syncStore.subscribe(rebuild);
	const refs = [
		vault.on("create", refresh),
		vault.on("modify", refresh),
		vault.on("delete", refresh),
		vault.on("rename", (file, oldPath) => {
			if (expected.has(oldPath)) {
				completed.delete(oldPath);
				schedule();
			}
			refresh(file);
		}),
	];
	rebuild();
	void folder
		.whenReady()
		.then(() => {
			if (disposed) return;
			ready = true;
			rebuild();
		})
		.catch((cause: unknown) => {
			if (disposed) return;
			error = cause;
			schedule();
		});
	return () => {
		disposed = true;
		unsubscribe();
		for (const ref of refs) vault.offref(ref);
		if (timer !== undefined) time.clearTimeout(timer);
	};
}
