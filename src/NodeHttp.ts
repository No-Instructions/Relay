import { apiVersion, Platform, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { flags } from "./flagManager";

declare const GIT_TAG: string;

export function useNativeNetworking(): boolean {
	return Platform.isDesktopApp && flags().enableNativeNetworking;
}

interface NodeRequestOptions {
	signal?: AbortSignal;
	redirect?: RequestRedirect;
	maxResponseBytes?: number;
	connectTimeoutMs?: number;
	idleTimeoutMs?: number;
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("Request aborted", "AbortError");
}

/** Desktop HTTP with bounded range responses, cancellation, and socket inactivity deadlines. */
export async function nodeRequestUrl(
	params: RequestUrlParam,
	options: NodeRequestOptions = {},
): Promise<RequestUrlResponse> {
	if (!Platform.isDesktopApp) throw new Error("Node networking is only available on desktop");
	let target = new URL(params.url);
	let headers = Object.fromEntries(Object.entries(params.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
	let method = (params.method ?? "GET").toUpperCase();
	let body = params.body;
	let contentType = params.contentType;
	for (let redirects = 0; ; redirects++) {
		if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Unsupported HTTP URL");
		if (options.signal?.aborted) throw abortError(options.signal);
		const response = await requestOnce(target, { ...params, body, method, headers, contentType }, options);
		if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) {
			if (params.throw !== false && response.status >= 400) throw new Error(`Request failed, status ${response.status}`);
			return response;
		}
		if (options.redirect === "manual") return response;
		if (options.redirect === "error") throw new Error("Unexpected HTTP redirect");
		const changesToGet = response.status === 303 && method !== "HEAD" || [301, 302].includes(response.status) && method === "POST";
		if (changesToGet) {
			method = "GET";
			body = undefined;
			contentType = undefined;
			delete headers["content-length"];
			delete headers["content-type"];
		}
		if (redirects >= 5) throw new Error("Too many HTTP redirects");
		const next = new URL(response.headers.location, target);
		if (target.protocol === "https:" && next.protocol !== "https:") throw new Error("Refusing an insecure HTTP redirect");
		if (next.origin !== target.origin) {
			if (body !== undefined) throw new Error("Refusing a request-body redirect to another origin");
			// Carry only representation headers to another origin, never Relay credentials or identity.
			headers = Object.fromEntries(Object.entries(headers).filter(([key]) => ["range", "accept", "accept-encoding"].includes(key)));
		}
		target = next;
	}
}

function requestOnce(target: URL, params: RequestUrlParam, options: NodeRequestOptions): Promise<RequestUrlResponse> {
	// Native modules stay behind the desktop guard in nodeRequestUrl.
	const http = (target.protocol === "https:" ? require("https") : require("http")) as typeof import("http");
	const { Buffer } = require("buffer") as typeof import("buffer");
	const body = typeof params.body === "string" ? Buffer.from(params.body) : params.body ? Buffer.from(params.body) : undefined;
	const headers: Record<string, string> = { ...params.headers, "accept-encoding": "identity" };
	delete headers.host;
	headers["user-agent"] ??= `Relay/${GIT_TAG} Obsidian/${apiVersion}`;
	if (params.contentType) headers["content-type"] = params.contentType;
	if (body) headers["content-length"] = String(body.byteLength);
	return new Promise((resolve, reject) => {
		let settled = false;
		let response: import("http").IncomingMessage | undefined;
		const finish = (error?: Error, result?: RequestUrlResponse) => {
			if (settled) return;
			settled = true;
			clearTimeout(connectTimer);
			clearInterval(idleTimer);
			options.signal?.removeEventListener("abort", abort);
			response?.destroy();
			request.destroy();
			if (error) reject(error); else resolve(result!);
		};
		const abort = () => finish(abortError(options.signal!));
		const timeout = () => finish(Object.assign(new Error("ETIMEDOUT: HTTP request stopped making progress"), { code: "ETIMEDOUT" }));
		const request = http.request(target, { method: params.method, headers }, incoming => {
			response = incoming;
			const status = incoming.statusCode ?? 0;
			const responseHeaders: Record<string, string> = {};
			for (const [key, value] of Object.entries(incoming.headers)) {
				if (value !== undefined) responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			// Error and redirect bodies do not need to retain an object-sized payload.
			const limit = status >= 300 ? 64 * 1024 : options.maxResponseBytes ?? Infinity;
			const complete = () => {
				if (settled) return;
				const bytes = Buffer.concat(chunks, size);
				const arrayBuffer = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
					? bytes.buffer
					: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer;
				finish(undefined, {
					status, headers: responseHeaders, arrayBuffer,
					get text() { return bytes.toString("utf8"); },
					get json() { return JSON.parse(bytes.toString("utf8")); },
				});
			};
			incoming.on("data", (chunk: Buffer) => {
				if (size + chunk.length > limit) {
					if (status >= 300) {
						chunks.push(chunk.subarray(0, limit - size));
						size = limit;
						complete();
					} else finish(new Error("HTTP response exceeded the requested byte range"));
					return;
				}
				size += chunk.length;
				chunks.push(chunk);
			});
			incoming.on("error", error => finish(error));
			incoming.on("aborted", () => finish(Object.assign(new Error("ECONNRESET: HTTP response interrupted"), { code: "ECONNRESET" })));
			incoming.on("end", complete);
		});
		request.on("error", error => finish(error));
		// The connection deadline covers DNS/TCP/TLS. The inactivity deadline resets
		// as bytes flow and does not cap the total duration of a large transfer.
		const connectTimer = setTimeout(timeout, options.connectTimeoutMs ?? 30_000);
		request.on("socket", socket => {
			if (!socket.connecting) clearTimeout(connectTimer);
			else socket.once(target.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
		});
		// Node's socket timeout can be postponed while a blocked write is still
		// queued. Observe byte counters so a stalled upload also releases its slot.
		const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
		let lastBytes = 0;
		let lastProgress = performance.now();
		const idleTimer = setInterval(() => {
			const socket = request.socket;
			const bytes = (socket?.bytesRead ?? 0) + (socket?.bytesWritten ?? 0);
			if (bytes !== lastBytes) { lastBytes = bytes; lastProgress = performance.now(); }
			else if (performance.now() - lastProgress >= idleTimeoutMs) timeout();
		}, Math.max(1, Math.min(1000, idleTimeoutMs / 4)));
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		else request.end(body);
	});
}
