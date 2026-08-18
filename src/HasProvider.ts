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
import type { TimeProvider } from "./TimeProvider";
import { Awareness } from "y-protocols/awareness";
import { RetryableProviderSyncError } from "./background-sync/errors";
import { formatUserFacingError } from "./UserFacingError";

/**
 * What an ephemeral session needs from its caller: cancellation observed
 * at stage boundaries, and a deterministic clock for the sync deadline.
 */
export interface EphemeralSessionContext {
	timeProvider: TimeProvider;
	isCancelled(): boolean;
}

export function fileNameOf(path: string | undefined): string {
	const normalized = (path ?? "").replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	return parts[parts.length - 1] || "file";
}

declare const GIT_TAG: string;

export interface Subscription {
	on: () => void;
	off: () => void;
}

export interface HasProviderOptions {
	/**
	 * Start with no local awareness state. File models enable it only while an
	 * attached view holds their lock; provider sessions used for background
	 * synchronization therefore never announce a viewer.
	 */
	awarenessRequiresLock?: boolean;
}

function localAwarenessState(user: User | undefined): Record<string, unknown> {
	if (!user) {
		return {};
	}
	return {
		user: {
			name: user.name,
			id: user.id,
			color: user.color.color,
			colorLight: user.color.light,
		},
	};
}

function makeProvider(
	clientToken: ClientToken,
	ydoc: Y.Doc,
	user: User | undefined,
	timeProvider: TimeProvider,
	awarenessActive: boolean,
): YSweetProvider {
	const params = {
		token: clientToken.token,
		v: GIT_TAG,
	};
	// Configure the initial state before YSweetProvider subscribes to awareness
	// updates. A sync-only provider then starts absent without buffering a
	// synthetic leave message for its first connection.
	const awareness = new Awareness(ydoc);
	awareness.setLocalState(
		awarenessActive ? localAwarenessState(user) : null,
	);
	const provider = new YSweetProvider(
		clientToken.url,
		clientToken.docId,
		ydoc,
		{
			connect: false,
			awareness,
			params: params,
			disableBc: true,
			readOnly: clientToken.authorization === "read-only",
			timeProvider,
		},
	);

	return provider;
}

/** Disconnected state returned when no provider exists */
const DISCONNECTED_STATE: ConnectionState = {
	status: "disconnected",
} as ConnectionState;

type ConnectionCloseDetails = {
	code: number | null;
	reason: string;
	wasClean: boolean | null;
};

function connectionCloseDetails(event: CloseEvent): ConnectionCloseDetails {
	return {
		code: typeof event.code === "number" ? event.code : null,
		reason: typeof event.reason === "string" ? event.reason : "",
		wasClean: typeof event.wasClean === "boolean" ? event.wasClean : null,
	};
}

type Listener = (state: ConnectionState) => void;

export class HasProvider extends HasLogging {
	_provider: YSweetProvider | null = null;
	path?: string;
	private _ydoc: Y.Doc | null = null;
	clientToken: ClientToken;
	private _deferredDisconnectTimer: number | null = null;
	private _deferredDisconnectStatusListener:
		| ((state: ConnectionState) => void)
		| null = null;
	private _providerSyncAbortHandlers = new Set<(reason: Error) => void>();
	private _providerConnectedAbortHandlers = new Set<(reason: Error) => void>();
	// Track whether the current provider connection has completed sync.
	// Mirrors the provider's "synced" event through a persistent
	// subscription (attached in ensureRemoteDoc), so it stays correct
	// even when no onceProviderSynced() waiter is active at the moment
	// the handshake completes. Resets on disconnect so reconnect flows
	// do not treat a stale connection as ready.
	_providerSynced: boolean = false;
	private _offConnectionError: (() => void) | null = null;
	private _offConnectionClose: (() => void) | null = null;
	private _offState: (() => void) | null = null;
	private _offSynced: (() => void) | null = null;
	private _awarenessActive: boolean;
	listeners: Map<unknown, Listener>;
	timeProvider!: TimeProvider;

