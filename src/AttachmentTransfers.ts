import { Platform, type Vault } from "obsidian";
import { Observable } from "./observable/Observable";
import { flags } from "./flagManager";
import { LocalStorage } from "./LocalStorage";
import { AttachmentCancelledError, checkAttachmentAbort } from "./AttachmentIO";

export interface AttachmentTask {
	key: string;
	path: string;
	retry: () => Promise<unknown>;
}
export interface AttachmentTransfer extends AttachmentTask {
	phase: string;
	bytes: number;
	total?: number;
	error?: string;
	limitSource?: "device" | "server";
	controller?: AbortController;
}
export class AttachmentLimitError extends Error {
	constructor(readonly source: "device" | "server" = "device") { super(source === "server" ? "Attachment exceeds the server file size limit" : "Attachment exceeds this device's size limit"); }
}
export class AttachmentTransfers extends Observable<AttachmentTransfers> {
	readonly rows = new Map<string, AttachmentTransfer>();
	readonly directory: string;
	private tail: Promise<unknown> = Promise.resolve();
	private readonly sizeOverrides = new Map<string, number>();
	private readonly storage: LocalStorage<number>;
	maxBytes: number;
	constructor(readonly vault: Vault, pluginId: string, appId: string) {
		super("Attachment transfers");
		this.directory = `${vault.configDir}/plugins/${pluginId}/downloads`;
		this.storage = new LocalStorage<number>(`${appId}-${pluginId}/attachments`);
		const value = this.storage.get("maxBytes") ?? (Platform.isMobile ? 20 * 1024 * 1024 : 0);
		this.maxBytes = Number.isSafeInteger(value) && value >= 0 ? value : 20 * 1024 * 1024;
	}
	setMaxBytes(value: number): void {
		if (!Number.isSafeInteger(value) || value < 0) { this.notifyListeners(); return; }
		this.storage.set("maxBytes", value);
		this.maxBytes = value;
		this.notifyListeners();
	}
	hasSizeOverride(key: string, size: number): boolean {
		return size <= (this.sizeOverrides.get(key) ?? -1);
	}
	/** Approve only the reviewed size, for this one sync attempt. */
	async overrideAndRetry(key: string): Promise<void> {
		const row = this.rows.get(key);
		if (!row || row.controller || row.phase !== "blocked" || row.limitSource === "server" || row.total === undefined) return;
		this.sizeOverrides.set(key, row.total);
		this.rows.delete(key);
		this.notifyListeners();
		try {
			await row.retry();
		} catch {
			// The transfer or size check records the error for review.
		} finally {
			this.sizeOverrides.delete(key);
		}
	}
	check(task: AttachmentTask, size: number, serverMaxBytes?: number, uploadSize = size): void {
		if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid attachment size");
		const serverBlocked = serverMaxBytes !== undefined && Number.isSafeInteger(serverMaxBytes) && serverMaxBytes >= 0 && uploadSize > serverMaxBytes;
		const deviceBlocked = flags().enableAttachmentSizeLimit && this.maxBytes > 0 && size > this.maxBytes && !this.hasSizeOverride(task.key, size);
		if (serverBlocked || deviceBlocked) {
			const error = new AttachmentLimitError(serverBlocked ? "server" : "device");
			const row = this.rows.get(task.key);
			if (row?.phase === "blocked" && row.total === size && row.limitSource === error.source) throw error;
			if (row) { row.phase = "blocked"; row.error = error.message; row.total = size; row.limitSource = error.source; }
			else this.rows.set(task.key, { ...task, phase: "blocked", bytes: 0, total: size, error: error.message, limitSource: error.source });
			this.notifyListeners();
			throw error;
		}
		const row = this.rows.get(task.key);
		if (row?.phase === "blocked" && !row.controller) {
			this.rows.delete(task.key);
			if (!this.destroyed) this.notifyListeners();
		}
	}
	cancel(key: string): void {
		const row = this.rows.get(key);
		if (!row?.controller) return;
		row.controller.abort();
		row.phase = "cancelling";
		this.notifyListeners();
	}
	forget(key: string): void {
		this.sizeOverrides.delete(key);
		this.rows.get(key)?.controller?.abort();
		this.rows.delete(key);
		if (!this.destroyed) this.notifyListeners();
	}
	retry(key: string): void {
		const row = this.rows.get(key);
		if (!row || row.controller) return;
		this.rows.delete(key);
		this.notifyListeners();
		void row.retry().catch(() => {});
	}
	isHeld(key: string): boolean {
		const row = this.rows.get(key);
		if (row?.phase === "blocked" && row.limitSource !== "server" && (!flags().enableAttachmentSizeLimit || !this.maxBytes || (row.total ?? Infinity) <= this.maxBytes)) {
			this.rows.delete(key);
			this.notifyListeners();
			return false;
		}
		return row?.phase === "blocked";
	}
	async initialize(): Promise<void> {
		const adapter = this.vault.adapter;
		if (!(await adapter.exists(this.directory))) await adapter.mkdir(this.directory);
		const contents = await adapter.list(this.directory);
		for (const path of contents.files) {
			if (/\.relay-[a-f0-9-]+\.(download|upload)$/.test(path)) await adapter.remove(path);
		}
	}
	partialPath(task: AttachmentTask, extension = "download"): string {
		const name = task.path.split("/").pop()!.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
		return `${this.directory}/${name}.relay-${crypto.randomUUID()}.${extension}`;
	}
	async run<T>(task: AttachmentTask, operation: (row: AttachmentTransfer, signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.destroyed) throw new AttachmentCancelledError();
		if (this.rows.get(task.key)?.controller) throw new Error("Attachment transfer is already active or awaiting retry");
		const controller = new AbortController();
		const row: AttachmentTransfer = { ...task, phase: "queued", bytes: 0, controller };
		this.rows.set(task.key, row);
		this.notifyListeners();
		const result = this.tail.then(async () => {
			try {
				checkAttachmentAbort(controller.signal);
				const value = await operation(row, controller.signal);
				this.rows.delete(task.key);
				return value;
			} catch (error) {
				row.phase = controller.signal.aborted ? "cancelled" : error instanceof AttachmentLimitError ? "blocked" : "failed";
				row.error = controller.signal.aborted ? undefined : error instanceof Error ? error.message : "Attachment transfer failed";
				throw error;
			} finally {
				row.controller = undefined;
				if (!this.destroyed) this.notifyListeners();
			}
		});
		this.tail = result.catch(() => {});
		return result;
	}
	destroy(): void {
		for (const row of this.rows.values()) row.controller?.abort();
		this.rows.clear();
		this.sizeOverrides.clear();
		super.destroy();
	}
}
