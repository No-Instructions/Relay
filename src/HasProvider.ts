"use strict";
import * as Y from "yjs";
import {
	YSweetProvider,
	type ConnectionState,
	type ConnectionIntent,
} from "./client/provider";
export type { ConnectionState, ConnectionIntent };
import { User } from "./User";
import { HasLogging } from "./debug";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";
import type { ClientToken } from "./client/types";
import { S3RN, type S3RNType } from "./S3RN";
import { encodeClientToken } from "./client/types";
import { flags } from "./flagManager";

export interface Subscription {
	on: () => void;
	off: () => void;
}

function makeProvider(
	clientToken: ClientToken,
	ydoc: Y.Doc,
	user?: User,
): YSweetProvider {
	const params = {
		token: clientToken.token,
	};
	const provider = new YSweetProvider(
		clientToken.url,
		clientToken.docId,
		ydoc,
		{
			connect: false,
			params: params,
			disableBc: true,
			maxConnectionErrors: 3,
		},
	);

	if (user) {
		provider.awareness.setLocalStateField("user", {
			name: user.name,
			id: user.id,
			color: user.color.color,
			colorLight: user.color.light,
		});
	}
	return provider;
}

type Listener = (state: ConnectionState) => void;

export class HasProvider extends HasLogging {
	_provider: YSweetProvider;
	path?: string;
	ydoc: Y.Doc;
	clientToken: ClientToken;
	_providerSynced: boolean = false;
	private _offConnectionError: () => void;
	private _offState: () => void;
	listeners: Map<unknown, Listener>;

	constructor(
		public guid: string,
		private _s3rn: S3RNType,
		public tokenStore: LiveTokenStore,
		public loginManager: LoginManager,
	) {
		super();
		this.listeners = new Map<unknown, Listener>();
		this.loginManager = loginManager;
		const user = this.loginManager?.user;
		this.ydoc = new Y.Doc();

		if (flags().enableDocumentHistory) {
			this.ydoc.gc = false;
		}

		if (user) {
			const permanentUserData = new Y.PermanentUserData(this.ydoc);
			permanentUserData.setUserMapping(this.ydoc, this.ydoc.clientID, user.id);
		}

		this.tokenStore = tokenStore;
		this.clientToken =
			this.tokenStore.getTokenSync(S3RN.encode(this.s3rn)) ||
			({ token: "", url: "", docId: "-", expiryTime: 0 } as ClientToken);

		this._provider = makeProvider(this.clientToken, this.ydoc, user);

		const connectionErrorSub = this.providerConnectionErrorSubscription(
			(event) => {
				this.log(`[${this.path}] disconnection event`, event);
				const shouldConnect = this._provider.canReconnect();
				this.disconnect();
				if (shouldConnect) {
					this.connect();
				}
			},
		);
		connectionErrorSub.on();
		this._offConnectionError = connectionErrorSub.off;

		const stateSub = this.providerStateSubscription(
			(state: ConnectionState) => {
				this.notifyListeners();
			},
		);
		stateSub.on();
		this._offState = stateSub.off;
	}

	public get s3rn(): S3RNType {
		return this._s3rn;
	}

	public set s3rn(value: S3RNType) {
		this._s3rn = value;
		this.refreshProvider(this.clientToken);
	}

	public get debuggerUrl(): string {
		const payload = encodeClientToken(this.clientToken);
		return `https://debugger.y-sweet.dev/?payload=${payload}`;
	}

	notifyListeners() {
		this.debug("[Provider State]", this.path, this.state);
		this.listeners.forEach((listener) => {
			listener(this.state);
		});
	}

	subscribe(el: unknown, listener: Listener): () => void {
		this.listeners.set(el, listener);
		return () => {
			this.unsubscribe(el);
		};
	}

	unsubscribe(el: unknown) {
		this.listeners.delete(el);
	}

	async getProviderToken(): Promise<ClientToken> {
		this.log("get provider token");

		const tokenPromise = this.tokenStore.getToken(
			S3RN.encode(this.s3rn),
			this.path || "unknown",
			this.refreshProvider.bind(this),
		);
		return tokenPromise;
	}

	providerActive() {
		if (this.clientToken) {
			const tokenIsSet = this._provider.hasUrl(this.clientToken.url);
			const expired = Date.now() > (this.clientToken?.expiryTime || 0);
			return tokenIsSet && !expired;
		}
		return false;
	}

	refreshProvider(clientToken: ClientToken) {
		// updates the provider when a new token is received
		this.clientToken = clientToken;

		if (!this._provider) {
			throw new Error("missing provider!");
		}

		const result = this._provider.refreshToken(
			clientToken.url,
			clientToken.docId,
			clientToken.token,
		);

		if (result.urlChanged) {
			const maskedUrl = result.newUrl.replace(
				/token=[^&]+/,
				"token=[REDACTED]",
			);
			this.log(`Token Refreshed: setting new provider url, ${maskedUrl}`);
		}
	}

	public get connected(): boolean {
		return this.state.status === "connected";
	}

	connect(): Promise<boolean> {
		if (this.connected) {
			return Promise.resolve(true);
		}
		return this.getProviderToken()
			.then((clientToken) => {
				this.refreshProvider(clientToken); // XXX is this still needed?
				this._provider.connect();
				this.notifyListeners();
				return true;
			})
			.catch((e) => {
				return false;
			});
	}

	public get state(): ConnectionState {
		return this._provider.connectionState;
	}

	get intent(): ConnectionIntent {
		return this._provider.intent;
	}

	public get synced(): boolean {
		return this._providerSynced;
	}

	disconnect() {
		this._provider.disconnect();
		this.tokenStore.removeFromRefreshQueue(this.guid);
		this.notifyListeners();
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
		return new Promise((resolve) => {
			const resolveOnConnect = (state: ConnectionState) => {
				if (state.status === "connected") {
					resolve();
				}
			};
			// provider observers are manually cleared in destroy()
			this._provider.on("status", resolveOnConnect);
		});
	}

	onceProviderSynced(): Promise<void> {
		if (this.synced) {
			return new Promise((resolve) => {
				resolve();
			});
		}
		return new Promise((resolve) => {
			this._provider.once("synced", () => {
				this._providerSynced = true;
				resolve();
			});
		});
	}

	reset() {
		this.disconnect();
		this.clientToken = {
			token: "",
			url: "",
			docId: "-",
			expiryTime: 0,
		} as ClientToken;
	}


	private providerConnectionErrorSubscription(
		f: (event: Event) => void,
	): Subscription {
		const on = () => {
			this._provider.on("connection-error", f);
		};
		const off = () => {
			this._provider.off("connection-error", f);
		};
		return { on, off } as Subscription;
	}

	protected providerStateSubscription(
		f: (state: ConnectionState) => void,
	): Subscription {
		const on = () => {
			this._provider.on("status", f);
		};
		const off = () => {
			this._provider.off("status", f);
		};
		return { on, off } as Subscription;
	}

	destroy() {
		if (this._offConnectionError) {
			this._offConnectionError();
		}
		if (this._offState) {
			this._offState();
		}
		if (this._provider) {
			this._provider.destroy();
		}
		this.loginManager = null as any;
	}
}
