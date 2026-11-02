"use strict";
import type { SendOptions } from "pocketbase";

export type Transport = (
	url: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/** The stream's own network stack: EventSource and the global fetch share it. */
export const streamTransport: Transport = (url, init) => fetch(url, init);

/** Whether a request registers realtime subscriptions. */
export function isRealtimeSubmit(url: string, method?: string): boolean {
	if ((method ?? "GET").toUpperCase() !== "POST") {
		return false;
	}
	let path = url;
	try {
		path = new URL(url).pathname;
	} catch {
		path = url.split("?")[0];
	}
	return path.endsWith("/api/realtime");
}

/**
 * Sends a realtime subscription submit through the stream's network stack.
 *
 * After every (re)connect of its SSE stream the PocketBase client registers
 * the subscriptions by POSTing them to `/api/realtime` with the stream's
 * client id. The server accepts that POST only from the address the stream
 * came from. The stream is opened by the platform's EventSource, while
 * Relay's request transport may leave through a different stack with a
 * different address, as it does on iOS, where WebKit and CFNetwork can
 * egress separately. Every such POST is then refused, and the client either
 * gives up on the stream or reconnects in a loop. Sending this one request
 * through the same stack as the stream keeps both addresses equal. Every
 * other request keeps the transport the caller chose.
 */
export function routeRealtimeSubmit(url: string, options: SendOptions): void {
	if (isRealtimeSubmit(url, options.method)) {
		options.fetch = streamTransport;
	}
}
