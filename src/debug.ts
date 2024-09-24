// CurryLog is a way to add tagged logging that is stripped in production
import { Notice, Vault } from "obsidian";
import type { TimeProvider } from "./TimeProvider";

type LogLevel = "debug" | "warn" | "log" | "error";
type LogWriter = (message: string) => Promise<void>;

declare const BUILD_TYPE: string;

export const RelayInstances = new WeakMap();
let logWriter: LogWriter | undefined;
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
let vault: Vault;
const logBuffer: LogEntry[] = [];

type LogEntry = {
	timestamp: string;
	level: LogLevel;
	message: string;
	callerInfo: string;
};

export function initializeLogger(
	vaultInstance: Vault,
	timeProvider: TimeProvider,
	logFilePath: string,
	config?: Partial<LogConfig>,
) {
	vault = vaultInstance;
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
			await vault.adapter.append(currentLogFile, logContent);
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
	const stat = await vault.adapter.stat(currentLogFile);
	if (stat && stat.size > logConfig.maxFileSize) {
		for (let i = logConfig.maxBackups; i > 0; i--) {
			const oldFile = `${currentLogFile}.${i}`;
			const newFile = `${currentLogFile}.${i + 1}`;
			if (await vault.adapter.exists(oldFile)) {
				if (i === logConfig.maxBackups) {
					await vault.adapter.remove(oldFile);
				} else {
					await vault.adapter.rename(oldFile, newFile);
				}
			}
		}

		if (await vault.adapter.exists(currentLogFile)) {
			await vault.adapter.rename(currentLogFile, `${currentLogFile}.1`);
		}

		await vault.adapter.write(currentLogFile, "");
	}
}

function formatLogEntry(entry: LogEntry): string {
	return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}\n    at ${entry.callerInfo}`;
}

function toastDebug(error: Error): Error {
	new Notice(error.name + "\n" + error.message);
	return error;
}
function toastProd(error: Error): Error {
	new Notice(error.name + ":\nAn error has occurred, please reload Obsidian.");
	return error;
}
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
						(key.toLowerCase().includes("authorization") ||
							key.toLowerCase().includes("token"))
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
			const message = `[${timestamp}] [${level.toUpperCase()}] ${initialText}: ${serializedArgs}\n    at ${callerInfo}`;

			if (!logConfig.disableConsole) {
				console[level](message);
			}

			if (logWriter) {
				logWriter(message).catch((err) =>
					console.error("Failed to write log:", err),
				);
			}
		}
	};
}

const debug = BUILD_TYPE === "debug";
export const toast = debug ? toastDebug : toastProd;
