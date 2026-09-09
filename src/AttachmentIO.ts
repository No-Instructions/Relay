import { Platform, type Vault } from "obsidian";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { S3ApiError, s3NetworkFailureFromUnknown } from "./S3Error";

export const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
export function attachmentHasher() {
	if (Platform.isDesktopApp) {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { createHash } = require("crypto") as typeof import("crypto");
		const hash = createHash("sha256");
		return {
			update: (bytes: Uint8Array) => { hash.update(bytes); },
			digest: (): Uint8Array => hash.digest(),
			destroy: () => { hash.destroy(); },
		};
	}
	return sha256.create();
}
export function attachmentDigest(hash: ReturnType<typeof attachmentHasher>): string {
	return bytesToHex(hash.digest());
}
export function checkAttachmentAbort(signal: AbortSignal): void {
	if (signal.aborted) throw new AttachmentCancelledError();
}
export class AttachmentCancelledError extends Error {
	constructor() { super("Attachment transfer cancelled"); this.name = "AttachmentCancelledError"; }
}

/** Resolve Node only on desktop; mobile bundles never load native modules. */
export function desktopAttachmentIO(vault: Vault) {
	if (!Platform.isDesktopApp) return undefined;
	const adapter = vault.adapter as typeof vault.adapter & { getFullPath?: (path: string) => string };
	if (!adapter.getFullPath) return undefined;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs") as typeof import("fs");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const http = require("http") as typeof import("http");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const https = require("https") as typeof import("https");
		return { fs, http, https, fullPath: (path: string) => adapter.getFullPath!(path) };
	} catch { return undefined; }
}

export interface AttachmentVersion { hash: string; size: number; mtime: number }

/** Bounded reads also bound snapshot writes; no unawaited writes retain chunks. */
export async function snapshotAttachment(
	vault: Vault, path: string, snapshot: string | undefined, signal: AbortSignal,
	progress: (bytes: number, total: number) => void = () => {},
): Promise<AttachmentVersion> {
	const io = desktopAttachmentIO(vault);
	if (!io) throw new Error("Desktop file streaming is unavailable");
	const source = await io.fs.promises.open(io.fullPath(path), "r");
	let output: import("fs/promises").FileHandle | undefined;
	const hash = attachmentHasher();
	try {
		const before = await source.stat();
		if (!before.isFile()) throw new Error("Attachment is not a file");
		if (snapshot) output = await io.fs.promises.open(io.fullPath(snapshot), "wx");
		const buffer = new Uint8Array(ATTACHMENT_CHUNK_BYTES);
		let offset = 0;
		while (offset < before.size) {
			checkAttachmentAbort(signal);
			const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
			if (!bytesRead) throw new Error("Attachment changed while reading");
			hash.update(buffer.subarray(0, bytesRead));
			if (output) {
				let written = 0;
				while (written < bytesRead) {
					const result = await output.write(buffer, written, bytesRead - written, offset + written);
					if (!result.bytesWritten) throw new Error("Unable to write attachment snapshot");
					written += result.bytesWritten;
				}
			}
			offset += bytesRead;
			progress(offset, before.size);
		}
		checkAttachmentAbort(signal);
		const after = await source.stat();
		const current = await io.fs.promises.stat(io.fullPath(path));
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
			before.ino !== current.ino || before.size !== current.size || before.mtimeMs !== current.mtimeMs) {
			throw new Error("Attachment changed while reading");
		}
		return { hash: attachmentDigest(hash), size: offset, mtime: Math.round(before.mtimeMs) };
	} finally {
		hash.destroy();
		await source.close();
		await output?.close();
	}
}

/** Ordinary presigned PUT with a known length, not AWS chunk-signing or multipart. */
export async function streamAttachmentPut(
	vault: Vault, url: string, snapshot: string, size: number, contentType: string,
	signal: AbortSignal, progress: (bytes: number) => void,
): Promise<number> {
	const io = desktopAttachmentIO(vault);
	if (!io) throw new Error("Desktop file streaming is unavailable");
	checkAttachmentAbort(signal);
	const target = new URL(url);
	if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Unsupported upload URL");
	return new Promise((resolve, reject) => {
		const source = io.fs.createReadStream(io.fullPath(snapshot), { highWaterMark: ATTACHMENT_CHUNK_BYTES });
		let settled = false;
		const finish = (error?: Error, status?: number) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			source.destroy();
			request.destroy();
			if (error) reject(error); else resolve(status!);
		};
		const request = (target.protocol === "https:" ? io.https : io.http).request(target, {
			method: "PUT", headers: { "Content-Length": String(size), "Content-Type": contentType },
		}, response => {
			response.on("error", error => finish(new S3ApiError({ code: "NetworkingError", operation: "upload attachment" }, error)));
			response.resume();
			response.on("end", () => finish(undefined, response.statusCode ?? 0));
		});
		const abort = () => finish(new AttachmentCancelledError());
		signal.addEventListener("abort", abort, { once: true });
		request.on("error", error => finish(s3NetworkFailureFromUnknown(error, "upload attachment") ?? error));
		source.on("error", error => finish(error));
		let sent = 0;
		source.on("data", chunk => { sent += chunk.length; progress(sent); });
		if (signal.aborted) abort(); else source.pipe(request);
	});
}
