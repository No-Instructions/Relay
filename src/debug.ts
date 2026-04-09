import type { TimeProvider } from "./TimeProvider";

type LogLevel = "debug" | "warn" | "log" | "error";

declare const BUILD_TYPE: string;

// Interfaces for dependency injection
export interface INotifier {
	notify(message: string): void;
}

export interface IFileAdapter {
	append(path: string, content: string): Promise<void>;
	stat(path: string): Promise<{ size: number } | null>;
	exists(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	write(path: string, content: string): Promise<void>;
	read(path: string): Promise<string>;
}

export const RelayInstances = new WeakMap();
let debugging = false;

export function setDebugging(debug: boolean) {
	debugging = debug;
}

interface LogConfig {
	maxFileSize: number;
	maxBackups: number;
	disableConsole: boolean;
	batchInterval: number;
	maxRetries: number;
	allowStackTraces: boolean;
}

let logConfig: LogConfig = {
	maxFileSize: 1024 * 1024, // 1MB
	maxBackups: 5,
	disableConsole: false,
	batchInterval: 1000, // 1 second
	maxRetries: 3,
	allowStackTraces: false, // Default to false to prevent memory leaks
};

let currentLogFile: string;
let fileAdapter: IFileAdapter;
const logBuffer: LogEntry[] = [];

type LogEntry = {
	timestamp: string;
	level: LogLevel;
	message: string;
	callerInfo: string;
};

export function initializeLogger(
	adapter: IFileAdapter,
	timeProvider: TimeProvider,
	logFilePath: string,
	config?: Partial<LogConfig>,
) {
	fileAdapter = adapter;
	currentLogFile = logFilePath;
	if (config) {
		logConfig = { ...logConfig, ...config };
	}
	timeProvider.setInterval(flushLogs, logConfig.batchInterval);
}

export async function flushLogs() {
	if (logBuffer.length === 0) return;

	const entries = [...logBuffer];
	logBuffer.length = 0;

	for (let retry = 0; retry < logConfig.maxRetries; retry++) {
		try {
			await rotateLogIfNeeded();
			const logContent = entries.map(formatLogEntry).join("\n") + "\n";
			await fileAdapter.append(currentLogFile, logContent);
			return;
		} catch (error) {
			console.error(`Failed to write logs (attempt ${retry + 1}):`, error);
			if (retry === logConfig.maxRetries - 1) {
				console.error("Max retries reached. Discarding log entries.");
			}
		}
	}
}

async function rotateLogIfNeeded(): Promise<void> {
	const stat = await fileAdapter.stat(currentLogFile);
	if (stat && stat.size > logConfig.maxFileSize) {
		for (let i = logConfig.maxBackups; i > 0; i--) {
			const oldFile = `${currentLogFile}.${i}`;
			const newFile = `${currentLogFile}.${i + 1}`;
			if (await fileAdapter.exists(oldFile)) {
				if (i === logConfig.maxBackups) {
					// Remove oldest backup - ignore if already deleted (race condition)
					try {
						await fileAdapter.remove(oldFile);
					} catch {
						// File may have been deleted by concurrent rotation
					}
				} else {
					// Remove destination first if it exists (Obsidian rename doesn't overwrite)
					try {
						await fileAdapter.remove(newFile);
					} catch {
						// Destination didn't exist, which is fine
					}
					try {
						await fileAdapter.rename(oldFile, newFile);
					} catch {
						// Source may have been moved by concurrent rotation
					}
				}
			}
		}

		if (await fileAdapter.exists(currentLogFile)) {
			// Remove destination first if it exists
			try {
				await fileAdapter.remove(`${currentLogFile}.1`);
			} catch {
				// Destination didn't exist, which is fine
			}
			try {
				await fileAdapter.rename(currentLogFile, `${currentLogFile}.1`);
			} catch {
				// Source may have been moved by concurrent rotation
			}
		}

		await fileAdapter.write(currentLogFile, "");
	}
}

function formatLogEntry(entry: LogEntry): string {
	return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}\n    at ${entry.callerInfo}`;
}

function createToastFunction(notifier: INotifier, debug: boolean) {
	return debug
		? (error: Error): Error => {
				notifier.notify(error.name + "\n" + error.message);
				return error;
			}
		: (error: Error): Error => {
				notifier.notify(
					error.name + ":\nAn error has occurred, please reload Obsidian.",
				);
				return error;
			};
}

const SENSITIVE_KEYS = ["token", "authorization", "email", "key"];

function serializeArg(arg: unknown): string {
	if (typeof arg === "object" && arg !== null) {
		const seen = new WeakSet();
		try {
			return JSON.stringify(
				arg,
				(key, value) => {
					if (typeof value === "object" && value !== null) {
						if (seen.has(value)) {
							return "[Circular]";
						}
						seen.add(value);
					}
					// Filter out sensitive information
					if (
						typeof key === "string" &&
						SENSITIVE_KEYS.some((sk) =>
							key.toLowerCase().includes(sk.toLowerCase()),
						)
					) {
						return "[REDACTED]";
					}
					if (value instanceof Error) {
						return {
							name: value.name,
							message: value.message,
							stack: value.stack
								?.split("\n")
								.map((line) => line.trim())
								.join(" "),
						};
					}
					return value;
				},
				2,
			);
		} catch (error) {
			if (error instanceof Error) {
				if (error instanceof RangeError) {
					// Handle stack overflow
					return `[Complex Object: ${Object.prototype.toString.call(arg)}]`;
				}
				return `[Unserializable: ${error.message}]`;
			}
			return "[Unknown Error]";
		}
	}
	return String(arg);
}

export function curryLog(initialText: string, level: LogLevel = "log") {
	return (...args: unknown[]) => {
		if (debugging) {
			const timestamp = new Date().toISOString();
			const stack = new Error().stack;
			const callerInfo = stack?.split("\n")[2]?.trim() ?? "";
			const serializedArgs = args.map(serializeArg).join(" ");

			const logEntry: LogEntry = {
				timestamp,
				level,
				message: `${initialText}: ${serializedArgs}`,
				callerInfo,
			};

			if (!logConfig.disableConsole) {
				if (logConfig.allowStackTraces || level === 'debug' || level === 'log') {
					console[level](formatLogEntry(logEntry));
				} else {
					const styles = {
						warn: 'color: #ff8c00; background: rgba(255, 140, 0, 0.1); font-weight: normal; padding: 1px 4px; border-radius: 2px;',
						error: 'color: #ff5555; background: rgba(255, 85, 85, 0.1); font-weight: normal; padding: 1px 4px; border-radius: 2px;'
					};
					console.log(`%c${formatLogEntry(logEntry)}`, styles[level]);
				}
			}

			logBuffer.push(logEntry);
		}
	};
}

export async function getAllLogFiles(): Promise<string[]> {
	const logFiles: string[] = [];

	if (await fileAdapter.exists(currentLogFile)) {
		logFiles.push(currentLogFile);
	}

	for (let i = 1; i <= logConfig.maxBackups; i++) {
		const backupFile = `${currentLogFile}.${i}`;
		if (await fileAdapter.exists(backupFile)) {
			logFiles.push(backupFile);
		}
	}

	return logFiles;
}

export async function getAllLogs(): Promise<string> {
	const logs: string[] = [];

	if (await fileAdapter.exists(currentLogFile)) {
		const currentContent = await fileAdapter.read(currentLogFile);
		logs.push(currentContent);
	}

	for (let i = 1; i <= logConfig.maxBackups; i++) {
		const backupFile = `${currentLogFile}.${i}`;
		if (await fileAdapter.exists(backupFile)) {
			const backupContent = await fileAdapter.read(backupFile);
			logs.push(backupContent);
		}
	}

	return logs.reverse().join("\n");
}

const BOOT_MARKER = "Plugin started";

/**
 * Parse raw log text into structured entries.
 * Each entry is two lines: `[timestamp] [LEVEL] message` followed by `    at callerInfo`.
 */
function parseLogEntries(text: string): LogEntry[] {
	const entries: LogEntry[] = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^\[([^\]]+)\] \[([A-Z]+)\] (.*)$/);
		if (match) {
			const callerLine = (i + 1 < lines.length && lines[i + 1].startsWith('    at '))
				? lines[i + 1].slice(7) // strip "    at "
				: '';
			entries.push({
				timestamp: match[1],
				level: match[2].toLowerCase() as LogLevel,
				message: match[3],
				callerInfo: callerLine,
			});
			if (callerLine) i++; // skip the caller line
		}
	}
	return entries;
}

export interface SessionLogOptions {
	level?: LogLevel | LogLevel[];
	pattern?: string;
}

/**
 * Get log entries from the current session (since last "Plugin started").
 * Reads disk files and appends the in-memory buffer (unflushed entries),
 * then finds the boot boundary and applies optional filters.
 */
export async function getSessionLogs(options?: SessionLogOptions): Promise<LogEntry[]> {
	if (!fileAdapter || !currentLogFile) return [];

	// Read all files oldest-first (reversed backups, then main)
	const chunks: string[] = [];
	for (let i = logConfig.maxBackups; i >= 1; i--) {
		const backupFile = `${currentLogFile}.${i}`;
		try {
			if (await fileAdapter.exists(backupFile)) {
				chunks.push(await fileAdapter.read(backupFile));
			}
		} catch { /* skip unreadable */ }
	}
	try {
		if (await fileAdapter.exists(currentLogFile)) {
			chunks.push(await fileAdapter.read(currentLogFile));
		}
	} catch { /* skip unreadable */ }

	// Disk entries + unflushed in-memory entries
	const allEntries = parseLogEntries(chunks.join('\n')).concat(logBuffer);

	// Find the last boot marker — everything from there is the current session
	let bootIndex = 0;
	for (let i = allEntries.length - 1; i >= 0; i--) {
		if (allEntries[i].message.includes(BOOT_MARKER)) {
			bootIndex = i;
			break;
		}
	}

	let entries = allEntries.slice(bootIndex);

	if (options?.level) {
		const levels = Array.isArray(options.level) ? options.level : [options.level];
		entries = entries.filter(e => levels.includes(e.level));
	}
	if (options?.pattern) {
		const re = new RegExp(options.pattern, 'i');
		entries = entries.filter(e => re.test(e.message) || re.test(e.callerInfo));
	}

	return entries;
}

export class HasLogging {
	protected debug;
	protected log;
	protected warn;
	protected error;

	constructor(context?: string) {
		const logContext = context || this.constructor.name;
		this.debug = curryLog(`[${logContext}]`, "debug");
		this.log = curryLog(`[${logContext}]`, "log");
		this.warn = curryLog(`[${logContext}]`, "warn");
		this.error = curryLog(`[${logContext}]`, "error");
	}

	protected setLoggers(context: string) {
		this.debug = curryLog(`[${context}]`, "debug");
		this.log = curryLog(`[${context}]`, "log");
		this.warn = curryLog(`[${context}]`, "warn");
		this.error = curryLog(`[${context}]`, "error");
	}
}

const debug = BUILD_TYPE === "debug";
export function createToast(notifier: INotifier) {
	return createToastFunction(notifier, debug);
}

// ============================================================================
// Metrics Integration (for obsidian-metrics plugin)
// ============================================================================

import type {
	IObsidianMetricsAPI,
	MetricInstance,
	ObsidianMetricsPlugin,
} from "./types/obsidian-metrics";

/**
 * Metrics for Relay - uses obsidian-metrics plugin if available, no-ops otherwise.
 *
 * Uses event-based initialization to handle plugin load order. The obsidian-metrics
 * plugin emits 'obsidian-metrics:ready' when loaded, and metric creation is idempotent.
 */
class RelayMetrics {
	private dbSize: MetricInstance | null = null;
	private compactions: MetricInstance | null = null;
	private compactionDuration: MetricInstance | null = null;

	// LiveViews
	private liveviewsRefresh: MetricInstance | null = null;
	private liveviewsQueueDepth: MetricInstance | null = null;

	// FolderNav
	private foldernavRefresh: MetricInstance | null = null;

	// Postie
	private postieDelivery: MetricInstance | null = null;
	private postieMailboxDepth: MetricInstance | null = null;
	private postieDeliveries: MetricInstance | null = null;

	// BackgroundSync
	private bgSyncOpSeconds: MetricInstance | null = null;
	private bgSyncActive: MetricInstance | null = null;
	private bgSyncQueueLength: MetricInstance | null = null;
	private bgSyncOpsTotal: MetricInstance | null = null;

	// Wake queue
	private wakeQueueSlots: MetricInstance | null = null;

	// Protocol IO
	private protocolMessageCount: MetricInstance | null = null;
	private protocolBytes: MetricInstance | null = null;

	/**
	 * Initialize metrics from the API. Called when obsidian-metrics becomes available.
	 * Safe to call multiple times - metric creation is idempotent.
	 */
	initializeFromAPI(api: IObsidianMetricsAPI): void {
		this.dbSize = api.createGauge({
			name: "relay_db_size",
			help: "Number of updates stored in IndexedDB per document",
			labelNames: ["document"],
		});
		this.compactions = api.createCounter({
			name: "relay_compactions_total",
			help: "Total compaction operations",
			labelNames: ["document"],
		});
		this.compactionDuration = api.createHistogram({
			name: "relay_compaction_duration_seconds",
			help: "Compaction duration in seconds",
			labelNames: ["document"],
			buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
		});

		// LiveViews
		this.liveviewsRefresh = api.createHistogram({
			name: "relay_liveviews_refresh_seconds",
			help: "LiveViews refresh duration in seconds",
			buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
		});
		this.liveviewsQueueDepth = api.createGauge({
			name: "relay_liveviews_refresh_queue_depth",
			help: "Number of pending refreshes in the LiveViews queue",
		});

		// FolderNav
		this.foldernavRefresh = api.createHistogram({
			name: "relay_foldernav_refresh_seconds",
			help: "FolderNav refresh duration in seconds",
			labelNames: ["scope"],
			buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
		});

		// Postie
		this.postieDelivery = api.createHistogram({
			name: "relay_postie_delivery_seconds",
			help: "PostOffice delivery batch duration in seconds",
			buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
		});
		this.postieMailboxDepth = api.createGauge({
			name: "relay_postie_mailbox_depth",
			help: "Number of recipients with pending mail when delivery fires",
		});
		this.postieDeliveries = api.createCounter({
			name: "relay_postie_deliveries_total",
			help: "Total individual recipient deliveries",
		});

		// BackgroundSync
		this.bgSyncOpSeconds = api.createHistogram({
			name: "relay_background_sync_op_seconds",
			help: "BackgroundSync operation duration in seconds",
			labelNames: ["operation"],
			buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
		});
		this.bgSyncActive = api.createGauge({
			name: "relay_background_sync_active",
			help: "Number of currently active background sync operations",
			labelNames: ["operation"],
		});
		this.bgSyncQueueLength = api.createGauge({
			name: "relay_background_sync_queue_length",
			help: "Number of items waiting in background sync queues",
			labelNames: ["operation"],
		});
		this.bgSyncOpsTotal = api.createCounter({
			name: "relay_background_sync_ops_total",
			help: "Total background sync operations by result",
			labelNames: ["operation", "result"],
		});

		// Wake queue
		this.wakeQueueSlots = api.createGauge({
			name: "relay_wake_queue_slots",
			help: "Wake queue slot utilization",
			labelNames: ["state"],
		});

		// Protocol IO
		this.protocolMessageCount = api.createCounter({
			name: "relay_protocol_message_count",
			help: "Sync protocol messages by type and direction",
			labelNames: ["type", "direction"],
		});
		this.protocolBytes = api.createCounter({
			name: "relay_protocol_bytes",
			help: "Sync protocol bytes by type and direction",
			labelNames: ["type", "direction"],
		});
	}

	// -- Existing metrics --

	setDbSize(document: string, count: number): void {
		this.dbSize?.labels({ document }).set(count);
	}

	recordCompaction(document: string, durationSeconds: number): void {
		this.compactions?.labels({ document }).inc();
		this.compactionDuration?.labels({ document }).observe(durationSeconds);
	}

	// -- LiveViews --

	observeLiveviewsRefresh(durationSeconds: number): void {
		this.liveviewsRefresh?.observe(durationSeconds);
	}

	setLiveviewsQueueDepth(depth: number): void {
		this.liveviewsQueueDepth?.set(depth);
	}

	// -- FolderNav --

	observeFoldernavRefresh(scope: "full" | "quick", durationSeconds: number): void {
		this.foldernavRefresh?.labels({ scope }).observe(durationSeconds);
	}

	// -- Postie --

	observePostieDelivery(durationSeconds: number): void {
		this.postieDelivery?.observe(durationSeconds);
	}

	setPostieMailboxDepth(depth: number): void {
		this.postieMailboxDepth?.set(depth);
	}

	incPostieDeliveries(): void {
		this.postieDeliveries?.inc();
	}

	// -- BackgroundSync --

	observeBgSyncOp(operation: "sync" | "download", durationSeconds: number): void {
		this.bgSyncOpSeconds?.labels({ operation }).observe(durationSeconds);
	}

	setBgSyncActive(operation: "sync" | "download", count: number): void {
		this.bgSyncActive?.labels({ operation }).set(count);
	}

	setBgSyncQueueLength(operation: "sync" | "download", length: number): void {
		this.bgSyncQueueLength?.labels({ operation }).set(length);
	}

	incBgSyncOps(operation: "sync" | "download", result: "completed" | "failed"): void {
		this.bgSyncOpsTotal?.labels({ operation, result }).inc();
	}

	// -- Protocol IO --

	recordProtocolMessage(type: "sync" | "event" | "subdoc_index", direction: "in" | "out", bytes: number): void {
		this.protocolMessageCount?.labels({ type, direction }).inc();
		this.protocolBytes?.labels({ type, direction }).inc(bytes);
	}

	// -- Wake queue --

	setWakeQueueSlots(used: number, pending: number, total: number): void {
		this.wakeQueueSlots?.labels({ state: "used" }).set(used);
		this.wakeQueueSlots?.labels({ state: "pending" }).set(pending);
		this.wakeQueueSlots?.labels({ state: "total" }).set(total);
	}
}

/**
 * Initialize metrics integration with Obsidian app.
 * Sets up event listener for obsidian-metrics:ready and checks if already available.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initializeMetrics(app: any, registerEvent: (eventRef: any) => void): void {
	// Listen for metrics API becoming available (or re-initializing after reload)
	registerEvent(
		app.workspace.on("obsidian-metrics:ready", (api: IObsidianMetricsAPI) => {
			metrics.initializeFromAPI(api);
		})
	);

	// Also try to get it immediately in case metrics plugin loaded first
	const metricsPlugin = app.plugins?.plugins?.["obsidian-metrics"] as
		| ObsidianMetricsPlugin
		| undefined;
	if (metricsPlugin?.api) {
		metrics.initializeFromAPI(metricsPlugin.api);
	}
}

/** Singleton metrics instance */
export const metrics = new RelayMetrics();

// ============================================================================
// HSM Recording (JSONL streaming to disk)
// ============================================================================

interface HSMRecordingConfig {
	maxFileSize: number;
	maxBackups: number;
	batchInterval: number;
}

const hsmRecordingConfig: HSMRecordingConfig = {
	maxFileSize: 5 * 1024 * 1024, // 5MB
	maxBackups: 3,
	batchInterval: 500, // 500ms - faster than relay.log for debugging
};

let hsmRecordingFile: string | null = null;
let hsmFileAdapter: IFileAdapter | null = null;
let hsmTimeProvider: TimeProvider | null = null;
let hsmFlushIntervalId: number | null = null;
let hsmBootId: string | null = null;
const hsmBuffer: string[] = [];

function generateBootId(): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let id = '';
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}

/**
 * Initialize HSM recording to disk.
 * Call this during plugin initialization if enableHSMRecording flag is set.
 */
export function initializeHSMRecording(
	adapter: IFileAdapter,
	timeProvider: TimeProvider,
	logFilePath: string,
	config?: Partial<HSMRecordingConfig>,
): void {
	hsmFileAdapter = adapter;
	hsmRecordingFile = logFilePath;
	hsmTimeProvider = timeProvider;
	hsmBootId = generateBootId();
	if (config) {
		Object.assign(hsmRecordingConfig, config);
	}
	hsmFlushIntervalId = timeProvider.setInterval(flushHSMRecording, hsmRecordingConfig.batchInterval);
}

/**
 * Stop HSM recording and flush remaining entries.
 */
export async function stopHSMRecording(): Promise<void> {
	if (hsmFlushIntervalId !== null && hsmTimeProvider) {
		hsmTimeProvider.clearInterval(hsmFlushIntervalId);
		hsmFlushIntervalId = null;
	}
	await flushHSMRecording();
	hsmRecordingFile = null;
	hsmFileAdapter = null;
	hsmTimeProvider = null;
	hsmBootId = null;
}

/**
 * Record an HSM entry. Called by the E2ERecordingBridge onEntry callback.
 * Adds boot ID to each entry for session grouping.
 */
export function recordHSMEntry(entry: object): void {
	if (!hsmRecordingFile || !hsmBootId) return;
	const entryWithBoot = { ...entry, boot: hsmBootId };
	hsmBuffer.push(JSON.stringify(entryWithBoot));
}

/**
 * Flush buffered HSM entries to disk.
 */
export async function flushHSMRecording(): Promise<void> {
	if (hsmBuffer.length === 0 || !hsmFileAdapter || !hsmRecordingFile) return;

	const entries = [...hsmBuffer];
	hsmBuffer.length = 0;

	try {
		await rotateHSMLogIfNeeded();
		const content = entries.join("\n") + "\n";
		await hsmFileAdapter.append(hsmRecordingFile, content);
	} catch (error) {
		console.error("[HSMRecording] Failed to write:", error);
		// Re-add entries to buffer on failure
		hsmBuffer.unshift(...entries);
	}
}

async function rotateHSMLogIfNeeded(): Promise<void> {
	if (!hsmFileAdapter || !hsmRecordingFile) return;

	const stat = await hsmFileAdapter.stat(hsmRecordingFile);
	if (stat && stat.size > hsmRecordingConfig.maxFileSize) {
		for (let i = hsmRecordingConfig.maxBackups; i > 0; i--) {
			const oldFile = `${hsmRecordingFile}.${i}`;
			const newFile = `${hsmRecordingFile}.${i + 1}`;
			if (await hsmFileAdapter.exists(oldFile)) {
				if (i === hsmRecordingConfig.maxBackups) {
					// Remove oldest backup - ignore if already deleted (race condition)
					try {
						await hsmFileAdapter.remove(oldFile);
					} catch {
						// File may have been deleted by concurrent rotation
					}
				} else {
					// Remove destination first if it exists (Obsidian rename doesn't overwrite)
					try {
						await hsmFileAdapter.remove(newFile);
					} catch {
						// Destination didn't exist, which is fine
					}
					try {
						await hsmFileAdapter.rename(oldFile, newFile);
					} catch {
						// Source may have been moved by concurrent rotation
					}
				}
			}
		}

		if (await hsmFileAdapter.exists(hsmRecordingFile)) {
			// Remove destination first if it exists
			try {
				await hsmFileAdapter.remove(`${hsmRecordingFile}.1`);
			} catch {
				// Destination didn't exist, which is fine
			}
			try {
				await hsmFileAdapter.rename(hsmRecordingFile, `${hsmRecordingFile}.1`);
			} catch {
				// Source may have been moved by concurrent rotation
			}
		}

		await hsmFileAdapter.write(hsmRecordingFile, "");
	}
}

/**
 * Check if HSM recording is active.
 */
export function isHSMRecordingActive(): boolean {
	return hsmRecordingFile !== null;
}

/**
 * Get the current HSM recording boot ID.
 */
export function getHSMBootId(): string | null {
	return hsmBootId;
}

/**
 * Get HSM recording entries from the current boot.
 * Reads the disk file (including rotated backups) and filters by current boot ID.
 */
export async function getHSMBootEntries(): Promise<object[]> {
	if (!hsmFileAdapter || !hsmRecordingFile || !hsmBootId) {
		return [];
	}

	// Flush any buffered entries first
	await flushHSMRecording();

	const entries: object[] = [];

	// Helper to parse entries from a file
	const parseEntriesFromFile = async (filePath: string): Promise<void> => {
		try {
			if (!await hsmFileAdapter!.exists(filePath)) {
				return;
			}
			const content = await hsmFileAdapter!.read(filePath);
			const lines = content.split('\n').filter(line => line.trim());

			for (const line of lines) {
				try {
					const entry = JSON.parse(line);
					if (entry.boot === hsmBootId) {
						entries.push(entry);
					}
				} catch {
					// Skip malformed lines
				}
			}
		} catch {
			// File doesn't exist or can't be read
		}
	};

	// Read rotated files first (oldest to newest: .3, .2, .1)
	for (let i = hsmRecordingConfig.maxBackups; i >= 1; i--) {
		await parseEntriesFromFile(`${hsmRecordingFile}.${i}`);
	}

	// Read main file last (newest entries)
	await parseEntriesFromFile(hsmRecordingFile);

	return entries;
}

/**
 * Get the most recent HSM recording entries for a specific document.
 * Reads files in reverse order (newest first) and stops once limit is reached.
 * Much more efficient than getBootEntries() when you only need a few entries.
 */
export async function getRecentEntries(guid: string, limit: number = 10): Promise<object[]> {
	if (!hsmBootId) {
		return [];
	}

	const results: object[] = [];

	// Scan the in-memory buffer first (newest, not yet flushed to disk).
	// Walk backwards for most-recent-first collection.
	for (let i = hsmBuffer.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(hsmBuffer[i]) as Record<string, unknown>;
			if (entry.boot === hsmBootId && entry.guid === guid) {
				results.push(entry);
				if (results.length >= limit) {
					results.reverse();
					return results;
				}
			}
		} catch {
			// Skip malformed lines
		}
	}

	if (!hsmFileAdapter || !hsmRecordingFile) {
		results.reverse();
		return results;
	}

	// Parse a file's lines in reverse, collecting matches until we hit the limit.
	// Returns true if we've collected enough.
	const collectFromFile = async (filePath: string): Promise<boolean> => {
		try {
			if (!await hsmFileAdapter!.exists(filePath)) {
				return false;
			}
			const content = await hsmFileAdapter!.read(filePath);
			const lines = content.split('\n').filter(line => line.trim());

			// Walk backwards so we get the most recent entries first
			for (let i = lines.length - 1; i >= 0; i--) {
				try {
					const entry = JSON.parse(lines[i]) as Record<string, unknown>;
					if (entry.boot === hsmBootId && entry.guid === guid) {
						results.push(entry);
						if (results.length >= limit) return true;
					}
				} catch {
					// Skip malformed lines
				}
			}
		} catch {
			// File doesn't exist or can't be read
		}
		return false;
	};

	// Read newest file first (main), then rotated files in order (.1, .2, .3)
	if (await collectFromFile(hsmRecordingFile)) {
		results.reverse();
		return results;
	}

	for (let i = 1; i <= hsmRecordingConfig.maxBackups; i++) {
		if (await collectFromFile(`${hsmRecordingFile}.${i}`)) {
			break;
		}
	}

	// We collected in reverse order, flip to chronological
	results.reverse();
	return results;
}
