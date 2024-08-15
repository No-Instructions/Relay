"use strict";
import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { curryLog } from "./debug";

// Complete Response polyfill with static methods
const ResponsePolyfill: typeof Response =
	typeof Response !== "undefined"
		? Response
		: class {
				constructor(body?: BodyInit | null, init?: ResponseInit) {
					this._body = body;
					this.status = init?.status ?? 200;
					this.statusText = init?.statusText ?? "";
					this.headers = new Headers(init?.headers);
					this.type = "default";
					this.redirected = false;
					this.ok = this.status >= 200 && this.status < 300;
					this._url = "";
				}

				static error(): Response {
					return new ResponsePolyfill(null, {
						status: 0,
						statusText: "",
					});
				}

				static json(data: any, init?: ResponseInit): Response {
					const body = JSON.stringify(data);
					return new ResponsePolyfill(body, {
						...init,
						headers: {
							...init?.headers,
							"Content-Type": "application/json",
						},
					});
				}

				static redirect(
					url: string | URL,
					status: number = 302
				): Response {
					if (status < 300 || status > 399) {
						throw new RangeError("Invalid status code");
					}
					return new ResponsePolyfill(null, {
						status,
						headers: { Location: url.toString() },
					});
				}

				readonly body: ReadableStream<Uint8Array> | null = null;
				readonly bodyUsed: boolean = false;
				readonly headers: Headers;
				readonly ok: boolean;
				readonly redirected: boolean;
				readonly status: number;
				readonly statusText: string;
				readonly type: ResponseType;

				private _body: BodyInit | null | undefined;
				private _url: string;

				get url(): string {
					return this._url;
				}

				set url(value: string) {
					this._url = value;
				}

				clone(): Response {
					const cloned = new ResponsePolyfill(this._body, {
						status: this.status,
						statusText: this.statusText,
						headers: new Headers(this.headers),
					});
					(cloned as typeof this)._url = this.url;
					return cloned;
				}

				arrayBuffer(): Promise<ArrayBuffer> {
					return Promise.resolve(
						this._body instanceof ArrayBuffer
							? this._body
							: new ArrayBuffer(0)
					);
				}

				blob(): Promise<Blob> {
					return Promise.resolve(new Blob([this._body as BlobPart]));
				}

				formData(): Promise<FormData> {
					throw new Error(
						"formData() is not implemented in this polyfill"
					);
				}

				json(): Promise<any> {
					return Promise.resolve(JSON.parse(this._body as string));
				}

				text(): Promise<string> {
					return Promise.resolve(this._body as string);
				}
		  };

// Adjusted customFetch function to match PocketBase's expected signature
export const customFetch = async (
	url: RequestInfo | URL,
	config?: RequestInit
): Promise<Response> => {
	// Convert URL object to string if necessary
	const urlString = url instanceof URL ? url.toString() : (url as string);

	const method = config?.method || "GET";

	// Prepare the request parameters
	const requestParams: RequestUrlParam = {
		url: urlString,
		method: method,
		body: config?.body as string | ArrayBuffer,
		headers: config?.headers as Record<string, string>,
		throw: false,
	};

	let response: RequestUrlResponse | undefined = undefined;

	response = await requestUrl(requestParams);
	// Convert Obsidian's response to a format compatible with the Fetch API
	if (Response === undefined) {
		console.warn("Response is undefined, using polyfill");
		global["Response"] = ResponsePolyfill;
		Response = ResponsePolyfill;
	}

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
			: "log";
	const response_text = response.text;
	curryLog("[CustomFetch]", level)(
		response.status.toString(),
		method,
		urlString,
		response_text
	);
	if (response.status >= 500) {
		throw new Error(response_text);
	}

	return fetchResponse;
};