	constructor(
		public guid: string,
		private _s3rn: S3RNType,
		public tokenStore: LiveTokenStore,
		public loginManager: LoginManager,
		options: HasProviderOptions = {},
	) {
		super();
		this.listeners = new Map<unknown, Listener>();
		this.loginManager = loginManager;
		this._awarenessActive = !options.awarenessRequiresLock;

		this.tokenStore = tokenStore;
		this.clientToken =
			this.tokenStore.getTokenSync(S3RN.encode(this.s3rn)) ||
			({ token: "", url: "", docId: "-", expiryTime: 0 } as ClientToken);
	}

	/**
	 * Get the remote YDoc. Lazily creates it on first access.
	 * Most callers should use this property for backward compatibility.
	 */
	public get ydoc(): Y.Doc {
		if (!this._ydoc) {
			this.ensureRemoteDoc();
		}
		return this._ydoc!;
	}

	/**
	 * Get the remote YDoc without creating it.
	 * Returns null if the remoteDoc has not been created yet.
	 */
	public get remoteDocOrNull(): Y.Doc | null {
		return this._ydoc;
	}

	/**
	 * Check if the remote YDoc and provider are currently loaded.
	 */
	public get isRemoteDocLoaded(): boolean {
		return this._ydoc !== null;
	}

	/**
	 * Create the remote YDoc and provider if they don't exist.
	 * Returns the YDoc for convenience.
	 */
	ensureRemoteDoc(): Y.Doc {
		if (this._ydoc) {
			return this._ydoc;
		}

		const user = this.loginManager?.user;
		this._ydoc = new Y.Doc();

		this._provider = makeProvider(
			this.clientToken,
			this._ydoc,
			user,
			this.timeProvider,
			this._awarenessActive,
		);
		this._provider.beforeReconnect = async () => {
			const clientToken = await this.getProviderToken();
			this.refreshProvider(clientToken);
		};

		const connectionErrorSub = this.providerConnectionErrorSubscription(
			(event) => {
				this.log(`[${this.path}] connection error`, event);
			},
		);
		connectionErrorSub.on();
		this._offConnectionError = connectionErrorSub.off;

		const connectionCloseSub = this.providerConnectionCloseSubscription(
			(event) => {
				this.log(
					`[${this.path}] connection close`,
					connectionCloseDetails(event),
				);
			},
		);
		connectionCloseSub.on();
		this._offConnectionClose = connectionCloseSub.off;

		const stateSub = this.providerStateSubscription(
			(state: ConnectionState) => {
				if (state.status !== "connected") {
					if (this._providerSynced) {
						this._providerSynced = false;
						this.handleProviderDesynced();
					}
				}
				this.notifyListeners();
			},
		);
		stateSub.on();
		this._offState = stateSub.off;

		const syncedSub = this.providerSyncedSubscription((synced: boolean) => {
			if (this._providerSynced === synced) {
				return;
			}
			this._providerSynced = synced;
			if (synced) {
				this.handleProviderSynced();
			} else {
				this.handleProviderDesynced();
			}
			this.notifyListeners();
		});
		syncedSub.on();
		this._offSynced = syncedSub.off;

		return this._ydoc;
	}

	/**
	 * Assert or withdraw this provider's local presence. The enabled state is
	 * retained across provider recreation so a locked file rejoins if its
	 * remote document is rebuilt.
	 */
	protected setAwarenessActive(active: boolean): void {
		if (this._awarenessActive === active) {
			return;
		}
		this._awarenessActive = active;
		const awareness = this._provider?.awareness;
		if (!awareness) {
			return;
		}
		try {
			awareness.setLocalState(
				active ? localAwarenessState(this.loginManager?.user) : null,
			);
		} catch (error) {
			// Awareness subscribers run synchronously inside setLocalState. A
			// throwing subscriber must not abort the caller's lock transition:
			// presence is cosmetic, lock bookkeeping is not. The local state
			// map is already updated when subscribers run, but a throw here
			// can also suppress the provider's own broadcast of this
			// transition; the next connection handshake conveys the current
			// state.
			this.warn("awareness state change failed", error);
		}
	}

