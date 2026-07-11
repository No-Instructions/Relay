"use strict";
import { apiVersion, requestUrl as obsidianRequestUrl } from "obsidian";
import { Platform } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import * as https from "https";
import { curryLog, metrics, type NetworkDomain, type NetworkResult } from "./debug";
import { flags } from "./flagManager";

declare const GIT_TAG: string;
declare const API_URL: string;
declare const AUTH_URL: string;

// Device management configuration
let deviceManagementConfig: {
	vaultId: string;
	deviceId: string;
} | null = null;

let pluginRequestConfig: {
	pluginId: string;
} | null = null;

const networkDomainOrigins: Record<"api" | "auth", Set<string>> = {
	api: new Set(),
	auth: new Set(),
};

type RelayRequestDomain = NetworkDomain;

export interface RelayRequestInit extends RequestInit {
	relayNetworkDomain?: RelayRequestDomain;
	relayUseNodeHttps?: boolean;
}

export interface RelayRequestUrlParam extends RequestUrlParam {
	relayNetworkDomain?: RelayRequestDomain;
}

initializeNetworkDomainOrigins();

export function setPluginRequestConfig(config: { pluginId: string }): void {
	pluginRequestConfig = config;
}

/**
 * Set device management configuration for headers.
 * Called from main.ts after DeviceManager is initialized.
 */
export function setDeviceManagementConfig(config: {
	vaultId: string;
	deviceId: string;
}): void {
	deviceManagementConfig = config;
}

export function getPluginRequestHeaders(): Record<string, string> {
	if (!pluginRequestConfig?.pluginId) {
		return {};
	}
	return {
		"Obsidian-Plugin-Id": pluginRequestConfig.pluginId,
	};
}

/**
 * Get device management headers if enabled.
 * Returns empty object if not enabled or not configured.
 */
export function getDeviceManagementHeaders(): Record<string, string> {
	if (flags().enableDeviceManagement && deviceManagementConfig) {
		return {
			"Device-Id": deviceManagementConfig.deviceId,
			"Vault-Id": deviceManagementConfig.vaultId,
		};
	}
	return {};
}

export function getRelayRequestHeaders(): Record<string, string> {
	return {
		"Relay-Version": GIT_TAG,
		"Obsidian-Version": apiVersion,
		...getPluginRequestHeaders(),
		...getDeviceManagementHeaders(),
	};
}

export function setNetworkDomainUrls(config: {
	apiUrl?: string;
	authUrl?: string;
}): void {
	addNetworkDomainOrigin("api", config.apiUrl);
	addNetworkDomainOrigin("auth", config.authUrl);
}

function initializeNetworkDomainOrigins(): void {
	addNetworkDomainOrigin("api", safeBuildConstant(() => API_URL));
	addNetworkDomainOrigin("auth", safeBuildConstant(() => AUTH_URL));
}

function safeBuildConstant(read: () => string): string | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

function addNetworkDomainOrigin(domain: "api" | "auth", url: string | undefined): void {
	if (!url) return;
	try {
		networkDomainOrigins[domain].add(new URL(url).origin);
	} catch {
		// Ignore malformed runtime configuration; the request will be labeled external.
	}
}

function classifyNetworkDomain(
	urlString: string,
	override?: RelayRequestDomain,
): RelayRequestDomain {
	if (override) return override;
	try {
		const origin = new URL(urlString).origin;
		if (networkDomainOrigins.auth.has(origin)) return "auth";
		if (networkDomainOrigins.api.has(origin)) return "api";
	} catch {
		return "external";
	}
	return "external";
}

function getNowMs(): number {
	return typeof performance !== "undefined" && performance.now
		? performance.now()
		: Date.now();
}

function getStatusResult(status: number | undefined): NetworkResult {
	return status !== undefined && status < 400 ? "success" : "error";
}

function recordRequestMetrics(args: {
	domain: NetworkDomain;
	method: string;
	status?: number;
	durationMs: number;
	responseBytes: number;
	result?: NetworkResult;
}): void {
	metrics.recordNetworkRequest(
		args.domain,
		"http",
		args.method,
		args.status,
		args.durationMs / 1000,
		args.responseBytes,
		args.result ?? getStatusResult(args.status),
	);
}

const NODE_HTTPS_WRITE_BYTES = 1024 * 1024;

