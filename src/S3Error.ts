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
		message: parsed?.message,
	});
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
		return String(error);
	} catch {
		return null;
	}
}