	/**
	 * Called on every false→true transition of the sync handshake.
	 * Subclasses latch durable state here — SharedFolder persists the
	 * server-sync marker so `ready` becomes a one-way gate.
	 */
	protected handleProviderSynced(): void {}

	/**
	 * Called on every true→false transition of the sync handshake
	 * (disconnect or provider-reported desync). Subclasses use this to
	 * track connect/disconnect cycles.
	 */
	protected handleProviderDesynced(): void {}

	/**
	 * Destroy the remote YDoc and provider, freeing memory.
	 * The document can be re-created later via ensureRemoteDoc().
	 */
	destroyRemoteDoc(): void {
		this.clearDeferredDisconnect();
		this.abortProviderSyncWaiters(
			new Error("Provider was destroyed before sync completed"),
		);
		this.abortProviderConnectedWaiters(
			new Error("Provider was destroyed before connection completed"),
		);
		if (this._offConnectionError) {
			this._offConnectionError();
			this._offConnectionError = null;
		}
		if (this._offConnectionClose) {
			this._offConnectionClose();
			this._offConnectionClose = null;
		}
		if (this._offState) {
			this._offState();
			this._offState = null;
		}
		if (this._offSynced) {
			this._offSynced();
			this._offSynced = null;
		}
		if (this._provider) {
			this._provider.destroy();
			this._provider = null;
		}
		if (this._ydoc) {
			this._ydoc.destroy();
			this._ydoc = null;
		}
		this._providerSynced = false;
	}

	public get s3rn(): S3RNType {
		return this._s3rn;
	}

