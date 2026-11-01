"use strict";
import type { SendOptions } from "pocketbase";

type Transport = (
	url: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Supersedes in-flight realtime subscription submits.
 *
 * After every (re)connect of its SSE stream the PocketBase client registers
 * the subscriptions by POSTing them to `/api/realtime` with the stream's
 * client id. When the stream is replaced while that POST is still in flight,
 * the request answers for a client id the server has already dropped. The
 * client treats the resulting error as a failure of the stream it holds now,
 * clears that stream's id and disconnects for good, with every listener still
 * registered and nothing left to reconnect.
 *
 * The client's own defence is request auto-cancellation, which aborts the
 * stale POST before the next one is sent. Relay turns auto-cancellation off so
 * concurrent list fetches do not cancel one another, which also disables that
 * one cancellation. This guard restores it: each realtime submit aborts the
 * previous one, and the aborted request rejects with an AbortError, which the
 * client already ignores for this request.
 */
export class RealtimeSubmitGuard {
	private pending?: AbortController;

	/** Whether a request registers realtime subscriptions. */
	static isRealtimeSubmit(url: string, method?: string): boolean {
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
	 * Hook for the client's `beforeSend`: wraps the transport of a realtime
	 * submit so that it supersedes the previous one. Other requests are left
	 * untouched.
	 */
	guard(url: string, options: SendOptions): void {
		if (!RealtimeSubmitGuard.isRealtimeSubmit(url, options.method)) {
			return;
		}
		this.abort();
		const controller = new AbortController();
		this.pending = controller;
		const transport = (options.fetch ?? fetch) as Transport;
		options.fetch = (input, init) =>
			this.race(controller, transport, input, init);
	}

	/** Aborts the submit still in flight, if any. */
	abort(): void {
		const pending = this.pending;
		this.pending = undefined;
		pending?.abort();
	}

	private race(
		controller: AbortController,
		transport: Transport,
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> {
		return new Promise<Response>((resolve, reject) => {
			const superseded = () =>
				reject(
					new DOMException(
						"Realtime subscription submit superseded",
						"AbortError",
					),
				);
			if (controller.signal.aborted) {
				superseded();
				return;
			}
			// Settle before resolving so a submit issued right after this one
			// completes does not abort a signal that is already done with.
			const settle = () => {
				controller.signal.removeEventListener("abort", superseded);
				if (this.pending === controller) {
					this.pending = undefined;
				}
			};
			controller.signal.addEventListener("abort", superseded, { once: true });
			transport(input, { ...init, signal: controller.signal }).then(
				(response) => {
					settle();
					resolve(response);
				},
				(reason) => {
					settle();
					reject(reason);
				},
			);
		});
	}
}
