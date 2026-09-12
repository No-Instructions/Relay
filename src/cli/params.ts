import type { CliData } from "obsidian";
import { CliError } from "./types";

/** A value flag; a bare flag (value "true") counts as missing. */
export function optional(params: CliData, key: string): string | undefined {
	const value = params[key];
	if (value === undefined || value === "true") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

export function required(params: CliData, key: string): string {
	const value = optional(params, key);
	if (value === undefined) {
		throw new CliError("missing_flag", `Missing required parameter: ${key}=<value>`);
	}
	return value;
}

/** A boolean flag: present means on; `key=off` means off. */
export function flag(params: CliData, key: string): boolean {
	const value = params[key];
	if (value === undefined) return false;
	return parseOnOff(key, value) ?? true;
}

/** Parse on|off style values. Undefined when the flag is absent. */
export function parseOnOff(key: string, value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["true", "on", "yes", "1", "enable", "enabled"].includes(normalized)) return true;
	if (["false", "off", "no", "0", "disable", "disabled"].includes(normalized)) return false;
	throw new CliError("invalid_value", `${key} must be on or off, got "${value}"`);
}

/** The debug surface addresses notes by vault path with a leading slash. */
export function notePath(path: string): string {
	const trimmed = path.trim().replace(/^\/+/, "");
	return `/${trimmed}`;
}

/** A vault-relative folder path without leading or trailing slashes. */
export function folderPath(path: string): string {
	return path.trim().replace(/^\/+|\/+$/g, "");
}
