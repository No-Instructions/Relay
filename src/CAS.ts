import { Platform } from "obsidian";
import { isRetryableHttpError } from "./HttpError";
import { generateHash } from "./hashing";
import {
	ATTACHMENT_CHUNK_BYTES, ATTACHMENT_RETRY_DELAYS_MS, AttachmentChangedError,
	AttachmentUploadTimeoutError, checkAttachmentAbort, desktopAttachmentIO, hashAttachment,
	streamAttachmentPut, withAttachmentRetry, type AttachmentVersion,
} from "./AttachmentIO";
import { downloadAttachment, probeAttachmentSize } from "./AttachmentDownload";
import type { LiveTokenStore } from "./LiveTokenStore";
import { S3RN } from "./S3RN";
import type { SharedFolder } from "./SharedFolder";
import type { SyncFile } from "./SyncFile";
import { customFetch } from "./customFetch";
import PocketBase from "pocketbase";
import { HasLogging } from "./debug";
import {
	s3ApiErrorFromResponse,
	s3ApiErrorFromUnknown,
	s3NetworkFailureFromUnknown,
} from "./S3Error";

export interface ContentAddressedStoreOptions {
	transferRetryDelaysMs?: readonly number[];
}

export class ContentAddressedStore extends HasLogging {
	private pb: PocketBase;
	private tokenStore: LiveTokenStore;
	private transferRetryDelaysMs: readonly number[];

	constructor(
		private sharedFolder: SharedFolder,
		options?: ContentAddressedStoreOptions,
	) {
		super();
		const authUrl = sharedFolder.loginManager.getEndpointManager().getAuthUrl();
		this.pb = new PocketBase(authUrl, sharedFolder.loginManager.authStore);
		this.tokenStore = sharedFolder.tokenStore;
		this.transferRetryDelaysMs =
			options?.transferRetryDelaysMs ?? ATTACHMENT_RETRY_DELAYS_MS;
	}

	async verify(syncFile: SyncFile): Promise<boolean> {
		if (!syncFile.meta) {
			throw new Error("cannot head file with missing hash");
		}
		const sha256 = syncFile.meta.hash;
		const token = await this.tokenStore.getFileToken(
			S3RN.encode(syncFile.s3rn),
			sha256,
			syncFile.mimetype,
			0,
		);
		const response = await this.s3Request(
			() =>
				customFetch(token.baseUrl!, {
					method: "HEAD",
					headers: { Authorization: `Bearer ${token.token}` },
					relayNetworkDomain: "relay",
				}),
			"verify attachment",
		);
		return response.status === 200;
	}

	async readFile(syncFile: SyncFile): Promise<ArrayBuffer> {
		if (!syncFile.meta) {
			throw new Error("cannot pull file with missing hash");
		}
		const sha256 = syncFile.meta.hash;
		const mimetype = syncFile.mimetype;
		const documentId = S3RN.encode(syncFile.s3rn);
		const meta = syncFile.meta;
		return this.withTransientRetry("download attachment", async () => {
			const token = await this.tokenStore.getFileToken(
				documentId,
				sha256,
				mimetype,
				0,
			);
			const response = await customFetch(token.baseUrl + "/download-url", {
				method: "GET",
				headers: { Authorization: `Bearer ${token.token}` },
				relayNetworkDomain: "relay",
			});
			if (!response.ok) {
				this.debug(
					`[${this.sharedFolder.path}] File download-url failed: ${response.status} for ${syncFile.guid} ${meta.hash} ${meta.type}`,
				);
				throw await this.s3ResponseError(response, "download attachment url");
			}
			const responseJson = (await response.json()) as { downloadUrl: string };
			const presignedUrl = responseJson.downloadUrl;
			const downloadResponse = await this.s3Request(
				() => customFetch(presignedUrl, { relayNetworkDomain: "external" }),
				"download attachment",
			);
			if (!downloadResponse.ok) {
				throw await this.s3ResponseError(
					downloadResponse,
					"download attachment",
				);
			}
			return downloadResponse.arrayBuffer();
		});
	}

