import { Platform, type Vault } from "obsidian";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { watchRequestDeadlines, type RequestDeadlines } from "./NodeRequestDeadlines";
import { S3ApiError, s3NetworkFailureFromUnknown } from "./S3Error";

export const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
const ATTACHMENT_UPLOAD_WRITE_BYTES = 64 * 1024;
// After the body enters the kernel, Node exposes no acknowledgement counter. A
// separate bound lets a slow receiver drain that queue without hiding a stall forever.
const ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS = 30 * 60_000;

/** Incremental SHA-256 over chunks: digest once, then destroy. */
export interface AttachmentHasher {
	update(bytes: Uint8Array): void;
	digest(): Uint8Array;
	destroy(): void;
}

type NodeCrypto = typeof import("crypto");
let nodeCrypto: NodeCrypto | undefined;

/** Node's crypto on desktop, loaded once on first use; mobile bundles never load native modules. */
async function desktopCrypto(): Promise<NodeCrypto | undefined> {
	if (Platform.isDesktop && Platform.isDesktopApp) {
		try {
			nodeCrypto ??= await import("crypto");
		} catch {
			return undefined;
		}
		return nodeCrypto;
	}
	return undefined;
}

export async function attachmentHasher(): Promise<AttachmentHasher> {
	const crypto = await desktopCrypto();
	if (crypto) {
		const hash = crypto.createHash("sha256");
		return {
			update: (bytes: Uint8Array) => { hash.update(bytes); },
			digest: (): Uint8Array => hash.digest(),
			destroy: () => { hash.destroy(); },
		};
	}
	return sha256.create();
}
export function attachmentDigest(hash: AttachmentHasher): string {
	return bytesToHex(hash.digest());
}
export function checkAttachmentAbort(signal: AbortSignal): void {
	if (signal.aborted) throw new AttachmentCancelledError();
}
export class AttachmentCancelledError extends Error {
	constructor() { super("Attachment transfer cancelled"); this.name = "AttachmentCancelledError"; }
}

/** Node's fs and http on desktop, resolved on use; mobile bundles never load native modules. */
export async function desktopAttachmentIO(vault: Vault) {
	const adapter = vault.adapter as typeof vault.adapter & { getFullPath?: (path: string) => string };
	if (!adapter.getFullPath) return undefined;
	if (Platform.isDesktop && Platform.isDesktopApp) {
		try {
			const [fs, http, https] = await Promise.all([import("fs"), import("http"), import("https")]);
			return { fs, http, https, fullPath: (path: string) => adapter.getFullPath!(path) };
		} catch { return undefined; }
	}
	return undefined;
}

export interface AttachmentVersion { hash: string; size: number; mtime: number }

export async function hashAttachment(
	vault: Vault, path: string, signal: AbortSignal,
	progress: (bytes: number, total: number) => void = () => {},
): Promise<AttachmentVersion> {
	const io = await desktopAttachmentIO(vault);
	if (!io) throw new Error("Desktop file streaming is unavailable");
	const source = await io.fs.promises.open(io.fullPath(path), "r");
	const hash = await attachmentHasher();
	try {
		const before = await source.stat();
		if (!before.isFile()) throw new Error("Attachment is not a file");
		const buffer = new Uint8Array(ATTACHMENT_CHUNK_BYTES);
		let offset = 0;
		while (offset < before.size) {
			checkAttachmentAbort(signal);
			const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
			if (!bytesRead) throw new Error("Attachment changed while reading");
			hash.update(buffer.subarray(0, bytesRead));
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
	}
}

export class AttachmentUploadTimeoutError extends S3ApiError {
	constructor() { super({ code: "RequestTimeout", operation: "upload attachment" }); }
}

export class AttachmentChangedError extends Error {
	constructor() { super("Attachment changed during upload"); }
}

/** Ordinary presigned PUT with a known length, not AWS chunk-signing or multipart. */
export async function streamAttachmentPut(
	vault: Vault, url: string, path: string, version: AttachmentVersion, contentType: string,
	signal: AbortSignal, progress: (bytes: number) => void, deadlines: RequestDeadlines = {},
): Promise<number> {
	const io = await desktopAttachmentIO(vault);
	if (!io) throw new Error("Desktop file streaming is unavailable");
	checkAttachmentAbort(signal);
	const target = new URL(url);
	if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Unsupported upload URL");
	const fullPath = io.fullPath(path);
	const before = await io.fs.promises.stat(fullPath);
	if (before.size !== version.size || Math.round(before.mtimeMs) !== version.mtime) {
		throw new AttachmentChangedError();
	}
	const { Transform } = await import("stream");
	const hash = await attachmentHasher();
	const { size } = version;
	return new Promise((resolve, reject) => {
		const source = io.fs.createReadStream(fullPath, { highWaterMark: ATTACHMENT_UPLOAD_WRITE_BYTES });
		let read = 0;
		let tail: Buffer | undefined;
		let verified = false;
		// A presigned PUT commits when Content-Length bytes arrive. Hold the final
		// chunk until EOF proves both the length and the hash of the outgoing body.
		const verifier = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				read += chunk.length;
				if (read > size) return done(new AttachmentChangedError());
				hash.update(chunk);
				if (read === size) {
					tail = chunk;
					done();
				} else {
					progress(read);
					done(null, chunk);
				}
			},
			flush(done) {
				if (read !== size || attachmentDigest(hash) !== version.hash) return done(new AttachmentChangedError());
				// Detect edits to an already-sent chunk and replacement of the path.
				void io.fs.promises.stat(fullPath).then(current => {
					if (before.dev !== current.dev || before.ino !== current.ino || before.ctimeMs !== current.ctimeMs) {
						return done(new AttachmentChangedError());
					}
					if (signal.aborted) return done(new AttachmentCancelledError());
					verified = true;
					progress(read);
					done(null, tail);
				}, done);
			},
		});
		let settled = false;
		const finish = (error?: Error, status?: number) => {
			if (settled) return;
			settled = true;
			clearDeadlines();
			signal.removeEventListener("abort", abort);
			source.destroy();
			verifier.destroy();
			hash.destroy();
			request.destroy();
			if (error) reject(error); else resolve(status!);
		};
		const request = (target.protocol === "https:" ? io.https : io.http).request(target, {
			method: "PUT", headers: { "Content-Length": String(size), "Content-Type": contentType },
		}, response => {
			response.on("error", error => finish(new S3ApiError({ code: "NetworkingError", operation: "upload attachment" }, error)));
			response.resume();
			response.on("end", () => {
				const status = response.statusCode ?? 0;
				if (status >= 200 && status < 300 && !verified) {
					finish(new Error("Upload acknowledged before checksum verification"));
				} else {
					finish(undefined, status);
				}
			});
		});
		const clearDeadlines = watchRequestDeadlines(request, target, () => finish(new AttachmentUploadTimeoutError()), {
			finishedWriteTimeoutMs: ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS,
			...deadlines,
		});
		const abort = () => finish(new AttachmentCancelledError());
		signal.addEventListener("abort", abort, { once: true });
		request.on("error", error => finish(s3NetworkFailureFromUnknown(error, "upload attachment") ?? error));
		source.on("error", error => finish(error));
		verifier.on("error", error => finish(error));
		if (signal.aborted) abort(); else source.pipe(verifier).pipe(request);
	});
}
