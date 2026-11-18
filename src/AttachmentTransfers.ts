import { Platform, type Vault } from "obsidian";
import { Observable } from "./observable/Observable";
import { flags } from "./flagManager";
import { LocalStorage } from "./LocalStorage";
import { AttachmentCancelledError, checkAttachmentAbort } from "./AttachmentIO";

const TRANSFER_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PARTIAL_FILE = new RegExp(`\\.relay-${TRANSFER_ID}\\.(download|upload)$`);
const TARGET_MARKER = new RegExp(`\\.relay-${TRANSFER_ID}\\.download\\.target$`);
const DESTINATION_TEMPORARY = new RegExp(`^\\.relay-${TRANSFER_ID}\\.download$`);
const DEFAULT_UPLOAD_LIMIT = 20 * 1024 * 1024;
type LimitSource = "device" | "upload" | "server";

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
	limitSource?: LimitSource;
	controller?: AbortController;
}
export class AttachmentLimitError extends Error {
	constructor(readonly source: LimitSource = "device") {
		super({
			server: "Attachment exceeds the server file size limit",
			upload: "Attachment exceeds the upload limit on this device",
			device: "Attachment exceeds this device's size limit",
		}[source]);
	}
}
export class AttachmentTransfers extends Observable<AttachmentTransfers> {
	readonly rows = new Map<string, AttachmentTransfer>();
	readonly directory: string;
	private tail: Promise<unknown> = Promise.resolve();
	private readonly sizeOverrides = new Map<string, number>();
	private readonly storage: LocalStorage<number>;
	private hasSavedUploadLimit: boolean;
	uploadLimitBytes: number;
	maxBytes: number;
	constructor(readonly vault: Vault, pluginId: string, appId: string) {
		super("Attachment transfers");
		this.directory = `${vault.configDir}/plugins/${pluginId}/downloads`;
		this.storage = new LocalStorage<number>(`${appId}-${pluginId}/attachments`);
		const savedDeviceLimit = this.storage.get("maxBytes");
		const value = savedDeviceLimit ?? (Platform.isMobile ? DEFAULT_UPLOAD_LIMIT : 0);
		this.maxBytes = Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_UPLOAD_LIMIT;
		const uploadLimit = this.storage.get("uploadLimitBytes");
		if (uploadLimit !== undefined && Number.isSafeInteger(uploadLimit) && uploadLimit >= 0) {
			this.hasSavedUploadLimit = true;
			this.uploadLimitBytes = uploadLimit;
		} else {
			this.hasSavedUploadLimit = false;
			this.uploadLimitBytes = savedDeviceLimit === undefined ? DEFAULT_UPLOAD_LIMIT : this.maxBytes;
		}
	}
	get supportsDesktopUploads(): boolean {
		return Platform.isDesktopApp && typeof (this.vault.adapter as { getFullPath?: unknown })?.getFullPath === "function";
	}
	get streamLargeUploads(): boolean {
		// A device with an explicit cap keeps holding oversized files until its user chooses streaming.
		const { enableStreamingUploads, enableAttachmentSizeLimit } = flags();
		return enableStreamingUploads && (this.hasSavedUploadLimit || !this.maxBytes || !enableAttachmentSizeLimit);
	}
	setUploadLimitBytes(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid upload limit");
		this.storage.set("uploadLimitBytes", bytes);
		this.hasSavedUploadLimit = true;
		this.uploadLimitBytes = bytes;
		for (const row of Array.from(this.rows.values())) {
			if (row.limitSource === "upload" && row.total !== undefined && !this.blocksUpload(row.key, row.total)) {
				this.retry(row.key);
			}
		}
		this.notifyListeners();
	}
	shouldStreamUpload(size: number): boolean {
		return this.uploadLimitBytes > 0 && size > this.uploadLimitBytes && this.streamLargeUploads;
	}
	blocksUpload(key: string, size: number): boolean {
		return this.uploadLimitBytes > 0 && size > this.uploadLimitBytes && !this.streamLargeUploads && !this.hasSizeOverride(key, size);
	}
	setMaxBytes(value: number): void {
		if (!Number.isSafeInteger(value) || value < 0) { this.notifyListeners(); return; }
		this.storage.set("maxBytes", value);
		this.maxBytes = value;
		if (!this.hasSavedUploadLimit) this.uploadLimitBytes = value;
		this.notifyListeners();
	}
	hasSizeOverride(key: string, size: number): boolean {
		return size <= (this.sizeOverrides.get(key) ?? -1);
	}
	/** Whether transferring `size` bytes for `key` would be refused by this device's limit. */
	exceedsDeviceLimit(key: string, size: number): boolean {
		return flags().enableAttachmentSizeLimit && this.maxBytes > 0 && size > this.maxBytes && !this.hasSizeOverride(key, size);
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
	check(task: AttachmentTask, size: number, options: { serverMaxBytes?: number; uploadSize?: number; desktopUpload?: boolean } = {}): void {
		if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid attachment size");
		const { serverMaxBytes, uploadSize = size, desktopUpload } = options;
		const serverBlocked = serverMaxBytes !== undefined && Number.isSafeInteger(serverMaxBytes) && serverMaxBytes >= 0 && uploadSize > serverMaxBytes;
		const deviceBlocked = desktopUpload ? this.blocksUpload(task.key, size) : this.exceedsDeviceLimit(task.key, size);
		if (serverBlocked || deviceBlocked) {
			const error = new AttachmentLimitError(serverBlocked ? "server" : desktopUpload ? "upload" : "device");
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
		if (row?.phase === "blocked" && row.limitSource !== "server" && (row.limitSource === "upload"
			? !this.blocksUpload(key, row.total ?? Infinity) : !this.exceedsDeviceLimit(key, row.total ?? Infinity))) {
			this.rows.delete(key);
			this.notifyListeners();
			return false;
		}
		return row?.phase === "blocked";
	}
	async initialize(): Promise<void> {
		const adapter = this.vault.adapter;
		let contents;
		try {
			if (!(await adapter.exists(this.directory))) await adapter.mkdir(this.directory);
			contents = await adapter.list(this.directory);
		} catch (error) {
			console.warn("Attachment transfer cleanup could not inspect its staging directory", error);
			return;
		}
		for (const path of contents.files) {
			if (!TARGET_MARKER.test(path)) continue;
			try {
				const temporary = await adapter.read(path);
				const parts = temporary.split("/");
				const name = parts.at(-1) ?? "";
				const valid =
					!temporary.startsWith("/") &&
					!temporary.includes("\\") &&
					!parts.includes("..") &&
					DESTINATION_TEMPORARY.test(name);
				if (!valid) {
					await adapter.remove(path);
					continue;
				}
				if (await adapter.exists(temporary)) {
					await adapter.remove(temporary);
					await adapter.remove(path);
					continue;
				}
				const parent = parts.slice(0, -1).join("/");
				if (!parent || await adapter.exists(parent)) await adapter.remove(path);
			} catch (error) {
				console.warn(`Attachment transfer cleanup deferred ${path}`, error);
			}
		}
		for (const path of contents.files) {
			if (!PARTIAL_FILE.test(path)) continue;
			try {
				await adapter.remove(path);
			} catch (error) {
				console.warn(`Attachment transfer cleanup deferred ${path}`, error);
			}
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
