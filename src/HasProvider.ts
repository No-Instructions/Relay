"use strict";
import { Doc } from "yjs";
import { YSweetProvider, createYjsProvider } from "@y-sweet/client";
import { User } from "./User";
import { curryLog } from "./debug";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";
import { ClientToken } from "./y-sweet";

export interface Status {
	status: "connected" | "connecting" | "disconnected";
}

export interface Subscription {
	on: () => void;
	off: () => void;
}

export class HasProvider {
	_provider: YSweetProvider | null;
	_activePromise: Promise<YSweetProvider> | null;
	guid: string;
	user: User;
	path: string;
	ydoc: Doc;
	loginManager: LoginManager;
	tokenStore: LiveTokenStore;
	clientToken: ClientToken | null;
	private _offConnectionError: () => void;
	PROVIDER_MAX_ERRORS = 3;
	log = curryLog("[HasProvider]");

	async getProviderToken(): Promise<ClientToken> {
		return new Promise((resolve, reject) => {
			this.tokenStore
				.getToken(this.guid, this.path, this.refreshProvider.bind(this))
				.then(([clientToken, err]) => {
					if (clientToken) {
						resolve(clientToken);
					} else {
						reject(err);
					}
				});
		});
	}

	deauth() {
		this._provider?.destroy();
		this.clientToken = null;
	}

	//async getProviderToken(): Promise<ClientToken> {
	//	if (this.clientToken) {
	//		return this.clientToken;
	//	}
	//	this.clientToken = await this._getProviderToken();
	//	return this.clientToken as ClientToken;
	//}

	async getUser(): Promise<User> {
		const loginManager = this.loginManager;
		return new Promise((resolve) => {
			if (loginManager.hasUser) {
				return resolve(loginManager.user);
			}
			const withuser = () => {
				if (loginManager.hasUser) {
					return resolve(loginManager.user);
				}
			};
			const once = () => {
				loginManager.off(once);
				return withuser();
			};
			loginManager.on(once);
		});
	}

	refreshProvider(clientToken: ClientToken | null, err: Error | null) {
		this.log("refreshProvider");
		if (err || !clientToken) {
			return;
		}
		this.clientToken = clientToken;
		const tempProvider = new YSweetProvider(
			clientToken.url,
			this.guid,
			new Doc(),
			{
				connect: false,
				params: { token: clientToken.token },
				disableBc: true,
			}
		);
		if (!this._provider) {
			throw new Error("missing provider unexpectedly");
			this._provider = tempProvider;
		} else {
			this._provider.disconnect();
			this._provider.url = tempProvider.url;
		}
		this._provider.connect();
		this.log(
			`Token Refreshed: setting new provider url, ${this._provider.url}`
		);
	}

	getProvider(): Promise<YSweetProvider> {
		if (
			this._provider &&
			this._provider.wsUnsuccessfulReconnects > this.PROVIDER_MAX_ERRORS
		) {
			this._provider.destroy();
			this._provider = null;
			this._activePromise = null;
		}

		//if (this._provider) {
		//	const existsPromise: Promise<YSweetProvider> = new Promise(
		//		(resolve) => {
		//			if (this._provider) resolve(this._provider);
		//		}
		//	);
		//	return existsPromise;
		//}

		if (this._activePromise) {
			return this._activePromise;
		}

		const myPromise = this.getProviderToken().then((clientToken) => {
			const provider = createYjsProvider(this.ydoc, clientToken, {
				disableBc: true,
				connect: false,
			});
			const user = this.loginManager.user;
			provider.awareness.setLocalStateField("user", {
				name: user.name,
				color: user.color.color,
				colorLight: user.color.light,
			});
			return provider;
		});
		if (this._activePromise == null) {
			this._activePromise = myPromise;
		}
		return myPromise;
	}

	connect() {
		if (!this._provider) {
			throw new Error("Attempted to connect without a provider");
		}
		this._provider.connect();
	}

	disconnect() {
		if (this._provider) {
			this._provider.disconnect();
		}
	}

	public withProvider<T extends HasProvider>(this: T): Promise<T> {
		if (this._provider) {
			return new Promise((resolve) => {
				resolve(this);
			});
		}
		return this.getProvider().then((provider) => {
			this._provider = provider;

			this.providerConnectionErrorSubscription((status) => {
				this.disconnect();
			}).then((sub) => {
				sub.on();
				this._offConnectionError = sub.off;
			});
			return this;
		});
	}

	private providerConnectionErrorSubscription(
		f: (status: Status) => void
	): Promise<Subscription> {
		return this.withProvider().then((doc) => {
			return new Promise((resolve) => {
				const on = () => {
					if (!doc._provider) {
						throw new Error(
							"Attempted to add connection hooks without a provider"
						);
					}
					doc._provider.on("connection-error", f);
				};
				const off = () => {
					if (!doc._provider) {
						throw new Error(
							"Attempted to remove connection hooks without a provider"
						);
					}
					doc._provider.off("connection-error", f);
				};
				return resolve({ on, off });
			});
		});
	}

	public providerStatusSubscription(
		f: (status: Status) => void
	): Promise<Subscription> {
		return this.withProvider().then((doc) => {
			return new Promise((resolve) => {
				const on = () => {
					if (!doc._provider) {
						throw new Error(
							"Attempted to add status hooks without a provider"
						);
					}
					doc._provider.on("status", f);
				};
				const off = () => {
					if (!doc._provider) {
						throw new Error(
							"Attempted to remove status hooks without a provider"
						);
					}
					doc._provider.off("status", f);
				};
				return resolve({ on, off });
			});
		});
	}

	public get connected(): boolean {
		return this._provider?.wsconnected || false;
	}

	destroy() {
		if (this._offConnectionError) {
			this._offConnectionError();
		}
		if (this._provider) {
			this._provider.disconnect();
			this._provider.destroy();
			this._provider = null;
		}
	}
}