	public set s3rn(value: S3RNType) {
		if (this._s3rn && value) {
			const previousKey = S3RN.encode(this._s3rn);
			const nextKey = S3RN.encode(value);
			if (previousKey !== nextKey) {
				this.tokenStore.release(previousKey);
			}
		}
		this._s3rn = value;
		if (this._provider) {
			this.refreshProvider(this.clientToken);
		}
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
		if (this.clientToken && this._provider) {
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
			// No provider yet - token will be used when ensureRemoteDoc() is called
			return;
		}

		const result = this._provider.refreshToken(
			clientToken.url,
			clientToken.docId,
			clientToken.token,
			clientToken.authorization === "read-only",
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
		// Ensure remoteDoc exists before connecting
		this.ensureRemoteDoc();
		return this.getProviderToken()
			.then((clientToken) => {
				this.refreshProvider(clientToken); // XXX is this still needed?
				this._provider!.connect();
				this.notifyListeners();
				return true;
			})
			.catch((e) => {
				this.abortProviderSyncWaiters(
					new Error("Provider connection failed before sync completed"),
				);
				this.abortProviderConnectedWaiters(
					new Error(
						"Provider connection failed before connection completed",
					),
				);
				return false;
			});
	}

	public get state(): ConnectionState {
		if (!this._provider) {
			return DISCONNECTED_STATE;
		}
		return this._provider.connectionState;
	}

	get intent(): ConnectionIntent {
		if (!this._provider) {
			return "disconnected" as ConnectionIntent;
		}
		return this._provider.intent;
	}

	public get synced(): boolean {
		return this._providerSynced;
	}

	/**
	 * True once the transport has been held long enough for the provider's
	 * reconnect backoff to reset — the socket has stayed open for
	 * RECONNECT_STABILITY_MS without a drop, so `wsUnsuccessfulReconnects` is
	 * back to zero. A connection still inside a reconnect flap reports connected
	 * but has a non-zero backoff counter until it settles. Recovery that must
	 * touch the transport (a fresh connect or a remoteDoc rebuild) waits for this
	 * level so it never competes with a still-flapping reconnect and drives an
	 * in-flight reconcile into a transport error.
	 */
	public get connectionStable(): boolean {
		const provider = this._provider;
		return (
			this.connected &&
			provider !== null &&
			provider.wsUnsuccessfulReconnects === 0
		);
	}

	private clearDeferredDisconnect(): void {
		if (this._deferredDisconnectTimer !== null) {
			this.timeProvider.clearTimeout(this._deferredDisconnectTimer);
			this._deferredDisconnectTimer = null;
		}
		if (this._provider && this._deferredDisconnectStatusListener) {
			this._provider.off("status", this._deferredDisconnectStatusListener);
		}
		this._deferredDisconnectStatusListener = null;
	}

	protected shouldCompleteDeferredDisconnect(): boolean {
		return true;
	}

	deferDisconnectForPendingMessages(timeoutMs: number = 2000): boolean {
		const provider = this._provider;
		if (!provider || provider._pendingMessages.length === 0) {
			return false;
		}

		this.clearDeferredDisconnect();

		const finishDisconnect = () => {
			if (this._provider !== provider) {
				this.clearDeferredDisconnect();
				return;
			}
			if (!this.shouldCompleteDeferredDisconnect()) {
				this.clearDeferredDisconnect();
				return;
			}
			this.disconnect();
		};

		const queueDisconnect = () => {
			// YSweetProvider emits "status: connected" before its onopen
			// handler flushes buffered sync frames. Defer one task so the
			// pending messages are actually sent before we close the socket.
			this._deferredDisconnectTimer = this.timeProvider.setTimeout(
				finishDisconnect,
				0,
			);
		};

		this._deferredDisconnectStatusListener = (state: ConnectionState) => {
			if (this._provider !== provider) {
				this.clearDeferredDisconnect();
				return;
			}
			if (state.status === "connected") {
				this.clearDeferredDisconnect();
				queueDisconnect();
			}
		};
		provider.on("status", this._deferredDisconnectStatusListener);

		this._deferredDisconnectTimer = this.timeProvider.setTimeout(() => {
			if (this._provider !== provider) {
				this.clearDeferredDisconnect();
				return;
			}
			if (!this.shouldCompleteDeferredDisconnect()) {
				this.clearDeferredDisconnect();
				return;
			}
			this.disconnect();
		}, timeoutMs);

		// Keep the in-flight connection attempt alive. If the socket was
		// dropped during a brief disconnect window, reconnect so the buffered
		// sync frames can flush on open.
		if (provider.connectionState.status !== "connected") {
			void this.connect();
		}

		return true;
	}

	releaseIdleSession(): void {
		if (!this.shouldCompleteDeferredDisconnect()) return;
		if (!this.deferDisconnectForPendingMessages()) {
			this.disconnect();
		}
	}

	/** Whether a user surface or live convergence owns this file's session. */
	protected isEphemeralSessionActive(): boolean {
		return false;
	}

	/**
	 * Whether a settled ephemeral session releases its connection. A file
	 * that was already connected when the session began keeps its
	 * connection; subclasses that never own a standing idle connection
	 * release unconditionally.
	 */
	protected sessionReleasesOnSettle(startedDisconnected: boolean): boolean {
		void startedDisconnected;
		return true;
	}

	/**
	 * Acquire whatever integration the session needs and return the
	 * release. The release is gated by shouldRelease at call time — a file
	 * that became active mid-session keeps its integration; the active
	 * session owns it from then on.
	 */
	protected beginEphemeralSessionLease(
		shouldRelease: () => boolean,
	): () => void {
		return () => {
			if (!shouldRelease()) return;
			this.releaseIdleSession();
		};
	}

	/**
	 * Run body under a brief provider session: connect, wait for provider
	 * sync (bounded — a dropped connection must not wedge the caller), run
	 * the body, and release the session unless the file became active
	 * meanwhile. Returns false when cancellation or teardown stopped the
	 * session before the body ran; throws RetryableProviderSyncError when
	 * the provider could not connect or sync in time.
	 */
	async withEphemeralSession<T>(
		ctx: EphemeralSessionContext,
		body: () => Promise<T>,
	): Promise<T | false> {
		const tornDown = () =>
			Boolean((this as unknown as { destroyed?: boolean }).destroyed);
		if (tornDown()) return false;
		if (ctx.isCancelled()) return false;

		const startedDisconnected = this.intent === "disconnected";
		const shouldRelease = () =>
			this.sessionReleasesOnSettle(startedDisconnected) &&
			!this.isEphemeralSessionActive();
		const maybeRelease = this.beginEphemeralSessionLease(shouldRelease);

		if (tornDown()) return false;
		const connected = await this.connect();
		if (!connected) {
			maybeRelease();
			if (ctx.isCancelled()) return false;
			throw new RetryableProviderSyncError(
				`Provider connection is not ready for ${fileNameOf(this.path)}`,
			);
		}
		if (ctx.isCancelled()) {
			maybeRelease();
			return false;
		}

		// Always wait for provider sync — the fast path resolves immediately
		// if already synced. Connected does not imply synced, and the bound
		// keeps a dropped connection from wedging the caller.
		const SYNC_TIMEOUT_MS = 10_000;
		let timerId: number | undefined;
		let cancelTimerId: number | undefined;
		let providerSyncFailure: unknown;
		const synced = await Promise.race([
			this.onceProviderSynced().then(
				() => true,
				(e) => {
					providerSyncFailure = e;
					return false;
				},
			),
			new Promise<false>((resolve) => {
				timerId = ctx.timeProvider.setTimeout(
					() => resolve(false),
					SYNC_TIMEOUT_MS,
				);
			}),
			new Promise<false>((resolve) => {
				cancelTimerId = ctx.timeProvider.setInterval(() => {
					if (ctx.isCancelled()) resolve(false);
				}, 100);
			}),
		]);
		if (timerId !== undefined) ctx.timeProvider.clearTimeout(timerId);
		if (cancelTimerId !== undefined)
			ctx.timeProvider.clearInterval(cancelTimerId);
		if (!synced) {
			maybeRelease();
			if (ctx.isCancelled()) return false;
			if (providerSyncFailure) {
				this.warn(
					`[session] provider sync failed: ${this.path} guid=${this.guid}`,
					providerSyncFailure,
				);
				throw new RetryableProviderSyncError(
					`Provider sync is not ready for ${fileNameOf(this.path)}: ${formatUserFacingError(providerSyncFailure)}`,
					providerSyncFailure,
				);
			}
			this.warn(
				`[session] provider sync timed out: ${this.path} guid=${this.guid}`,
			);
			throw new RetryableProviderSyncError(
				`Provider sync timed out for ${fileNameOf(this.path)}`,
			);
		}

		// The release must survive a throwing body: a stranded lease pins
		// the document's integration for the rest of the session. The gate
		// still applies — a file that became active keeps its session.
		try {
			return await body();
		} finally {
			maybeRelease();
		}
	}

	disconnect() {
		this.clearDeferredDisconnect();
		this.abortProviderSyncWaiters(
			new Error("Provider disconnected before sync completed"),
		);
		this._providerSynced = false;
		if (this._provider) {
			this._provider.disconnect();
		}
		// The refresh queue is keyed by the encoded resource name; a
		// reconnect re-registers through getProviderToken.
		this.tokenStore.release(S3RN.encode(this.s3rn));
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
		this.ensureRemoteDoc();
		if (this.state.status === "connected") {
			return Promise.resolve();
		}
		const provider = this._provider!;
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				provider.off("status", handleStatus);
				provider.off("connection-error", handleConnectionError);
				this._providerConnectedAbortHandlers.delete(abort);
			};
			const finish = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			const fail = (reason: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(reason);
			};
			const abort = (reason: Error) => {
				fail(reason);
			};
			const checkTerminalState = () => {
				if (this._provider !== provider) {
					fail(new Error("Provider was replaced before connection completed"));
					return;
				}
				const state = provider.connectionState;
				if (state.status === "connected") {
					finish();
					return;
				}
				if (
					state.status === "disconnected" &&
					state.intent === "connected" &&
					typeof provider.canReconnect === "function" &&
					!provider.canReconnect()
				) {
					fail(
						new Error(
							"Provider retries were exhausted before connection completed",
						),
					);
				}
			};
			const handleStatus = () => {
				checkTerminalState();
			};
			const handleConnectionError = () => {
				checkTerminalState();
			};
			provider.on("status", handleStatus);
			provider.on("connection-error", handleConnectionError);
			this._providerConnectedAbortHandlers.add(abort);
			checkTerminalState();
		});
	}

	onceProviderSynced(): Promise<void> {
		if (this._providerSynced) {
			return Promise.resolve();
		}
		this.ensureRemoteDoc();
		const provider = this._provider!;
		if (provider.synced) {
			this._providerSynced = true;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				provider.off("synced", handleSynced);
				provider.off("status", handleStatus);
				provider.off("connection-error", handleConnectionError);
				this._providerSyncAbortHandlers.delete(abort);
			};
			const finish = () => {
				if (settled) return;
				settled = true;
				cleanup();
				this._providerSynced = true;
				resolve();
			};
			const fail = (reason: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(reason);
			};
			const abort = (reason: Error) => {
				fail(reason);
			};
			const checkTerminalState = () => {
				if (this._provider !== provider) {
					fail(new Error("Provider was replaced before sync completed"));
					return;
				}
				if (this._providerSynced || provider.synced) {
					finish();
					return;
				}
				const state = provider.connectionState;
				if (
					state.status === "disconnected" &&
					state.intent === "connected" &&
					!provider.canReconnect()
				) {
					fail(new Error("Provider retries were exhausted before sync completed"));
					return;
				}
			};
			const handleSynced = (synced: boolean) => {
				if (!synced) return;
				finish();
			};
			const handleStatus = () => {
				checkTerminalState();
			};
			const handleConnectionError = () => {
				checkTerminalState();
			};
			provider.on("synced", handleSynced);
			provider.on("status", handleStatus);
			provider.on("connection-error", handleConnectionError);
			this._providerSyncAbortHandlers.add(abort);
			checkTerminalState();
		});
	}

	private abortProviderSyncWaiters(reason: Error): void {
		for (const abort of Array.from(this._providerSyncAbortHandlers)) {
			abort(reason);
		}
		this._providerSyncAbortHandlers.clear();
	}

	private abortProviderConnectedWaiters(reason: Error): void {
		for (const abort of Array.from(this._providerConnectedAbortHandlers)) {
			abort(reason);
		}
		this._providerConnectedAbortHandlers.clear();
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
			this._provider?.on("connection-error", f);
		};
		const off = () => {
			this._provider?.off("connection-error", f);
		};
		return { on, off } as Subscription;
	}

	private providerConnectionCloseSubscription(
		f: (event: CloseEvent) => void,
	): Subscription {
		const on = () => {
			this._provider?.on("connection-close", f);
		};
		const off = () => {
			this._provider?.off("connection-close", f);
		};
		return { on, off } as Subscription;
	}

	protected providerStateSubscription(
		f: (state: ConnectionState) => void,
	): Subscription {
		const on = () => {
			this._provider?.on("status", f);
		};
		const off = () => {
			this._provider?.off("status", f);
		};
		return { on, off } as Subscription;
	}

	private providerSyncedSubscription(
		f: (synced: boolean) => void,
	): Subscription {
		const on = () => {
			this._provider?.on("synced", f);
		};
		const off = () => {
			this._provider?.off("synced", f);
		};
		return { on, off } as Subscription;
	}

	destroy() {
		this.destroyRemoteDoc();
		this.loginManager = null as any;
	}
}
