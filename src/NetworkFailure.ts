/** Recognizable transport failures; application and certificate errors are excluded. */
export function isNetworkFailureMessage(message: string): boolean {
	return /net::ERR_(?:CONNECTION_|NETWORK_|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|TIMED_OUT)|Failed to fetch|fetch failed|\bLoad failed\b|NetworkError|network error|socket hang up|socket disconnected before secure TLS connection was established|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN/i.test(message);
}
