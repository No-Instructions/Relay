"use strict";
import { Doc } from "yjs";
import { YSweetProvider } from "@y-sweet/client";
import { User } from "./User";
import { curryLog } from "./debug";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";
import { ClientToken } from "./y-sweet";
import { promiseWithTimeout } from "./promiseUtils";
import { TokenStore } from "./TokenStore";

export interface Status {
	status: "connected" | "connecting" | "disconnected";
}

export interface Subscription {
	on: () => void;
	off: () => void;
}

function generateRandomString(): string {
	let result = "";
	const characters =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const charactersLength = characters.length;
	for (let i = 0; i < 16; i++) {
		result += characters.charAt(
			Math.floor(Math.random() * charactersLength)
		);
	}
	return result;
}

function makeProvider(
	clientToken: ClientToken,
	guid: string,
	ydoc: Doc,
	user?: User
) {
	const params = {
		token: clientToken.token || "",
		r: generateRandomString(),
	};
	const provider = new YSweetProvider(clientToken.url, guid, ydoc, {
		connect: false,
		params: params,
		disableBc: true,
	});
	if (user) {
		provider.awareness.setLocalStateField("user", {
			name: user.name,
			color: user.color.color,
			colorLight: user.color.light,
		});
	} else {
		console.log("user missing...");
	}
	return provider;
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
		const clientToken =
			this.tokenStore.getTokenSync(this.guid) ||
			({ token: "", url: "", exprityTime: 0 } as ClientToken);
		const user = this.loginManager?.user;
		this._provider = makeProvider(clientToken, this.guid, this.ydoc, user);

		const connectionErrorSub = this.providerConnectionErrorSubscription(
			(event) => {
				this.log(`[${this.path}] disconnection event: ${event}`);
				console.log(this._provider);
				if (this.clientToken) {
					this.refreshProvider(this.clientToken);
				}
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
		const timeoutPromise = promiseWithTimeout<ClientToken>(
			tokenPromise,
			10000
		);
		return timeoutPromise;
	}

	providerActive() {
		if (this.clientToken) {
			const tokenSet = this._provider.url == this.clientToken.url;
			const expired = Date.now() > (this.clientToken?.exprityTime || 0);
			return tokenSet && !expired;
		}
		return false;
	}

	refreshProvider(clientToken: ClientToken) {
		// updates the provider when a new token is received
		this.log("refreshProvider");
		this.clientToken = clientToken;
		console.log(clientToken);

		const user = this.loginManager?.user;
		const provider = makeProvider(clientToken, this.guid, this.ydoc, user);

		if (!this._provider) {
			this._provider = provider;
		} else if (this._provider.url !== provider.url) {
			// XXX revisit whether this is helpful vs. just setting a new provider
			this._provider.url = provider.url;
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
