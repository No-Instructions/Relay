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
}

let logConfig: LogConfig = {
	maxFileSize: 1024 * 1024, // 1MB
	maxBackups: 5,
	disableConsole: false,
	batchInterval: 1000, // 1 second
	maxRetries: 3,
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
					await fileAdapter.remove(oldFile);
				} else {
					await fileAdapter.rename(oldFile, newFile);
				}
			}
		}

		if (await fileAdapter.exists(currentLogFile)) {
			await fileAdapter.rename(currentLogFile, `${currentLogFile}.1`);
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

const SENSITIVE_KEYS = ["token", "authorization", "email"];

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
			const callerInfo = stack ? stack.split("\n")[2].trim() : "";
			const serializedArgs = args.map(serializeArg).join(" ");

			const logEntry: LogEntry = {
				timestamp,
				level,
				message: `${initialText}: ${serializedArgs}`,
				callerInfo,
			};

			if (!logConfig.disableConsole) {
				console[level](formatLogEntry(logEntry));
			}

			logBuffer.push(logEntry);
		}
	};
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