	/**
	 * Run a transfer, retrying transient failures (5xx/throttle-class answers
	 * and network-level transport errors) a bounded number of times with
	 * jittered backoff. Uploads can also re-read a changed file within the
	 * same budget. The error that escapes stays classified for the queue.
	 */
	private withTransientRetry<T>(
		operation: string,
		request: () => Promise<T>,
		shouldRetry: (error: unknown) => boolean = isRetryableHttpError,
	): Promise<T> {
		return withAttachmentRetry(
			async () => {
				try {
					return await request();
				} catch (error) {
					throw s3NetworkFailureFromUnknown(error, operation) ?? error;
				}
			},
			// Release the shared transfer slot after a deadline. The background queue can retry.
			(error) => !(error instanceof AttachmentUploadTimeoutError) && shouldRetry(error),
			this.transferRetryDelaysMs,
			(delayMs, attempt, error) => {
				this.debug(
					`transient ${operation} failure (attempt ${attempt}); retrying in ${delayMs}ms`,
					error,
				);
				return new Promise<void>((resolve) =>
					this.sharedFolder.timeProvider.setTimeout(resolve, delayMs),
				);
			},
		);
	}

	private async downloadUrl(syncFile: SyncFile, hash: string): Promise<string> {
		const token = await this.tokenStore.getFileToken(S3RN.encode(syncFile.s3rn), hash, syncFile.mimetype, 0);
		const response = await customFetch(token.baseUrl + "/download-url", { headers: { Authorization: `Bearer ${token.token}` }, relayNetworkDomain: "relay" });
		if (!response.ok) throw await this.s3ResponseError(response, "download attachment url");
		return (await response.json() as { downloadUrl: string }).downloadUrl;
	}

	async fileSize(syncFile: SyncFile, hash: string): Promise<number> {
		return this.s3Request(async () => probeAttachmentSize(await this.downloadUrl(syncFile, hash)), "probe attachment size");
	}

	async downloadTo(syncFile: SyncFile, path: string, signal: AbortSignal, progress: (bytes: number, total: number) => void): Promise<void> {
		const meta = syncFile.meta!;
		const getUrl = async () => {
			checkAttachmentAbort(signal);
			return this.downloadUrl(syncFile, meta.hash);
		};
		await this.s3Request(() => downloadAttachment(syncFile.vault, getUrl, path, meta.hash, signal, progress), "download attachment");
	}

	private async writeStreaming(syncFile: SyncFile, knownVersion?: AttachmentVersion): Promise<AttachmentVersion> {
		const manager = this.sharedFolder.attachmentTransfers!;
		const task = syncFile.attachmentTask();
		return manager.run(task, async (row, signal) => {
			let candidate = knownVersion;
			let version: AttachmentVersion | undefined;
			return this.withTransientRetry("upload attachment", async () => {
				checkAttachmentAbort(signal);
				if (!version) {
					row.phase = "preparing";
					const current = candidate ? await syncFile.vault.adapter.stat(task.path) : null;
					const reusable = candidate && current?.size === candidate.size && current.mtime === candidate.mtime
						? candidate
						: undefined;
					candidate = undefined;
					version = reusable ?? await hashAttachment(syncFile.vault, task.path, signal);
					manager.check(task, version.size, {
						serverMaxBytes: this.sharedFolder.remote?.relay.storageQuota?.maxFileSize,
					});
				}
				const expected = version;
				const token = await this.tokenStore.getFileToken(S3RN.encode(syncFile.s3rn), expected.hash, syncFile.mimetype, expected.size);
				const response = await customFetch(token.baseUrl + "/upload-url", { method: "POST", headers: { Authorization: `Bearer ${token.token}` }, relayNetworkDomain: "relay" });
				if (!response.ok) throw await this.s3ResponseError(response, "upload attachment url");
				const { uploadUrl } = await response.json() as { uploadUrl: string };
				row.phase = "uploading"; row.bytes = 0; row.total = expected.size; manager.notifyListeners();
				let reportedBytes = 0;
				const status = await streamAttachmentPut(syncFile.vault, uploadUrl, task.path, expected, syncFile.mimetype, signal, bytes => {
					if (bytes !== expected.size && bytes - reportedBytes < ATTACHMENT_CHUNK_BYTES) return;
					reportedBytes = bytes;
					row.bytes = bytes;
					manager.notifyListeners();
				}).catch((error) => {
					if (error instanceof AttachmentChangedError) version = undefined;
					throw error;
				});
				if (status < 200 || status >= 300) throw s3ApiErrorFromResponse(status, "", "upload attachment");
				return expected;
			}, (error) => error instanceof AttachmentChangedError || isRetryableHttpError(error));
		});
	}

