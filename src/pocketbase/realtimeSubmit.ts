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

/** The stream a submit was made for, read from the body the client built. */
function submittedClientId(body: unknown): string | undefined {
	try {
		const parsed = typeof body === "string" ? (JSON.parse(body) as unknown) : body;
		const clientId = (parsed as { clientId?: unknown } | null)?.clientId;
		return typeof clientId === "string" ? clientId : undefined;
	} catch {
		return undefined;
	}
}

/** The rejection the client already ignores for a subscription submit. */
function replacedStream(): DOMException {
	return new DOMException(
		"Realtime subscription submit belongs to a replaced stream",
		"AbortError",
	);
}

export function routeRealtimeSubmit(
	url: string,
	options: SendOptions,
	currentClientId: () => string,
	transport: Transport = streamTransport,
): void {
	if (!isRealtimeSubmit(url, options.method)) {
		return;
	}
	const submitted = submittedClientId(options.body);
	const owned = submitted !== undefined && currentClientId() === submitted;
	const stale = () => owned && currentClientId() !== submitted;
	options.fetch = async (input, init) => {
		let response: Response;
		try {
			response = await transport(input, init);
		} catch (error) {
			throw stale() ? replacedStream() : error;
		}
		if (response.status >= 400 && stale()) {
			throw replacedStream();
		}
		return response;
	};
}
