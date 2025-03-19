import type { LiveTokenStore } from "./LiveTokenStore";
import { S3RN } from "./S3RN";
import type { SharedFolder } from "./SharedFolder";
import type { SyncFile } from "./SyncFile";
import { customFetch } from "./customFetch";
import PocketBase from "pocketbase";
import { HasLogging } from "./debug";

declare const AUTH_URL: string;

export class ContentAddressedStore extends HasLogging {
	private pb: PocketBase;
	private tokenStore: LiveTokenStore;

	constructor(sharedFolder: SharedFolder) {
		super();
		this.pb = new PocketBase(AUTH_URL, sharedFolder.loginManager.authStore);
		this.tokenStore = sharedFolder.tokenStore;
	}

	async readFile(syncFile: SyncFile): Promise<ArrayBuffer> {
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
		});
		const responseJson = await response.json();
		const presignedUrl = responseJson.downloadUrl;
		const downloadResponse = await customFetch(presignedUrl);
		return downloadResponse.arrayBuffer();
	}

	async writeFile(syncFile: SyncFile): Promise<void> {
		await syncFile.caf.sha256();
		const content = syncFile.caf.content;
		const hash = syncFile.caf.value;
		this.warn("writeFile", hash);
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
		});
		const responseJson = await response.json();
		const presignedUrl = responseJson.uploadUrl;
		await customFetch(presignedUrl, {
			method: "PUT",
			headers: { "Content-Type": syncFile.mimetype },
			body: content,
		});
		return;
	}

	public destroy() {
		this.pb.cancelAllRequests();
		this.pb = null as any;
		this.tokenStore = null as any;
	}
}
