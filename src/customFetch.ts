"use strict";
import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { curryLog } from "./debug"

// Adjusted customFetch function to match PocketBase's expected signature
export const customFetch = async (
	url: RequestInfo | URL,
	config?: RequestInit
): Promise<Response> => {
	// Convert URL object to string if necessary
	const urlString = url instanceof URL ? url.toString() : (url as string);

	// Prepare the request parameters
	const requestParams: RequestUrlParam = {
		url: urlString,
		method: (config?.method as RequestUrlParam["method"]) || "GET",
		body: config?.body as string | ArrayBuffer,
		headers: config?.headers as Record<string, string>,
	};

	try {
		const response: RequestUrlResponse = await requestUrl(requestParams);
		// Convert Obsidian's response to a format compatible with the Fetch API

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
		const json = async () => JSON.parse(await response.text);
		Object.defineProperty(fetchResponse, "json", {
			value: json,
		});

		return fetchResponse;
	} catch (error) {
		curryLog("[CustomFetch]", "error")("Error in customFetch:", error);
		throw error;
	}
};
