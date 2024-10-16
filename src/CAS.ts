import type { LoginManager } from "./LoginManager";
import type { FileInfo } from "./Relay";
import type { FileInfoDAO, RelayManager } from "./RelayManager";
import type { SharedFolder } from "./SharedFolder";
import { customFetch } from "./customFetch";
import { getMimeType } from "./mimetypes";
import PocketBase from "pocketbase";

declare const AUTH_URL: string;
declare const GIT_TAG: string;

export class ContentAddressedStore {
	private pb: PocketBase;

	constructor(
		private sharedFolder: SharedFolder,
		private relayManager: RelayManager,
		private loginManager: LoginManager,
	) {
		this.pb = new PocketBase(AUTH_URL, this.loginManager.authStore);
	}

	async listFiles(): Promise<FileInfo[]> {
		return this.relayManager.fileInfo
			.filter(
				(fileInfo) => fileInfo.sharedFolder.id === this.sharedFolder.remote?.id,
			)
			.values();
	}

	async getByHash(hash: string): Promise<FileInfo | undefined> {
		const local = this.relayManager.fileInfo.find(
			(fileInfo) => fileInfo.synchash === hash,
		);
		if (local) {
			return local;
		}
		try {
			const records = await this.pb
				?.collection("file_info")
				.getFullList({ fetch: customFetch });
			this.relayManager.store?.ingestBatch<FileInfo>(records);
		} catch (e) {
			// pass
		}
		return this.relayManager.fileInfo.find(
			(fileInfo) => fileInfo?.synchash === hash,
		);
	}

	async readFile(id: string): Promise<ArrayBuffer> {
		const fileInfo = this.relayManager.fileInfo.get(id);
		if (!fileInfo) throw new Error(`File not found: ${id}`);
		const response = await fileInfo.getAttachment();
		return response.arrayBuffer;
	}

	async writeFile(
		item: Partial<FileInfoDAO>,
		content: ArrayBuffer | null,
	): Promise<FileInfo> {
		if (!this.sharedFolder.remote) {
			throw new Error("missing remote");
		}
		const blob =
			content && item.name
				? new Blob([content], { type: getMimeType(item.name) })
				: null;
		const fileData: Partial<FileInfoDAO<Blob>> = {
			relay: this.sharedFolder.remote.relay.id,
			shared_folder: this.sharedFolder.remote?.id,
			guid: item.guid,
			name: item.name,
			synchash: item.synchash,
			ctime: item.ctime,
			mtime: item.mtime,
			parent: item.parentId,
			is_directory: item.isDirectory,
			fileInfo: item.fileInfo,
			synctime: item.synctime || 0,
		};
		if (blob) {
			fileData["attachment"] = blob;
		}

		const record = item.fileInfo
			? await this.pb.collection("file_info").update(item.fileInfo.id, fileData)
			: await this.pb.collection("file_info").create(fileData);
		const fileInfo = this.relayManager.store?.ingest<FileInfo>(record);
		if (!fileInfo) throw new Error("Failed to create file");

		return fileInfo;
	}

	async deleteFile(id: string): Promise<void> {
		await this.pb.collection("file_info").delete(id);
		this.relayManager.store?.cascade("file_info", id);
	}

	public destroy() {
		this.pb = null as any;
		this.relayManager = null as any;
		this.loginManager = null as any;
		this.sharedFolder = null as any;
	}
}