async function nodeHttpsRequest(
	urlString: string,
	config: RelayRequestInit,
	domain: NetworkDomain,
	method: string,
): Promise<Response> {
	if (!(config.body instanceof ArrayBuffer)) {
		throw new Error("Node HTTPS diagnostic transport requires an ArrayBuffer body");
	}

	const body = Buffer.from(config.body);
	const requestHeaders: Record<string, string> = {};
	new Headers(config.headers).forEach((value, name) => {
		requestHeaders[name] = value;
	});
	requestHeaders["content-length"] = body.byteLength.toString();

	const startMs = getNowMs();
	try {
		return await new Promise<Response>((resolve, reject) => {
			const request = https.request(
				urlString,
				{ method, headers: requestHeaders },
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer | string) => {
						chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
					});
					response.on("error", reject);
					response.on("end", () => {
						const responseBody = Buffer.concat(chunks);
						const status = response.statusCode ?? 500;
						const responseHeaders = new Headers();
						for (const [name, value] of Object.entries(response.headers)) {
							if (Array.isArray(value)) {
								for (const item of value) responseHeaders.append(name, item);
							} else if (value !== undefined) {
								responseHeaders.append(name, value);
							}
						}
						recordRequestMetrics({
							domain,
							method,
							status,
							durationMs: getNowMs() - startMs,
							responseBytes: responseBody.byteLength,
						});
						resolve(
							new Response(responseBody, {
								status,
								statusText: response.statusMessage,
								headers: responseHeaders,
							}),
						);
					});
				},
			);
			request.on("error", reject);

			let offset = 0;
			const writeNext = () => {
				while (offset < body.byteLength) {
					const end = Math.min(offset + NODE_HTTPS_WRITE_BYTES, body.byteLength);
					const writable = request.write(body.subarray(offset, end));
					offset = end;
					if (!writable) {
						request.once("drain", writeNext);
						return;
					}
				}
				request.end();
			};
			writeNext();
		});
	} catch (error) {
		recordRequestMetrics({
			domain,
			method,
			durationMs: getNowMs() - startMs,
			responseBytes: 0,
			result: "error",
		});
		throw error;
	}
}

export async function requestUrlWithMetrics(
	params: RelayRequestUrlParam,
): Promise<RequestUrlResponse> {
	const domain = classifyNetworkDomain(params.url, params.relayNetworkDomain);
	const method = params.method ?? "GET";
	const requestParams: RequestUrlParam = { ...params };
	delete (requestParams as RelayRequestUrlParam).relayNetworkDomain;
	const startMs = getNowMs();
	try {
		const response = await obsidianRequestUrl(requestParams);
		recordRequestMetrics({
			domain,
			method,
			status: response.status,
			durationMs: getNowMs() - startMs,
			responseBytes: response.arrayBuffer?.byteLength ?? 0,
		});
		return response;
	} catch (error) {
		recordRequestMetrics({
			domain,
			method,
			durationMs: getNowMs() - startMs,
			responseBytes: 0,
			result: "error",
		});
		throw error;
	}
}

if (globalThis.Response === undefined || globalThis.Headers === undefined) {
	// Fetch API is broken for some versions of Electron
	// https://github.com/electron/electron/pull/42419
	try {
		console.warn(
			"[Relay] Polyfilling Fetch API (Electron Bug: https://github.com/electron/electron/pull/42419)",
		);
		if ((globalThis as any).blinkfetch) {
			globalThis.fetch = (globalThis as any).blinkfetch;
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
		console.warn(
			"[Relay] Polyfilling EventSource API required, but unable to polyfill on Mobile",
		);
	} else {
		console.warn("[Relay] Polyfilling EventSource API");
		// @ts-ignore
		globalThis.EventSource = require("eventsource");
	}
}

export const customFetch = async (
	url: RequestInfo | URL,
	config?: RelayRequestInit,
): Promise<Response> => {
	// Convert URL object to string if necessary
	const urlString = url instanceof URL ? url.toString() : (url as string);

	const method = config?.method || "GET";
	const domain = classifyNetworkDomain(urlString, config?.relayNetworkDomain);
	if (config?.relayUseNodeHttps) {
		return nodeHttpsRequest(urlString, config, domain, method);
	}

	const headers = Object.assign(
		{},
		config?.headers,
		getRelayRequestHeaders(),
	) as Record<string, string>;

	// Prepare the request parameters
	const requestParams: RequestUrlParam = {
		url: urlString,
		method: method,
		body: config?.body as string | ArrayBuffer,
		headers: headers,
		throw: false,
	};

	let response: RequestUrlResponse | undefined = undefined;
	const startMs = getNowMs();
	try {
		response = await obsidianRequestUrl(requestParams);
	} catch (error: any) {
		recordRequestMetrics({
			domain,
			method,
			durationMs: getNowMs() - startMs,
			responseBytes: 0,
			result: "error",
		});
		// Handle Electron networking errors gracefully to prevent complete networking failure
		if (error?.message?.includes("net::ERR_FAILED")) {
			// Return a proper error response instead of throwing
			return new Response(JSON.stringify({ error: "Network request failed" }), {
				status: 503,
				statusText: "Service Unavailable",
				headers: new Headers({ "content-type": "application/json" }),
			});
		}
		// Re-throw other errors
		throw error;
	}
	recordRequestMetrics({
		domain,
		method,
		status: response.status,
		durationMs: getNowMs() - startMs,
		responseBytes: response.arrayBuffer.byteLength,
	});

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
	const json = async () => {
		return JSON.parse(response!.text);
	};
	Object.defineProperty(fetchResponse, "json", {
		value: json,
	});

	if (flags().enableNetworkLogging) {
		const level =
			response.status >= 500
				? "error"
				: response.status >= 400
					? "warn"
					: "debug";
		const response_text = response.text;

		let response_json;
		const contentType = response.headers["content-type"] || "";
		if (contentType.includes("application/json")) {
			try {
				response_json = JSON.parse(response_text);
			} catch (e) {
				// pass
			}
		}

		curryLog("[CustomFetch]", level)(
			response.status.toString(),
			method,
			urlString,
			response_json || response_text,
		);
	}

	if (response.status >= 500) {
		throw new Error(response.text);
	}

	return fetchResponse;
};
