// This file is the Obsidian Live variant of the token store.
import { TokenStore } from "./TokenStore";
import type { TokenInfo } from "./TokenStore";
import type { TimeProvider } from "./TimeProvider";
import { LoginManager } from "./LoginManager";
import { curryLog } from "./debug";
import type { ClientToken } from "./y-sweet";
import { LocalStorage } from "./LocalStorage";
import { S3RN, S3RemoteDocument, type S3RNType, S3RemoteFolder } from "./S3RN";
import { customFetch } from "./customFetch";

declare const API_URL: string;
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
	} else if (entity instanceof S3RemoteFolder) {
		payload = JSON.stringify({
			docId: entity.folderId,
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
	};
	try {
		const response = await customFetch(`${API_URL}/token`, {
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
		loginManager: LoginManager,
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
}
