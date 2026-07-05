"use strict";

import type { DataAdapter, DataWriteOptions } from "obsidian";
import { createIncrementalSha256, type IncrementalHasher } from "./incrementalSha256";
import { curryLog } from "./debug";

export const STREAMING_CHUNK_BYTES = 16 * 1024 * 1024;
const PARTS_DIR = ".relay/parts";
const MAX_CONCURRENT_STREAMS = 2;
const CHUNK_FETCH_ATTEMPTS = 3;

export type AppendCapableAdapter = DataAdapter & {
	appendBinary(
		normalizedPath: string,
		data: ArrayBuffer,
		options?: DataWriteOptions,
	): Promise<void>;
};

export function supportsStreamingDownloads(
	adapter: DataAdapter,
): adapter is AppendCapableAdapter {
	return (
		typeof (adapter as unknown as Record<string, unknown>).appendBinary ===
		"function"
	);
}

export class HashMismatchError extends Error {
	constructor(expected: string, actual: string) {
		super(`downloaded content hash ${actual} does not match address ${expected}`);
		this.name = "HashMismatchError";
	}
}

export interface StreamingDownloadRequest {
	adapter: AppendCapableAdapter;
	guid: string;
	/** Content address the finished part file must hash to. */
	expectedHash: string;
	/** Returns a (fresh) presigned download URL; called again if one expires. */
	getUrl: () => Promise<string>;
	fetchFn: (url: string, init: RequestInit) => Promise<Response>;
	delay?: (ms: number) => Promise<void>;
	chunkBytes?: number;
}

export interface StreamingDownloadResult {
	partPath: string;
	size: number;
}

/** In-session resume state per part path; parts on disk without an entry are stale. */
const resumable = new Map<string, { offset: number; hasher: IncrementalHasher }>();

let activeStreams = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
	if (activeStreams < MAX_CONCURRENT_STREAMS) {
		activeStreams++;
		return;
	}
	await new Promise<void>((resolve) => waiters.push(resolve));
	activeStreams++;
}

function releaseSlot(): void {
	activeStreams--;
	waiters.shift()?.();
}

function defaultDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function partPathForGuid(guid: string): string {
	return `${PARTS_DIR}/${guid}.part`;
}

let cleanedThisSession = false;

/**
 * Parts left by an earlier session cannot resume (their hash state is gone);
 * remove everything without an in-session resume entry.
 */
async function cleanupStaleParts(adapter: DataAdapter): Promise<void> {
	if (cleanedThisSession) return;
	cleanedThisSession = true;
	try {
		if (!(await adapter.exists(PARTS_DIR))) return;
		const listing = await adapter.list(PARTS_DIR);
		for (const file of listing.files) {
			if (!resumable.has(file)) {
				await adapter.remove(file).catch(() => {});
			}
		}
	} catch (error) {
		curryLog("[StreamingDownload]", "warn")("stale part cleanup failed", error);
	}
}

async function ensurePartsDir(adapter: DataAdapter): Promise<void> {
	if (!(await adapter.exists(".relay"))) {
		await adapter.mkdir(".relay");
	}
	if (!(await adapter.exists(PARTS_DIR))) {
		await adapter.mkdir(PARTS_DIR);
	}
}

function parseTotalFromContentRange(header: string | null): number | null {
	// Content-Range: bytes <start>-<end>/<total>
	const match = header?.match(/bytes \d+-\d+\/(\d+)/);
	return match ? parseInt(match[1], 10) : null;
}

/**
 * Download the content behind `getUrl` into a part file, at most one chunk in
 * memory, verifying the incremental hash against the content address. On
 * mismatch the part file is deleted and HashMismatchError is thrown. Returns
 * the verified part path for the caller to finalize.
 */
