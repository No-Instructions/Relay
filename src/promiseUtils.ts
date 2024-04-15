export function promiseWithTimeout<T>(
	promise: Promise<T>,
	ms: number
): Promise<T> {
	const timeout = new Promise<T>((_, reject) =>
		setTimeout(() => reject(new Error("Timeout after " + ms + " ms")), ms)
	);
	return Promise.race([promise, timeout]);
}
