const chromiumError = /\bnet::(ERR_[A-Z0-9_]+)/i;
const socketCode = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b/i;
const transportMessage = /failed to fetch|fetch failed|\bload failed\b|networkerror|network error|socket hang up|socket disconnected before (?:secure )?TLS connection was established/i;

/** Classify an error from a network request before an HTTP response arrives. */
export function isNetworkFailureMessage(message: string): boolean {
	const code = chromiumError.exec(message)?.[1];
	if (code) return !code.toUpperCase().startsWith("ERR_CERT_");
	return socketCode.test(message) || transportMessage.test(message);
}
