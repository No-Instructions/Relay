// This file is the Obsidian Live variant of the token store.
import { TokenStore } from "./TokenStore";
import { DefaultTimeProvider } from "./TimeProvider";
import type { TokenInfo } from "./TokenStore";
import type { TimeProvider } from "./TimeProvider";
import { LoginManager } from "./LoginManager";
import { requestUrl } from "obsidian";
import { curryLog } from "./debug";
import type { ClientToken } from "./y-sweet";
import { LocalStorage } from "./LocalStorage";
import { S3RN, S3Document, S3Relay, type S3RNType } from "./S3RN";

declare const API_URL: string;

function getJwtExpiryFromClientToken(clientToken: ClientToken): number {
	// lol this is so fake
	return clientToken.expiryTime || 0;
}

function withLoginManager(
	loginManager: LoginManager,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	fn: (...args: any[]) => void
) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (...args: any[]) => fn(loginManager, ...args);
}

async function refresh(
	loginManager: LoginManager,
	documentId: string,
	onSuccess: (clientToken: ClientToken) => void,
	onError: (err: Error) => void
) {
	const headers = {
		Authorization: `Bearer ${loginManager.user.token}`,
	};
	const log = curryLog("[TokenStore][Refresh]");
	log(`${documentId}`);
	const entity: S3RNType = S3RN.decode(documentId);
	let payload: string;
	if (entity instanceof S3Document) {
		payload = JSON.stringify({
			docId: entity.documentId,
			relay: entity.relayId,
		});
	} else if (entity instanceof S3Relay) {
		payload = JSON.stringify({
			relay: entity.relayId,
			docId: entity.relayId,
		});
	} else {
		throw new Error("Invalid type");
	}
	if (!loginManager.loggedIn) {
		onError(Error("Not logged in"));
		return;
	}
	requestUrl({
		url: `${API_URL}/token`,
		method: "POST",
		headers: headers,
		body: payload,
	})
		.then((response) => {
			if (response.status !== 200) {
				log(response.status, response.text);
				onError(
					Error(
						`Received status code ${response.status} from an API.`
					)
				);
			}
			const clientToken = response.json as ClientToken;
			onSuccess(clientToken);
		})
		.catch((reason) => {
			console.error(payload);
			console.error(reason);
			onError(reason);
		});
}

export class LiveTokenStore extends TokenStore<ClientToken> {
	constructor(
		loginManager: LoginManager,
		timeProvider: TimeProvider,
		vaultName: string,
		maxConnections = 5
	) {
		super(
			{
				log: curryLog("[LiveTokenStore]"),
				refresh: withLoginManager(loginManager, refresh),
				getJwtExpiry: getJwtExpiryFromClientToken,
				getStorage: function () {
					return new LocalStorage<TokenInfo<ClientToken>>(
						"TokenStore/" + vaultName
					);
				},
				getTimeProvider: () => {
					return timeProvider;
				},
			},
			maxConnections
		);
	}
}
