const OBJECT_STRING = "[object Object]";
const MAX_ERROR_MESSAGE_LENGTH = 300;

export function formatUserFacingError(
	error: unknown,
	fallback = "Sync failed",
): string {
	const message = extractErrorMessage(error, new Set<object>());
	return normalizeMessage(message) ?? fallback;
}

export function errorFromUnknown(
	error: unknown,
	fallback = "Sync failed",
): Error {
	const message = formatUserFacingError(error, fallback);
	if (error instanceof Error && message === error.message) return error;
	return new Error(message);
}

function extractErrorMessage(
	value: unknown,
	seen: Set<object>,
): string | null {
	if (value === null || value === undefined) return null;

	if (typeof value === "string") {
		const parsed = parseJsonObject(value);
		if (parsed !== null) {
			return extractErrorMessage(parsed, seen) ?? value;
		}
		return value;
	}

	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return String(value);
	}

	if (value instanceof Error) {
		return normalizeMessage(value.message) ?? normalizeMessage(value.name);
	}

	if (typeof value !== "object") return null;
	if (seen.has(value)) return null;
	seen.add(value);

	const record = value as Record<string, unknown>;
	const directMessage = extractDirectMessage(record, seen);
	if (directMessage) return directMessage;

	const nestedMessage = extractNestedMessage(record, seen);
	if (nestedMessage) return nestedMessage;

	const statusMessage = extractStatusMessage(record);
	if (statusMessage) return statusMessage;

	const code = primitiveToString(record.code);
	if (code) return `Sync failed (${code})`;

	return null;
}

function extractDirectMessage(
	record: Record<string, unknown>,
	seen: Set<object>,
): string | null {
	for (const key of [
		"message",
		"error",
		"reason",
		"detail",
		"description",
	]) {
		if (!(key in record)) continue;
		const message = normalizeMessage(extractErrorMessage(record[key], seen));
		if (message) return message;
	}
	return null;
}

function extractNestedMessage(
	record: Record<string, unknown>,
	seen: Set<object>,
): string | null {
	for (const key of ["response", "data", "body", "cause"]) {
		if (!(key in record)) continue;
		const message = normalizeMessage(extractErrorMessage(record[key], seen));
		if (message) return message;
	}
	return null;
}

function extractStatusMessage(record: Record<string, unknown>): string | null {
	const status = primitiveToString(record.status) ?? primitiveToString(record.statusCode);
	const statusText = primitiveToString(record.statusText);
	if (status && statusText) return `Request failed with status ${status}: ${statusText}`;
	if (status) return `Request failed with status ${status}`;
	return null;
}

function parseJsonObject(value: string): object | null {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}

function normalizeMessage(message: unknown): string | null {
	if (typeof message !== "string") return null;
	const normalized = message.replace(/\s+/g, " ").trim();
	if (!normalized || normalized === OBJECT_STRING || normalized === "Object") {
		return null;
	}
	const humanReadable = humanizeInternalSyncMessage(normalized);
	return humanReadable.length > MAX_ERROR_MESSAGE_LENGTH
		? `${humanReadable.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
		: humanReadable;
}

function primitiveToString(value: unknown): string | null {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return normalizeMessage(String(value));
	}
	return null;
}

function humanizeInternalSyncMessage(message: string): string {
	const withoutPrefix = message.replace(/^(?:\[[^\]]+\]\s*)+/, "");
	const documentSyncFailure = withoutPrefix.match(
		/^Document sync failed:\s+(.+?)(?:\s+\([^)]+\))?$/,
	);
	if (documentSyncFailure) {
		return `Unable to sync ${filenameFromPath(documentSyncFailure[1])}`;
	}
	return withoutPrefix;
}

function filenameFromPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").trim();
	const parts = normalized.split("/").filter(Boolean);
	return parts[parts.length - 1] || "file";
}
