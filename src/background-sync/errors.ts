import { HttpError, isRetryableHttpError } from "../HttpError";
import { isNetworkFailureMessage } from "../NetworkFailure";

/**
 * A provider-bound failure the engine may re-drive: the connection was not
 * ready, the session did not reach synced in time, the remote held no
 * content yet. Carries the underlying cause when there is one.
 */
export class RetryableProviderSyncError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "RetryableProviderSyncError";
		if (cause !== undefined) {
			(this as Error & { cause?: unknown }).cause = cause;
		}
	}
}

/**
 * A provider-bound operation abandoned at its deadline. Retryable like any
 * provider sync error so the engine re-drives it, but a distinct type so a
 * genuine operation error and a stalled transport are never conflated.
 */
export class ProviderTimeoutError extends RetryableProviderSyncError {
	constructor(
		readonly operation: "sync" | "download",
		readonly awaited: string,
		readonly guid: string,
		readonly deadlineMs: number,
	) {
		super(
			`timed out awaiting provider ${awaited} for ${guid} after ` +
				`${Math.round(deadlineMs / 1000)}s`,
		);
		this.name = "ProviderTimeoutError";
	}
}

export function isRetryableProviderSyncError(
	error: unknown,
): error is RetryableProviderSyncError {
	return error instanceof RetryableProviderSyncError;
}

/** A document or token request failed before a response was received. */
class SyncTransportError extends Error {
	constructor(readonly cause: Error) {
		super(cause.message);
		this.name = "SyncTransportError";
	}
}

export function rethrowSyncTransportError(error: unknown): never {
	if (error instanceof Error && !(error instanceof HttpError) && isNetworkFailureMessage(error.message)) {
		throw new SyncTransportError(error);
	}
	throw error;
}

export function isRetryableSyncError(error: unknown): error is Error {
	return isRetryableProviderSyncError(error) || isRetryableHttpError(error) || error instanceof SyncTransportError;
}

/** The last path segment, for user-facing messages. */
export function fileName(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	return parts[parts.length - 1] || "file";
}
