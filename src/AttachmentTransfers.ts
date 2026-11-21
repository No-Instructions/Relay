import { Platform, type Vault } from "obsidian";
import { Observable } from "./observable/Observable";
import { flags } from "./flagManager";
import type { NamespacedSettings } from "./SettingsStorage";
import { AttachmentCancelledError, checkAttachmentAbort } from "./AttachmentIO";

const TRANSFER_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PARTIAL_FILE = new RegExp(`\\.relay-${TRANSFER_ID}\\.(download|upload)$`);
const TARGET_MARKER = new RegExp(`\\.relay-${TRANSFER_ID}\\.download\\.target$`);
const DESTINATION_TEMPORARY = new RegExp(`^\\.relay-${TRANSFER_ID}\\.download$`);
const DEFAULT_ATTACHMENT_LIMIT = 20 * 1024 * 1024;
export interface UploadLimitSettings {
	uploadLimit?: number;
}
type LimitSettings = Pick<NamespacedSettings<UploadLimitSettings>, "get" | "set">;

function validLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

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
		super("File is too large.");
	}
}
export class AttachmentTransfers extends Observable<AttachmentTransfers> {
	readonly rows = new Map<string, AttachmentTransfer>();
	readonly directory: string;
	private tail: Promise<unknown> = Promise.resolve();
	private readonly sizeOverrides = new Map<string, number>();
	private savedUploadLimit?: number;
	private pendingSave: Promise<void> = Promise.resolve();
	constructor(readonly vault: Vault, pluginId: string, private readonly settings: LimitSettings) {
		super("Attachment transfers");
		this.directory = `${vault.configDir}/plugins/${pluginId}/downloads`;
		this.savedUploadLimit = settings.get().uploadLimit;
	}
	get maxBytes(): number {
		return Platform.isMobile ? DEFAULT_ATTACHMENT_LIMIT : 0;
	}
	get uploadLimit(): number {
		return validLimit(this.savedUploadLimit) ? this.savedUploadLimit : this.maxBytes;
	}
	async setUploadLimit(bytes: number, key: string): Promise<void> {
		if (!validLimit(bytes)) throw new Error("Invalid upload limit");
		const save = this.pendingSave.then(async () => {
			await this.settings.set({ uploadLimit: bytes });
			this.savedUploadLimit = bytes;
		});
		this.pendingSave = save.catch(() => {});
		await save;
		const row = this.rows.get(key);
		if (row?.phase === "blocked" && row.limitSource === "upload" && row.total !== undefined && !this.exceedsDeviceLimit(key, row.total, bytes)) {
			this.retry(key);
		}
		this.notifyListeners();
	}
	shouldStreamUpload(size: number): boolean {
		return !Platform.isMobile && Platform.isDesktopApp && flags().enableStreamingUploads &&
			size > DEFAULT_ATTACHMENT_LIMIT && typeof (this.vault.adapter as { getFullPath?: unknown }).getFullPath === "function";
	}
	hasSizeOverride(key: string, size: number): boolean {
		return size <= (this.sizeOverrides.get(key) ?? -1);
	}
	/** Whether transferring `size` bytes for `key` would be refused by this device's limit. */
	exceedsDeviceLimit(key: string, size: number, limit = this.maxBytes): boolean {
		return flags().enableAttachmentSizeLimit && limit > 0 && size > limit && !this.hasSizeOverride(key, size);
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
	check(task: AttachmentTask, size: number, options: { serverMaxBytes?: number; uploadSize?: number; mobileUpload?: boolean } = {}): void {
		if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid attachment size");
		const { serverMaxBytes, uploadSize = size, mobileUpload } = options;
		const serverBlocked = serverMaxBytes !== undefined && Number.isSafeInteger(serverMaxBytes) && serverMaxBytes >= 0 && uploadSize > serverMaxBytes;
		const deviceBlocked = this.exceedsDeviceLimit(task.key, size, mobileUpload ? this.uploadLimit : this.maxBytes);
		if (serverBlocked || deviceBlocked) {
			const error = new AttachmentLimitError(serverBlocked ? "server" : mobileUpload ? "upload" : "device");
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
		if (row?.phase === "blocked" && row.limitSource !== "server" &&
			!this.exceedsDeviceLimit(key, row.total ?? Infinity, row.limitSource === "upload" ? this.uploadLimit : this.maxBytes)) {
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
