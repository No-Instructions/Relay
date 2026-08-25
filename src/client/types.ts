// From https://github.com/drifting-in-space/y-sweet/blob/main/js-pkg/sdk/src/main.ts

// MIT License
//
// Copyright (c) 2023 Drifting in Space Corp.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export interface ClientToken {
	/** The bare URL of the WebSocket endpoint to connect to. The `doc` string will be appended to this. */
	url: string;

	baseUrl?: string;

	/** A unique identifier for the document that the token connects to. */
	docId: string;
	folder: string;

	token: string;

	authorization?: "full" | "read-only";
	expiryTime?: number;
	contentType?: number;
	contentLength?: number;
	fileHash?: number;
}

export interface FileToken extends ClientToken {
	authorization: "full" | "read-only";

	docId: string;
	folder: string;

	token: string;

	expiryTime: number;
	contentType: number;
	contentLength: number;
	fileHash: number;
}

function stringToBase64(input: string) {
	return btoa(input);
}

function base64ToString(input: string) {
	return atob(input);
}

export function encodeClientToken(token: ClientToken): string {
	const jsonString = JSON.stringify(token);
	let base64 = stringToBase64(jsonString);
	base64 = base64.replace("+", "-").replace("/", "_").replace(/=+$/, "");
	return base64;
}

export function decodeClientToken(token: string): ClientToken {
	let base64 = token.replace("-", "+").replace("_", "/");
	while (base64.length % 4) {
		base64 += "=";
	}
	const jsonString = base64ToString(base64);
	return JSON.parse(jsonString);
}
