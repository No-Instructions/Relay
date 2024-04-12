"use strict";
import { Doc } from "yjs";
import { YSweetProvider } from "@y-sweet/client";
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
	_provider: YSweetProvider;
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

	constructor(guid: string, tokenStore: LiveTokenStore) {
		this.guid = guid;
		this.ydoc = new Doc();
		this.tokenStore = tokenStore;
		this._provider = new YSweetProvider("", this.guid, this.ydoc, {
			connect: false,
			params: {},
			disableBc: true,
		});

		const connectionErrorSub = this.providerConnectionErrorSubscription(
			(status) => {
				this.log(
					`[${this.path}] disconnection status: ${status.status}`
				);
			}
		);
		connectionErrorSub.on();
		this._offConnectionError = connectionErrorSub.off;
	}

	async getProviderToken(): Promise<ClientToken> {
		this.log("get provider token");
		return this.tokenStore.getToken(
			this.guid,
			this.path,
			this.refreshProvider.bind(this)
		);
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
		if (this._provider && this._provider.wsconnected) {
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
		if (this._provider) {
			this._provider.disconnect();
			this._provider.destroy();
		}
	}
}
