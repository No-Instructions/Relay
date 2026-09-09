import type { Vault } from "obsidian";
import { requestUrlWithMetrics } from "./customFetch";
import { s3ApiErrorFromResponse } from "./S3Error";
import { ATTACHMENT_CHUNK_BYTES, attachmentHasher, attachmentDigest, checkAttachmentAbort } from "./AttachmentIO";

/** Range responses are buffered by Obsidian; each awaited append releases one chunk. */
export async function downloadAttachment(
	vault: Vault, source: string | (() => Promise<string>), path: string, expectedHash: string, signal: AbortSignal,
	progress: (bytes: number, total: number) => void,
): Promise<number> {
	let url = typeof source === "string" ? source : await source();
	const get = async (start: number, end: number) => {
		for (let attempt = 0; ; attempt++) {
			checkAttachmentAbort(signal);
			let response;
			try {
				response = await requestUrlWithMetrics({ url, headers: { Range: `bytes=${start}-${end}` }, throw: false, relayNetworkDomain: "external" });
			} catch (error) {
				checkAttachmentAbort(signal);
				if (attempt < 2) continue;
				throw error;
			}
			// requestUrl cannot abort: retain the transfer slot until it settles.
			checkAttachmentAbort(signal);
			if (attempt < 2 && response.status === 403 && typeof source !== "string") { url = await source(); continue; }
			if (attempt < 2 && (response.status === 429 || response.status >= 500)) continue;
			if (response.status >= 400 && response.status !== 416) throw s3ApiErrorFromResponse(response.status, response.text ?? "", "download attachment");
			return response;
		}
	};
	const probe = await get(0, 0);
	const size = attachmentSizeFromProbe(probe);
	const hash = attachmentHasher();
	try {
		await vault.adapter.writeBinary(path, new ArrayBuffer(0));
		for (let offset = 0; offset < size;) {
			const end = Math.min(size, offset + ATTACHMENT_CHUNK_BYTES) - 1;
			const response = await get(offset, end);
			if (response.status !== 206 || contentRange(response.headers) !== `bytes ${offset}-${end}/${size}` || response.arrayBuffer.byteLength !== end - offset + 1) throw new Error("Attachment byte range was incomplete");
			hash.update(new Uint8Array(response.arrayBuffer));
			await vault.adapter.appendBinary(path, response.arrayBuffer);
			offset = end + 1;
			progress(offset, size);
		}
		checkAttachmentAbort(signal);
		if (attachmentDigest(hash) !== expectedHash) throw new Error("Attachment checksum did not match");
		if ((await vault.adapter.stat(path))?.size !== size) throw new Error("Attachment size did not match");
		return size;
	} finally { hash.destroy(); }
}


function contentRange(headers: Record<string, string>): string {
	return Object.entries(headers).find(([key]) => key.toLowerCase() === "content-range")?.[1] ?? "";
}

function attachmentSizeFromProbe(probe: { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }): number {
	const range = /^bytes 0-0\/(\d+)$/.exec(contentRange(probe.headers));
	const empty = probe.status === 416 && contentRange(probe.headers) === "bytes */0";
	if (!empty && (probe.status !== 206 || !range || probe.arrayBuffer.byteLength !== 1)) throw new Error("Attachment server did not return the requested byte range");
	const size = empty ? 0 : Number(range![1]);
	if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid attachment size");
	return size;
}

/** Read object metadata with a one-byte range; no file contents are persisted. */
export async function probeAttachmentSize(url: string): Promise<number> {
	const response = await requestUrlWithMetrics({ url, headers: { Range: "bytes=0-0" }, throw: false, relayNetworkDomain: "external" });
	if (response.status >= 400 && response.status !== 416) throw s3ApiErrorFromResponse(response.status, response.text ?? "", "probe attachment size");
	return attachmentSizeFromProbe(response);
}
