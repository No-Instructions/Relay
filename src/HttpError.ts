import { parseProblemDetails, type ProblemDetails } from "./ProblemDetails";
import { formatUserFacingError } from "./UserFacingError";

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
	retryable: boolean;

	constructor(
		readonly status: number | undefined,
		message: string,
		readonly problem?: ProblemDetails,
	) {
		super(problem?.detail ?? problem?.title ?? message);
		this.name = "HttpError";
		// The response status is authoritative; the JSON status is advisory.
		this.retryable = status !== undefined && RETRYABLE_HTTP_STATUSES.has(status);
	}
}

export function httpErrorFromResponse(
	status: number,
	body: string,
	fallback = `Request failed with status ${status}`,
): HttpError {
	const problem = parseProblemDetails(body);
	let message = fallback;
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === "string" || (parsed && typeof parsed === "object")) {
			message = formatUserFacingError(parsed, fallback);
		}
	} catch {
		// Proxies can send HTML or an empty body. Keep the useful HTTP status.
	}
	return new HttpError(status, message, problem);
}

export function isRetryableHttpError(error: unknown): error is HttpError {
	return error instanceof HttpError && error.retryable;
}
