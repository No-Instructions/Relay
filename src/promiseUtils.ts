export function promiseWithTimeout<T>(
	promise: Promise<T>,
	ms: number
): Promise<T> {
	let timeoutId: NodeJS.Timeout; // or simply `number` if in browser context
	const timeout = new Promise<T>((_, reject) => {
		timeoutId = setTimeout(() => {
			console.log("timeout on promise", promise);
			reject("Timeout after " + ms + " ms");
		}, ms);
	});

	return Promise.race([promise, timeout]).finally(() => {
		clearTimeout(timeoutId);
	});
}
