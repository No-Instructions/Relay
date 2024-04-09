// This file is the Obsidian Live variant of the token store.
import jwt from "jsonwebtoken";

import { TokenStore } from "./TokenStore";
import { LoginManager } from "./LoginManager";
import { requestUrl } from "obsidian";
import { curryLog } from "./debug";
import { ClientToken } from "./y-sweet";

function getJwtExpiryFromClientToken(clientToken: ClientToken): number {
	// lol this is so fake
	return Date.now() + 1000 * 60 * 30;
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
	requestUrl({
		url: "https://api.dnup.org/doc/token",
		method: "POST",
		headers: headers,
		body: JSON.stringify({ docId: documentId }),
	}).then((response) => {
		if (response.status !== 200) {
			onError(
				Error(`Received status code ${response.status} from an API.`)
			);
		}
		const clientToken = response.json as ClientToken;
		onSuccess(clientToken);
	});
}

export class LiveTokenStore extends TokenStore<ClientToken> {
	constructor(loginManager: LoginManager, maxConnections = 5) {
		super(
			{
				log: curryLog("[LiveTokenStore]"),
				refresh: withLoginManager(loginManager, refresh),
				getJwtExpiry: getJwtExpiryFromClientToken,
			},
			maxConnections
		);
	}
}
