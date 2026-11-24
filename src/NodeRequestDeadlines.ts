export interface RequestDeadlines {
	connectTimeoutMs?: number;
	idleTimeoutMs?: number;
	/** Bound the response wait after Node has accepted the complete request body. */
	finishedWriteTimeoutMs?: number;
}

/** Bound DNS/TCP/TLS setup and periods without socket progress, including blocked writes. */
export function watchRequestDeadlines(
	request: import("http").ClientRequest, target: URL, timeout: () => void, options: RequestDeadlines = {},
): () => void {
	const timers = typeof window === "undefined"
		? { setTimeout, clearTimeout, setInterval, clearInterval }
		: window;
	const connectTimer = timers.setTimeout(timeout, options.connectTimeoutMs ?? 30_000);
	const connected = () => timers.clearTimeout(connectTimer);
	const connectEvent = target.protocol === "https:" ? "secureConnect" : "connect";
	request.once("socket", socket => {
		if (socket.connecting) socket.once(connectEvent, connected);
		else connected();
	});

	// Node's socket timeout can be postponed while a blocked write is still queued.
	const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
	const finishedWriteTimeoutMs = options.finishedWriteTimeoutMs ?? idleTimeoutMs;
	let lastBytes = 0;
	let lastProgress = performance.now();
	const idleTimer = timers.setInterval(() => {
		const socket = request.socket;
		const bytes = (socket?.bytesRead ?? 0) + (socket?.bytesWritten ?? 0);
		if (bytes !== lastBytes) {
			lastBytes = bytes;
			lastProgress = performance.now();
		} else if (performance.now() - lastProgress >= (request.writableFinished ? finishedWriteTimeoutMs : idleTimeoutMs)) {
			timeout();
		}
	}, Math.max(1, Math.min(1000, idleTimeoutMs / 4)));

	return () => {
		timers.clearTimeout(connectTimer);
		timers.clearInterval(idleTimer);
		request.socket?.off(connectEvent, connected);
	};
}
