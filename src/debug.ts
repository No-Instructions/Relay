// CurryLog is a way to add tagged logging that is stripped in production
import { Notice, Vault } from "obsidian";

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
}

let logConfig: LogConfig = {
	maxFileSize: 1024 * 1024, // 1MB
	maxBackups: 5,
	disableConsole: false,
};
let currentLogFile: string;

export function initializeLogger(
	vault: Vault,
	logFilePath: string,
	config?: Partial<LogConfig>,
) {
	currentLogFile = logFilePath;
	if (config) {
		logConfig = { ...logConfig, ...config };
	}

	logWriter = async (message: string) => {
		try {
			await rotateLogIfNeeded(vault);
			await vault.adapter.append(currentLogFile, message + "\n");
		} catch (error) {
			console.error("Failed to write to log file:", error);
		}
	};
}
async function rotateLogIfNeeded(vault: Vault): Promise<void> {
	try {
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
			await vault.adapter.rename(currentLogFile, `${currentLogFile}.1`);

			// Instead of write, use append with an empty string to create the file if it doesn't exist
			// or do nothing if it does exist
			await vault.adapter.append(currentLogFile, "");
		}
	} catch (error) {
		console.error("Error during log rotation:", error);
		// If rotation fails, we'll continue using the current log file
	}
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
