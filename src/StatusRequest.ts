import type { RequestUrlResponse } from "obsidian";
import { getRelayRequestHeaders, requestUrlWithMetrics } from "./customFetch";
import type { TimeProvider } from "./TimeProvider";
import { flags } from "./flagManager";

/** A rejected status request sends one browser probe for server access logs. */
export class StatusRequest {
	private backupTimer?: number;
	private backup?: AbortController;
	private generation = 0;

	constructor(private readonly time: TimeProvider, private readonly url: string) {}

	request(): Promise<RequestUrlResponse> {
		const generation = this.generation;
		return requestUrlWithMetrics({
			url: this.url,
			method: "GET",
			headers: getRelayRequestHeaders(),
			throw: false,
			maxResponseBytes: 64 * 1024,
			relayNetworkDomain: "api",
		}).catch((error: unknown) => {
			// HTTP errors are responses from a working transport.
			if (generation === this.generation) void this.probeBrowser();
			throw error;
		});
	}

	private async probeBrowser(): Promise<void> {
		if (!flags().enableBackupNetworkProbe || this.backup) return;
		const controller = new AbortController();
		this.backup = controller;
		const timer = this.time.setTimeout(() => controller.abort(), 5_000);
		this.backupTimer = timer;
		try {
			// Origin and Sec-Fetch headers distinguish browser requests in
			// access logs even when the user agent matches Obsidian's. No
			// custom headers means no CORS preflight.
			const response = await window.fetch(this.url, {
				method: "GET", cache: "no-store", credentials: "omit", signal: controller.signal,
			});
			await response.body?.cancel();
		} catch {
			// Reaching the endpoint is the signal; a general outage can
			// prevent both transports from reaching it.
		} finally {
			this.time.clearTimeout(timer);
			if (this.backup === controller) {
				this.backup = undefined;
				this.backupTimer = undefined;
			}
		}
	}

	stop(): void {
		this.generation++;
		if (this.backupTimer !== undefined) this.time.clearTimeout(this.backupTimer);
		this.backupTimer = undefined;
		this.backup?.abort();
		this.backup = undefined;
	}
}