	async writeFile(syncFile: SyncFile, knownVersion?: AttachmentVersion): Promise<AttachmentVersion | undefined> {
		if (!this.sharedFolder.canWriteContent) {
			throw new Error(
				`Cannot upload ${syncFile.path}: read-only access`,
			);
		}
		const size = syncFile.stat.size;
		if (await this.shouldStreamUpload(syncFile, size)) return this.writeStreaming(syncFile, knownVersion);
		return this.s3Request(() => this.writeBuffered(syncFile, size), "upload attachment");
	}

	private async shouldStreamUpload(file: SyncFile, size: number): Promise<boolean> {
		const manager = this.sharedFolder.attachmentTransfers;
		if (!manager) return false;
		manager.check(file.attachmentTask(), size, {
			serverMaxBytes: this.sharedFolder.remote?.relay.storageQuota?.maxFileSize, mobileUpload: Platform.isMobile,
		});
		return manager.shouldStreamUpload(size) && !!await desktopAttachmentIO(file.vault);
	}

	private async writeBuffered(syncFile: SyncFile, plannedSize: number): Promise<AttachmentVersion> {
		const mtime = syncFile.stat.mtime;
		const content = await syncFile.caf.read();
		if (!content) throw new Error("Attachment is missing");
		if (content.byteLength !== plannedSize && await this.shouldStreamUpload(syncFile, content.byteLength)) {
			return this.writeStreaming(syncFile, { hash: await generateHash(content), size: content.byteLength, mtime });
		}
		const hash = await generateHash(content);
		this.log("writeFile", hash);
		if (!(content && hash)) {
			throw new Error("invalid caf");
		}
		const token = await this.tokenStore.getFileToken(
			S3RN.encode(syncFile.s3rn),
			hash,
			syncFile.mimetype,
			content.byteLength,
		);
		const response = await customFetch(token.baseUrl + "/upload-url", {
			method: "POST",
			headers: { Authorization: `Bearer ${token.token}` },
			relayNetworkDomain: "relay",
		});
		if (response.status !== 200) {
			throw await this.s3ResponseError(response, "upload attachment url");
		}
		const responseJson = (await response.json()) as { uploadUrl: string };
		const presignedUrl = responseJson.uploadUrl;
		const uploadResponse = await this.s3Request(
			() =>
				customFetch(presignedUrl, {
					method: "PUT",
					headers: { "Content-Type": syncFile.mimetype },
					body: content,
					relayNetworkDomain: "external",
					useSystemCAs: true,
				}),
			"upload attachment",
		);
		if (!uploadResponse.ok) {
			throw await this.s3ResponseError(uploadResponse, "upload attachment");
		}
		return { hash, size: content.byteLength, mtime };
	}

	private async s3Request<T>(
		request: () => Promise<T>,
		operation: string,
	): Promise<T> {
		try {
			return await request();
		} catch (error) {
			throw (
				s3ApiErrorFromUnknown(error, operation) ??
				s3NetworkFailureFromUnknown(error, operation) ??
				error
			);
		}
	}

	private async s3ResponseError(
		response: Response,
		operation: string,
	): Promise<Error> {
		let body = "";
		try {
			body = await response.text();
		} catch {
			// Ignore body parsing errors; the status still carries useful context.
		}
		return s3ApiErrorFromResponse(response.status, body, operation);
	}

	public destroy() {
		this.pb.cancelAllRequests();
		this.pb = null as unknown as typeof this.pb;
		this.tokenStore = null as unknown as typeof this.tokenStore;
		this.sharedFolder = null as unknown as typeof this.sharedFolder;
	}
}
