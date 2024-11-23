"use strict";
import { requestUrl } from "obsidian";
import { Platform } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { curryLog } from "./debug";

declare const GIT_TAG: string;

if (globalThis.Response === undefined || globalThis.Headers === undefined) {
	// Fetch API is broken for some versions of Electron
	// https://github.com/electron/electron/pull/42419
	try {
		console.warn(
			"[Relay] Polyfilling Fetch API (Electron Bug: https://github.com/electron/electron/pull/42419)",
		);
		if ((globalThis as any).blinkfetch) {
			globalThis.fetch = (globalThis as any).blinkFetch;
			const keys = ["fetch", "Response", "FormData", "Request", "Headers"];
			for (const key of keys) {
				(globalThis as any)[key] = (globalThis as any)[`blink${key}`];
			}
		}
	} catch (e) {
		console.error(e);
	}
}

if (globalThis.EventSource === undefined) {
    if (Platform.isMobile) {
	    console.warn("[Relay] Polyfilling EventSource API required, but unable to polyfill on Mobile");
    } else {
	    console.warn("[Relay] Polyfilling EventSource API");
	    // @ts-ignore
	    globalThis.EventSource = require("eventsource");
    }
}


export const customFetch = async (
	url: RequestInfo | URL,
	config?: RequestInit,
): Promise<Response> => {
	// Convert URL object to string if necessary
	const urlString = url instanceof URL ? url.toString() : (url as string);

	const method = config?.method || "GET";

	const headers = Object.assign({}, config?.headers, {
		"Relay-Version": GIT_TAG,
	}) as Record<string, string>;

	// Prepare the request parameters
	const requestParams: RequestUrlParam = {
		url: urlString,
		method: method,
		body: config?.body as string | ArrayBuffer,
		headers: headers,
		throw: false,
	};

	const startTime = performance.now();
	let response: RequestUrlResponse | undefined = undefined;
	response = await requestUrl(requestParams);
	const endTime = performance.now();
	const duration = endTime - startTime;

	if (!response.arrayBuffer.byteLength) {
		return new Response(null, {
			status: response.status,
			statusText: response.status.toString(),
			headers: new Headers(response.headers),
		});
	}
	const fetchResponse = new Response(response.arrayBuffer, {
		status: response.status,
		statusText: response.status.toString(),
		headers: new Headers(response.headers),
	});

	// Add json method to the response
	const json = async () => JSON.parse(response!.text);
	Object.defineProperty(fetchResponse, "json", {
		value: json,
	});

	const level =
		response.status >= 500
			? "error"
			: response.status >= 400
				? "warn"
				: "debug";
	const response_text = response.text;
	let response_json;
	try {
		response_json = JSON.stringify(JSON.parse(response_text));
	} catch (e) {
		// pass
	}

	curryLog("[CustomFetch]", level)(
		`${duration.toFixed(2)}ms`,
		response.status.toString(),
		method,
		urlString,
		response_json || response_text,
	);
	if (response.status >= 500) {
		throw new Error(response_text);
	}

	return fetchResponse;
};
