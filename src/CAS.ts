import type { LiveTokenStore } from "./LiveTokenStore";
import { S3RN } from "./S3RN";
import type { SharedFolder } from "./SharedFolder";
import type { SyncFile } from "./SyncFile";
import { customFetch } from "./customFetch";
import PocketBase from "pocketbase";
import { HasLogging } from "./debug";
import { s3ApiErrorFromResponse, s3ApiErrorFromUnknown } from "./S3Error";


export class ContentAddressedStore extends HasLogging {
	private pb: PocketBase;
	private tokenStore: LiveTokenStore;

	constructor(private sharedFolder: SharedFolder) {
		super();
		const authUrl = sharedFolder.loginManager.getEndpointManager().getAuthUrl();
		this.pb = new PocketBase(authUrl, sharedFolder.loginManager.authStore);
		this.tokenStore = sharedFolder.tokenStore;
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

	async getDownloadUrl(syncFile: SyncFile): Promise<string> {
		if (!syncFile.meta) {
			throw new Error("cannot pull file with missing hash");
		}
		const sha256 = syncFile.meta.hash;
		const token = await this.tokenStore.getFileToken(
			S3RN.encode(syncFile.s3rn),
			sha256,
			syncFile.mimetype,
			0,
		);
		const response = await customFetch(token.baseUrl + "/download-url", {
			method: "GET",
			headers: { Authorization: `Bearer ${token.token}` },
			relayNetworkDomain: "relay",
		});
		if (!response.ok) {
			throw new Error(
				`[${this.sharedFolder.path}] File download-url failed: ${response.status} for ${syncFile.guid} ${syncFile.meta.hash} ${syncFile.meta.type}`,
			);
		}
		const responseJson = await response.json();
		return responseJson.downloadUrl;
	}

	async readFile(syncFile: SyncFile): Promise<ArrayBuffer> {
		const presignedUrl = await this.getDownloadUrl(syncFile);
		const downloadResponse = await this.s3Request(
			() => customFetch(presignedUrl, { relayNetworkDomain: "external" }),
			"download attachment",
		);
		if (!downloadResponse.ok) {
			throw await this.s3ResponseError(downloadResponse, "download attachment");
		}
		return downloadResponse.arrayBuffer();
	}

	async writeFile(syncFile: SyncFile): Promise<void> {
		const content = await syncFile.caf.read();
		const hash = await syncFile.caf.hash();
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
		const responseJson = await response.json();
		if (response.status !== 200) {
			throw new Error(responseJson.error);
		}
		const presignedUrl = responseJson.uploadUrl;
		const uploadResponse = await this.s3Request(
			() =>
				customFetch(presignedUrl, {
					method: "PUT",
					headers: { "Content-Type": syncFile.mimetype },
					body: content,
					relayNetworkDomain: "external",
				}),
			"upload attachment",
		);
		if (!uploadResponse.ok) {
			throw await this.s3ResponseError(uploadResponse, "upload attachment");
		}
		return;
	}

	private async s3Request(
		request: () => Promise<Response>,
		operation: string,
	): Promise<Response> {
		try {
			return await request();
		} catch (error) {
			throw s3ApiErrorFromUnknown(error, operation) ?? error;
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
		this.pb = null as any;
		this.tokenStore = null as any;
		this.sharedFolder = null as any;
	}
}
