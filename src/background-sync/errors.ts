import { isRetryableS3Error } from "../S3Error";

/**
 * A transfer failure the queue should re-drive with backoff: the provider
 * connection was not ready, timed out, or the transport failed in a way
 * that a later attempt can heal. Operations throw this (or a retryable S3
 * error) to request a retry; any other error settles the item as failed.
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

export function isRetryableProviderSyncError(
	error: unknown,
): error is RetryableProviderSyncError {
	return error instanceof RetryableProviderSyncError;
}

export function isRetryableSyncError(error: unknown): error is Error {
	return isRetryableProviderSyncError(error) || isRetryableS3Error(error);
}

export function retryReason(error: Error): "provider" | "s3" {
	return isRetryableProviderSyncError(error) ? "provider" : "s3";
}
