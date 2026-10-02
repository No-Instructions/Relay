import type { CliData } from "./schema";
import { CliError } from "./types";

/** Read a normalized value after the host adapter validates its syntax. */
export function optional(params: CliData, key: string): string | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

export function required(params: CliData, key: string): string {
	const value = optional(params, key);
	if (value === undefined) {
		throw new CliError("missing_option", `Missing required option: --${key}=<value>`);
	}
	return value;
}

/** Validated boolean options are represented by true or false strings. */
export function flag(params: CliData, key: string): boolean {
	return params[key] === "true";
}

/** The debug surface addresses notes by vault path with a leading slash. */
export function notePath(path: string): string {
	return `/${folderPath(path)}`;
}

/** A vault-relative folder path without leading or trailing slashes. */
export function folderPath(path: string): string {
	const parts = path.trim().replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
	if (parts.length === 0 || parts.includes("..")) {
		throw new CliError("invalid_path", "Use a vault-relative path below its root without parent-directory segments");
	}
	return parts.join("/");
}
