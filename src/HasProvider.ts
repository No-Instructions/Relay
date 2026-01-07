"use strict";
import * as Y from "yjs";
import { requestUrl } from "obsidian";
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
import { S3RN, S3RemoteCanvas, S3RemoteDocument, type S3RNType } from "./S3RN";
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
	private _downloading: boolean = false;

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

	public get downloading(): boolean {
		return this._downloading;
	}

	public get state(): ConnectionState {
		if (this._downloading) {
			return { status: "downloading", intent: this.intent };
		}
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

	/**
	 * Fetch document state from server via HTTP (not WebSocket)
	 * Updates state and notifies listeners before and after download
	 */
	async fetch(): Promise<void> {
		this._downloading = true;
		this.notifyListeners();

		try {
			const response = await this.downloadFromServer();
			this.applyUpdate(response);
		} finally {
			this._downloading = false;
			this.notifyListeners();
		}
	}

	protected async downloadFromServer(): Promise<Uint8Array> {
		const clientToken = await this.getProviderToken();
		const headers = this.getAuthHeader(clientToken);
		const baseUrl = this.getBaseUrl(clientToken);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrl({
			url: url,
			method: "GET",
			headers: headers,
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(`Download failed: ${response.status}`);
		}

		return new Uint8Array(response.arrayBuffer);
	}

	protected applyUpdate(update: Uint8Array): void {
		Y.applyUpdate(this.ydoc, update);
	}

	protected getAuthHeader(clientToken: ClientToken): Record<string, string> {
		return { Authorization: `Bearer ${clientToken.token}` };
	}

	protected getBaseUrl(clientToken: ClientToken): string {
		const entity = this.s3rn;
		if (
			!(entity instanceof S3RemoteDocument || entity instanceof S3RemoteCanvas)
		) {
			throw new Error(`Unable to get base URL for S3RN: ${S3RN.encode(entity)}`);
		}

		const urlObj = new URL(clientToken.url);
		urlObj.protocol = "https:";
		const parts = urlObj.pathname.split("/");
		parts.pop();
		parts.push(clientToken.docId);
		urlObj.pathname = parts.join("/");
		const baseUrl =
			clientToken.baseUrl?.replace(/\/$/, "") || urlObj.toString();

		return baseUrl;
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
