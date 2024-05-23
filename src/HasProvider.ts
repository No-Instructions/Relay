"use strict";
import { Doc } from "yjs";
import { YSweetProvider } from "@y-sweet/client";
import { User } from "./User";
import { curryLog } from "./debug";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";
import type { ClientToken } from "./y-sweet";
import { promiseWithTimeout } from "./promiseUtils";

export type ConnectionStatus =
	| "connected"
	| "connecting"
	| "disconnected"
	| "unknown";
export type ConnectionIntent = "connected" | "disconnected";

export interface ConnectionState {
	status: ConnectionStatus;
	intent: ConnectionIntent;
}

export interface Subscription {
	on: () => void;
	off: () => void;
}

function makeProvider(
	clientToken: ClientToken,
	guid: string,
	ydoc: Doc,
	user: User
): YSweetProvider {
	const params = {
		token: clientToken.token,
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

type Listener = (state: ConnectionState) => void;

export class HasProvider {
	_provider: YSweetProvider;
	guid: string;
	path?: string;
	ydoc: Doc;
	loginManager: LoginManager;
	tokenStore: LiveTokenStore;
	clientToken: ClientToken | null;
	state: ConnectionState;
	private _offConnectionError: () => void;
	private _offState: () => void;
	PROVIDER_MAX_ERRORS = 3;
	log = curryLog("[HasProvider]");
	listeners: Map<any, Listener>;

	constructor(
		guid: string,
		tokenStore: LiveTokenStore,
		loginManager: LoginManager
	) {
		this.guid = guid;
		this.listeners = new Map<any, Listener>();
		this.loginManager = loginManager;
		this.ydoc = new Doc();
		this.tokenStore = tokenStore;
		this.clientToken =
			this.tokenStore.getTokenSync(this.guid) ||
			({ token: "", url: "", expiryTime: 0 } as ClientToken);
		const user = this.loginManager?.user;
		this._provider = makeProvider(
			this.clientToken,
			this.guid,
			this.ydoc,
			user
		);
		this.state = {
			status: "unknown",
			intent: this._provider.shouldConnect ? "connected" : "disconnected",
		};

		const connectionErrorSub = this.providerConnectionErrorSubscription(
			(event) => {
				this.log(`[${this.path}] disconnection event: ${event}`);
				console.log(this._provider, this.clientToken);
				this._provider.disconnect();
				this.connect();
			}
		);
		connectionErrorSub.on();
		this._offConnectionError = connectionErrorSub.off;

		const stateSub = this.providerStateSubscription(
			(state: ConnectionState) => {
				this.state = state;
				this.listeners.forEach((listener, el) => {
					listener(this.state);
				});
			}
		);
		stateSub.on();
		this._offState = stateSub.off;
	}

	subscribe(el: any, listener: Listener) {
		this.listeners.set(el, listener);
	}

	unsubscribe(el: any) {
		this.listeners.delete(el);
	}

	async getProviderToken(): Promise<ClientToken> {
		this.log("get provider token");

		const tokenPromise = this.tokenStore.getToken(
			this.guid,
			this.path || "unknown",
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
			const tokenIsSet = this._provider.url == this.clientToken.url;
			const expired = Date.now() > (this.clientToken?.expiryTime || 0);
			return tokenIsSet && !expired;
		}
		return false;
	}

	refreshProvider(clientToken: ClientToken) {
		// updates the provider when a new token is received
		this.clientToken = clientToken;
		const params = {
			token: clientToken.token,
		};
		const tempDoc = new Doc();
		const tempProvider = new YSweetProvider(
			clientToken.url,
			this.guid,
			tempDoc,
			{
				connect: false,
				params: params,
				disableBc: true,
			}
		);
		const newUrl = tempProvider.url;

		if (!this._provider) {
			throw new Error("missing provider!");
		} else if (this._provider.url !== newUrl) {
			this._provider.url = newUrl;
			this._provider.wsUnsuccessfulReconnects = 0;
			this.log(
				`Token Refreshed: setting new provider url, ${this._provider.url}`
			);
			this._provider.ws?.close();
		}
	}

	connect(): Promise<boolean> {
		if (this._provider.wsconnected) {
			return Promise.resolve(true);
		}
		return this.getProviderToken()
			.then((clientToken) => {
				this.refreshProvider(clientToken); // XXX is this still needed?
				this._provider.connect();
				return true;
			})
			.catch((e) => {
				return false;
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
			const resolveOnConnect = (state: ConnectionState) => {
				if (state.status === "connected") {
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

	private _injectIntent(
		f: (state: ConnectionState) => void
	): (state: ConnectionState) => void {
		const inner = (state: ConnectionState) => {
			const intent = this._provider.shouldConnect
				? "connected"
				: "disconnected";
			f({ status: state.status, intent: intent });
		};
		return inner;
	}

	private providerConnectionErrorSubscription(
		f: (state: ConnectionState) => void
	): Subscription {
		const on = () => {
			this._provider.on("connection-error", this._injectIntent(f));
		};
		const off = () => {
			this._provider.off("connection-error", this._injectIntent(f));
		};
		return { on, off } as Subscription;
	}

	protected providerStateSubscription(
		f: (state: ConnectionState) => void
	): Subscription {
		const on = () => {
			this._provider.on("status", this._injectIntent(f));
		};
		const off = () => {
			this._provider.off("status", this._injectIntent(f));
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
		if (this._offState) {
			this._offState();
		}
		if (this._provider) {
			this._provider.disconnect();
			this._provider.destroy();
		}
		this.listeners.clear();
	}
}
