// This file is the Obsidian Live variant of the token store.
import { TokenStore, TokenInfo } from "./TokenStore";
import { LoginManager } from "./LoginManager";
import { requestUrl } from "obsidian";
import { curryLog } from "./debug";
import { ClientToken } from "./y-sweet";
import { LocalStorage } from "./LocalStorage";

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
	const log = curryLog("[refresh]");
	log(`{docId: ${documentId}}`);
	requestUrl({
		url: "https://api.dnup.org/doc/token",
		method: "POST",
		headers: headers,
		body: JSON.stringify({ docId: documentId }),
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
			if (response.headers["x-tf-cached"] === "True") {
				console.warn("Overfetched token");
				console.log(response.headers);
			}
			const clientToken = response.json as ClientToken;
			onSuccess(clientToken);
		})
		.catch((reason) => {
			onError(reason);
		});
}

export class LiveTokenStore extends TokenStore<ClientToken> {
	constructor(
		loginManager: LoginManager,
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
			},
			maxConnections
		);
	}
}
