"use strict";
import { Doc } from "yjs";
import { YSweetProvider } from "@y-sweet/client";
import { User } from "./User";
import { curryLog } from "./debug";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";
import { ClientToken } from "./y-sweet";
import { promiseWithTimeout } from "./promiseUtils";

export interface Status {
	status: "connected" | "connecting" | "disconnected";
}

export interface Subscription {
	on: () => void;
	off: () => void;
}

export class HasProvider {
	_provider: YSweetProvider;
	guid: string;
	user: User;
	path: string;
	ydoc: Doc;
	loginManager: LoginManager;
	tokenStore: LiveTokenStore;
	clientToken: ClientToken | null;
	_status: Status;
	private _offConnectionError: () => void;
	private _offStatus: () => void;
	PROVIDER_MAX_ERRORS = 3;
	log = curryLog("[HasProvider]");

	constructor(guid: string, tokenStore: LiveTokenStore) {
		this.guid = guid;
		this.ydoc = new Doc();
		this.tokenStore = tokenStore;
		this._status = { status: "disconnected" };
		const url = this.tokenStore.getTokenSync(this.guid)?.url || "";
		const token = this.tokenStore.getTokenSync(this.guid)?.token;
		this._provider = new YSweetProvider(url, this.guid, this.ydoc, {
			connect: false,
			params: token ? { token: token } : {},
			disableBc: true,
		});

		const connectionErrorSub = this.providerConnectionErrorSubscription(
			(event) => {
				this.log(`[${this.path}] disconnection event: ${event}`);
				console.log(this._provider);
				this.disconnect();
			}
		);
		connectionErrorSub.on();
		this._offConnectionError = connectionErrorSub.off;

		const statusSub = this.providerStatusSubscription((status: Status) => {
			this._status = status;
		});
		statusSub.on();
		this._offStatus = statusSub.off;
	}

	get status(): Status {
		if (this._provider.wsconnected) {
			this._status = { status: "connected" };
		} else if (this._provider.wsconnecting) {
			this._status = { status: "connecting" };
		} else {
			this._status = { status: "disconnected" };
		}
		return this._status;
	}

	async getProviderToken(): Promise<ClientToken> {
		this.log("get provider token");

		const tokenPromise = this.tokenStore.getToken(
			this.guid,
			this.path,
			this.refreshProvider.bind(this)
		);
		return promiseWithTimeout<ClientToken>(tokenPromise, 10000);
	}

	providerActive() {
		if (this.clientToken) {
			const tokenSet = this._provider.url == this.clientToken.url;
			const expired = Date.now() > (this.clientToken?.exprityTime || 0);
			return tokenSet && !expired;
		}
		return false;
	}

	refreshProvider(clientToken: ClientToken | null, err: Error | null) {
		// updates the provider when a new token is received
		this.log("refreshProvider");
		if (err || !clientToken) {
			return;
		}
		this.clientToken = clientToken;
		console.log(clientToken);
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
		const user = this.loginManager?.user;
		if (user) {
			this._provider.awareness.setLocalStateField("user", {
				name: user.name,
				color: user.color.color,
				colorLight: user.color.light,
			});
		}

		if (!this._provider) {
			this._provider = tempProvider;
		} else if (this._provider.url !== tempProvider.url) {
			this._provider.url = tempProvider.url;
			this.log(
				`Token Refreshed: setting new provider url, ${this._provider.url}`
			);
			if (this._provider.wsconnected) {
				this._provider.disconnect();
				this._provider.connect();
			} else if (this._provider.shouldConnect) {
				this._provider.connect();
			}
		}
	}

	connect() {
		this.getProviderToken().then((clientToken) => {
			this._provider.connect();
		});
	}

	disconnect() {
		if (this._provider) {
			this._provider.disconnect();
		}
	}

	public withActiveProvider<T extends HasProvider>(this: T): Promise<T> {
		if (this.providerActive()) {
			return new Promise((resolve) => {
				resolve(this);
			});
		}
		return this.getProviderToken().then((clientToken) => {
			return this;
		});
	}

	onceConnected(): Promise<void> {
		// XXX memory leak of subscriptions...
		return new Promise((resolve) => {
			const resolveOnConnect = (status: Status) => {
				if (status.status === "connected") {
					resolve();
				}
			};
			this._provider.on("status", resolveOnConnect);
		});
	}

	onceProviderSynced(): Promise<void> {
		if (this._provider?.synced) {
			return new Promise((resolve) => {
				resolve();
			});
		}
		return new Promise((resolve) => {
			this._provider.once("synced", resolve);
		});
	}

	private providerConnectionErrorSubscription(
		f: (status: Status) => void
	): Subscription {
		const on = () => {
			this._provider.on("connection-error", f);
		};
		const off = () => {
			this._provider.off("connection-error", f);
		};
		return { on, off } as Subscription;
	}

	public providerStatusSubscription(
		f: (status: Status) => void
	): Subscription {
		const on = () => {
			this._provider.on("status", f);
		};
		const off = () => {
			this._provider.off("status", f);
		};
		return { on, off } as Subscription;
	}

	public get connected(): boolean {
		return this._provider?.wsconnected || false;
	}

	destroy() {
		if (this._offConnectionError) {
			this._offConnectionError();
		}
		if (this._offStatus) {
			this._offStatus();
		}
		if (this._provider) {
			this._provider.disconnect();
			this._provider.destroy();
		}
	}
}
