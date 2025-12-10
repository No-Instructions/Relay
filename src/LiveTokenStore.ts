// This file is the Obsidian Live variant of the token store.
import { TokenStore } from "./TokenStore";
import type { TokenInfo } from "./TokenStore";
import type { TimeProvider } from "./TimeProvider";
import { LoginManager } from "./LoginManager";
import { curryLog } from "./debug";
import type { ClientToken, FileToken } from "./client/types";
import { LocalStorage } from "./LocalStorage";
import {
	S3RN,
	S3RemoteDocument,
	type S3RNType,
	S3RemoteFolder,
	S3RemoteFile,
	S3RemoteCanvas,
} from "./S3RN";
import { customFetch } from "./customFetch";

declare const GIT_TAG: string;

function getJwtExpiryFromClientToken(clientToken: ClientToken): number {
	// lol this is so fake
	return clientToken.expiryTime || 0;
}

function withLoginManager(
	loginManager: LoginManager,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	fn: (...args: any[]) => void,
) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (...args: any[]) => fn(loginManager, ...args);
}

async function refresh(
	loginManager: LoginManager,
	documentId: string,
	onSuccess: (clientToken: ClientToken) => void,
	onError: (err: Error) => void,
) {
	const debug = curryLog("[TokenStore][Refresh]", "debug");
	const error = curryLog("[TokenStore][Refresh]", "error");
	debug(`${documentId}`);
	const entity: S3RNType = S3RN.decode(documentId);
	let payload: string;
	if (entity instanceof S3RemoteDocument) {
		payload = JSON.stringify({
			docId: entity.documentId,
			relay: entity.relayId,
			folder: entity.folderId,
		});
	} else if (entity instanceof S3RemoteCanvas) {
		payload = JSON.stringify({
			docId: entity.canvasId,
			relay: entity.relayId,
			folder: entity.folderId,
		});
	} else if (entity instanceof S3RemoteFolder) {
		payload = JSON.stringify({
			docId: entity.folderId,
			relay: entity.relayId,
			folder: entity.folderId,
		});
	} else if (entity instanceof S3RemoteFile) {
		payload = JSON.stringify({
			docId: entity.fileId,
			relay: entity.relayId,
			folder: entity.folderId,
		});
	} else {
		onError(new Error("No remote to connect to"));
		return;
	}
	if (!loginManager.loggedIn) {
		onError(Error("Not logged in"));
		return;
	}
	const headers = {
		Authorization: `Bearer ${loginManager.user?.token}`,
		"Relay-Version": GIT_TAG,
		"Content-Type": "application/json",
	};
	try {
		const apiUrl = loginManager.getEndpointManager().getApiUrl();
		const response = await customFetch(`${apiUrl}/token`, {
			method: "POST",
			headers: headers,
			body: payload,
		});

		if (!response.ok) {
			debug(response.status, await response.text());
			onError(Error(`Received status code ${response.status} from an API.`));
			return;
		}

		const clientToken = (await response.json()) as ClientToken;
		onSuccess(clientToken);
	} catch (reason) {
		error(reason, payload);
		onError(reason as Error);
	}
}

export class LiveTokenStore extends TokenStore<ClientToken> {
	constructor(
		private loginManager: LoginManager,
		timeProvider: TimeProvider,
		vaultName: string,
		maxConnections = 5,
	) {
		super(
			{
				log: curryLog("[LiveTokenStore]", "debug"),
				refresh: withLoginManager(loginManager, refresh),
				getJwtExpiry: getJwtExpiryFromClientToken,
				getStorage: function () {
					return new LocalStorage<TokenInfo<ClientToken>>(
						"TokenStore/" + vaultName,
					);
				},
				getTimeProvider: () => {
					return timeProvider;
				},
			},
			maxConnections,
		);
	}

	private async getFileTokenFromNetwork(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileToken> {
		const key = `${documentId}${fileHash}`;
		const activePromise = this._activePromises.get(key);
		if (activePromise) {
			return activePromise as Promise<FileToken>;
		}
		this.tokenMap.set(documentId, {
			token: null,
			expiryTime: 0,
			attempts: 0,
		} as TokenInfo<ClientToken>);
		const sharedPromise = this.fetchFileToken(
			documentId,
			fileHash,
			contentType,
			contentLength,
		)
			.then((newToken: FileToken) => {
				const expiryTime = this.getJwtExpiry(newToken);
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				const existing = this.tokenMap.get(key)!;
				this.tokenMap.set(fileHash, {
					...existing,
					token: newToken,
					expiryTime,
				} as TokenInfo<FileToken>);
				this._activePromises.delete(key);
				return newToken;
			})
			.catch((err: Error) => {
				this._activePromises.delete(key);
				throw err;
			});
		this._activePromises.set(key, sharedPromise);
		return sharedPromise;
	}

	async fetchFileToken(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileToken> {
		const debug = curryLog("[TokenStore][Fetch]", "debug");
		debug(`${documentId}`);
		const entity: S3RNType = S3RN.decode(documentId);
		let payload: string;
		if (entity instanceof S3RemoteFile) {
			payload = JSON.stringify({
				docId: entity.fileId,
				relay: entity.relayId,
				folder: entity.folderId,
				hash: fileHash,
				contentType,
				contentLength,
			});
		} else {
			throw new Error(`No remote to connect to for ${documentId}`);
		}
		if (!this.loginManager.loggedIn) {
			throw new Error("Not logged in");
		}
		const headers = {
			Authorization: `Bearer ${this.loginManager.user?.token}`,
			"Relay-Version": GIT_TAG,
			"Content-Type": "application/json",
		};
		const apiUrl = this.loginManager.getEndpointManager().getApiUrl();
		const response = await customFetch(`${apiUrl}/file-token`, {
			method: "POST",
			headers: headers,
			body: payload,
		});

		if (!response.ok) {
			debug(response.status, await response.text());
			const responseJSON = await response.json();
			throw new Error(responseJSON.error);
		}

		const clientToken = (await response.json()) as FileToken;
		return clientToken;
	}

	async getFileToken(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileToken> {
		const key = `${documentId}${fileHash}`;
		const tokenInfo = this.tokenMap.get(key);
		if (tokenInfo && tokenInfo.token && this.isTokenValid(tokenInfo)) {
			this.log("token was valid, cache hit!");
			this._activePromises.delete(key);
			return Promise.resolve(tokenInfo.token as FileToken);
		}
		return this.getFileTokenFromNetwork(
			documentId,
			fileHash,
			contentType,
			contentLength,
		);
	}
}
