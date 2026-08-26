export interface S3ErrorDetails {
	code?: string;
	message?: string;
	requestId?: string;
	hostId?: string;
	status?: number;
	operation?: string;
}

const RETRYABLE_S3_CODES = new Set([
	"InternalError",
	"NetworkingError",
	"RequestTimeout",
	"ServiceUnavailable",
	"SlowDown",
	"Throttling",
	"ThrottlingException",
	"TooManyRequests",
	"TooManyRequestsException",
]);

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class S3ApiError extends Error {
	code?: string;
	requestId?: string;
	hostId?: string;
	status?: number;
	operation?: string;
	retryable: boolean;

	constructor(details: S3ErrorDetails, cause?: unknown) {
		super(userMessageForS3Error(details));
		this.name = "S3ApiError";
		this.code = details.code;
		this.requestId = details.requestId;
		this.hostId = details.hostId;
		this.status = details.status;
		this.operation = details.operation;
		this.retryable = isRetryableS3Details(details);
		if (cause !== undefined) {
			(this as Error & { cause?: unknown }).cause = cause;
		}
	}
}

export function isRetryableS3Error(error: unknown): error is S3ApiError {
	return error instanceof S3ApiError && error.retryable;
}

export function s3ApiErrorFromResponse(
	status: number,
	body: string,
	operation?: string,
): S3ApiError {
	const parsed = parseS3ErrorXml(body);
	return new S3ApiError({
		...parsed,
		status,
		operation,
		message: parsed?.message ?? jsonErrorMessage(body),
	});
}

/**
 * Wrap a network-level transport failure (the request never produced an HTTP
 * response: DNS, connection reset, dropped socket) as a retryable error.
 * Returns null for anything that is not recognizably network-level, so a
 * programming error is never classified as transient. Follows the AWS SDK
 * convention of classifying such failures as a retryable "NetworkingError".
 */
export function s3NetworkFailureFromUnknown(
	error: unknown,
	operation?: string,
): S3ApiError | null {
	if (error instanceof S3ApiError) return null;
	const text = errorText(error);
	if (!text || !NETWORK_FAILURE_PATTERN.test(text)) return null;
	return new S3ApiError(
		{ code: "NetworkingError", operation, message: text },
		error,
	);
}

const NETWORK_FAILURE_PATTERN =
	/net::ERR_|Failed to fetch|fetch failed|\bLoad failed\b|NetworkError|network error|socket hang up|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN/i;

function jsonErrorMessage(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		return typeof parsed?.error === "string" ? parsed.error : undefined;
	} catch {
		return undefined;
	}
}

export function s3ApiErrorFromUnknown(
	error: unknown,
	operation?: string,
): S3ApiError | null {
	const text = errorText(error);
	if (!text) return null;
	const parsed = parseS3ErrorXml(text);
	if (!parsed) return null;
	return new S3ApiError({ ...parsed, operation }, error);
}

export function parseS3ErrorXml(body: string): S3ErrorDetails | null {
	const trimmed = body.trim();
	if (!trimmed.includes("<Error") || !trimmed.includes("</Error>")) return null;
	if (typeof DOMParser === "undefined") return null;

	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(trimmed, "application/xml");
	} catch {
		return null;
	}

	if (doc.querySelector("parsererror")) return null;
	const error = doc.querySelector("Error");
	if (!error) return null;

	const details: S3ErrorDetails = {
		code: xmlText(error, "Code"),
		message: xmlText(error, "Message"),
		requestId: xmlText(error, "RequestId"),
		hostId: xmlText(error, "HostId"),
	};
	return details.code || details.message || details.requestId ? details : null;
}

function isRetryableS3Details(details: S3ErrorDetails): boolean {
	return (
		(details.code !== undefined && RETRYABLE_S3_CODES.has(details.code)) ||
		(details.status !== undefined && RETRYABLE_HTTP_STATUSES.has(details.status))
	);
}

function userMessageForS3Error(details: S3ErrorDetails): string {
	switch (details.code) {
		case "SlowDown":
		case "Throttling":
		case "ThrottlingException":
		case "TooManyRequests":
		case "TooManyRequestsException":
			return "Attachment storage is busy. Relay will retry the upload.";
		case "RequestTimeout":
			return "Attachment storage timed out. Relay will retry the upload.";
		case "NetworkingError":
			return "Could not reach attachment storage. Relay will retry.";
		case "AccessDenied":
			return "Relay could not access attachment storage.";
		case "ExpiredToken":
		case "InvalidToken":
			return "Attachment storage authorization expired.";
	}

	if (details.status === 429) {
		return "Attachment storage is busy. Relay will retry the upload.";
	}
	if (details.status !== undefined && details.status >= 500) {
		return "Attachment storage is temporarily unavailable. Relay will retry the upload.";
	}
	if (details.message) {
		return `Attachment storage error: ${details.message}`;
	}
	if (details.code) {
		return `Attachment storage error (${details.code})`;
	}
	return "Attachment storage request failed.";
}

function xmlText(parent: Element, tag: string): string | undefined {
	return parent.querySelector(tag)?.textContent?.replace(/\s+/g, " ").trim() || undefined;
}

function errorText(error: unknown): string | null {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (error === null || error === undefined) return null;
	try {
		return JSON.stringify(error) ?? null;
	} catch {
		return null;
	}
}