export async function downloadToPart(
	request: StreamingDownloadRequest,
): Promise<StreamingDownloadResult> {
	const { adapter, guid, expectedHash, getUrl, fetchFn } = request;
	const delay = request.delay ?? defaultDelay;
	const chunkBytes = request.chunkBytes ?? STREAMING_CHUNK_BYTES;
	const debug = curryLog(`[StreamingDownload](${guid})`, "debug");
	const partPath = partPathForGuid(guid);

	let offset = 0;
	let hasher = createIncrementalSha256();

	await acquireSlot();
	try {
		await cleanupStaleParts(adapter);
		await ensurePartsDir(adapter);

		const resume = resumable.get(partPath);
		if (resume && (await adapter.exists(partPath))) {
			const stat = await adapter.stat(partPath);
			if (stat?.size === resume.offset) {
				offset = resume.offset;
				hasher = resume.hasher;
				debug("resuming", { offset });
			}
		}
		resumable.delete(partPath);

		const writeChunk = async (chunk: ArrayBuffer) => {
			if (offset === 0) {
				await adapter.writeBinary(partPath, chunk);
			} else {
				await adapter.appendBinary(partPath, chunk);
			}
			hasher.update(new Uint8Array(chunk));
			offset += chunk.byteLength;
		};

		let total: number | null = null;
		while (total === null || offset < total) {
			const response = await fetchChunkWithRetry(
				getUrl,
				fetchFn,
				offset,
				chunkBytes,
				delay,
			);
			if (response.status === 206) {
				total = parseTotalFromContentRange(
					response.headers.get("Content-Range"),
				);
				if (total === null) {
					throw new Error("ranged response missing Content-Range total");
				}
				await writeChunk(await response.arrayBuffer());
			} else {
				// Server ignored Range: consume the full body as a stream.
				if (offset > 0) {
					// The 200 body restarts from byte zero; discard partial state.
					offset = 0;
					hasher = createIncrementalSha256();
				}
				const reader = response.body?.getReader();
				if (!reader) {
					// No streaming body available; bounded by this response only.
					await writeChunk(await response.arrayBuffer());
					total = offset;
					break;
				}
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					const copy = new Uint8Array(value.byteLength);
					copy.set(value);
					await writeChunk(copy.buffer);
				}
				total = offset;
			}
		}

		const actualHash = hasher.digestHex();
		if (actualHash !== expectedHash) {
			await adapter.remove(partPath).catch(() => {});
			throw new HashMismatchError(expectedHash, actualHash);
		}
		debug("part complete", { size: offset });
		return { partPath, size: offset };
	} catch (error) {
		if (!(error instanceof HashMismatchError) && offset > 0) {
			// writeChunk hashes only after a successful append, so offset and
			// hasher agree on the bytes in the part file; a retry this session
			// continues from here instead of refetching them.
			resumable.set(partPath, { offset, hasher });
		}
		throw error;
	} finally {
		releaseSlot();
	}
}

async function fetchChunkWithRetry(
	getUrl: () => Promise<string>,
	fetchFn: (url: string, init: RequestInit) => Promise<Response>,
	offset: number,
	chunkBytes: number,
	delay: (ms: number) => Promise<void>,
): Promise<Response> {
	let lastError: unknown;
	let url = await getUrl();
	for (let attempt = 0; attempt < CHUNK_FETCH_ATTEMPTS; attempt++) {
		try {
			const response = await fetchFn(url, {
				headers: {
					Range: `bytes=${offset}-${offset + chunkBytes - 1}`,
				},
			});
			if (response.status === 206 || response.status === 200) {
				return response;
			}
			if (response.status === 403) {
				// Presigned URLs expire mid-transfer on large files.
				url = await getUrl();
				lastError = new Error(`chunk fetch got ${response.status}`);
				continue;
			}
			throw new Error(`chunk fetch failed with status ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await delay(1000 * 2 ** attempt);
	}
	throw lastError instanceof Error
		? lastError
		: new Error("chunk fetch failed");
}

type FullPathAdapter = AppendCapableAdapter & {
	getFullPath(normalizedPath: string): string;
};

function nodeFsRename(
	adapter: AppendCapableAdapter,
	partPath: string,
	targetPath: string,
): Promise<void> | null {
	const fullPath = (adapter as FullPathAdapter).getFullPath;
	if (typeof fullPath !== "function") return null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = (globalThis as any).require?.("fs/promises");
		if (!fs?.rename) return null;
		return fs.rename(
			fullPath.call(adapter, partPath),
			fullPath.call(adapter, targetPath),
		) as Promise<void>;
	} catch {
		return null;
	}
}

/**
 * Move the verified part file over the target path. The target never holds
 * partial content and no vault delete is raised for it; the watcher reports
 * the replacement as a modify, which the caller's server-edit marker
 * recognizes as an echo.
 *
 * The adapter refuses to rename over an existing file, so replacement uses
 * the filesystem rename (atomic overwrite) when the runtime exposes it and a
 * buffered copy otherwise — degraded memory behavior, identical outcomes.
 */
export async function finalizePart(
	adapter: AppendCapableAdapter,
	partPath: string,
	targetPath: string,
): Promise<void> {
	if (!(await adapter.exists(targetPath))) {
		await adapter.rename(partPath, targetPath);
		return;
	}
	const fsRename = nodeFsRename(adapter, partPath, targetPath);
	if (fsRename) {
		await fsRename;
		return;
	}
	const content = await adapter.readBinary(partPath);
	await adapter.writeBinary(targetPath, content);
	await adapter.remove(partPath).catch(() => {});
}
