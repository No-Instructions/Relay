"use strict";

import { decodeJwt } from "jose";
import type { TimeProvider } from "./TimeProvider";
import { RelayInstances } from "./debug";
import { trackAsyncCleanup } from "./reloadUtils";

/**
 * Context passed to the refresh function when a refresh was requested to
 * reconcile a held token against fresher client-side authorization state.
 */
export interface RefreshContext<NetToken> {
	reconcile: boolean;
	heldToken?: NetToken;
}

interface TokenStoreConfig<StorageToken, NetToken> {
	log: (message: string) => void;
	refresh: (
		documentId: string,
		onSuccess: (token: NetToken) => void,
		onError: (err: Error) => void,
		context?: RefreshContext<NetToken>,
	) => void;
	getTimeProvider: () => TimeProvider;
	getJwtExpiry?: (token: NetToken) => number;
	getStorage?: () => Map<string, StorageToken>;
	refreshJitterSeed?: string;
	refreshJitterOffsetsMs?: readonly number[];
}

function formatTime(milliseconds: number): string {
	if (milliseconds < 1000) {
		return `${milliseconds}ms`;
	} else if (milliseconds < 60000) {
		return `${Math.round(milliseconds / 1000)}s`;
	} else if (milliseconds < 3600000) {
		return `${Math.round(milliseconds / 60000)}m`;
	} else {
		return `${Math.round(milliseconds / 3600000)}h`;
	}
}

export const TOKEN_REFRESH_JITTER_OFFSETS_MS = Object.freeze([
	0,
	5 * 1000,
	20 * 1000,
	45 * 1000,
	55 * 1000,
]);

function hashStringToUint32(text: string): number {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

const REFRESH_JITTER_DAY_MS = 24 * 60 * 60 * 1000;

export function getTokenRefreshJitterMs(
	seed: string | undefined,
	documentId: string,
	expiryTime: number,
	offsets: readonly number[] = TOKEN_REFRESH_JITTER_OFFSETS_MS,
): number {
	if (!seed || offsets.length === 0) {
		return 0;
	}
	const expiryDay = Math.floor(expiryTime / REFRESH_JITTER_DAY_MS);
	const index =
		hashStringToUint32(`${seed}:${documentId}:${expiryDay}`) %
		offsets.length;
	return offsets[index];
}

interface HasToken {
	token: string;
}

function _getJwtExpiry<TokenType>(token: TokenType & HasToken): number {
	// Attempt to decode the token without verification
	const decoded = decodeJwt(token.token);
	if (typeof decoded === "string") {
		return 0;
	}
	const exp = decoded?.exp;
	if (!exp) {
		return 0;
	}
	return exp * 1000; // Convert to milliseconds
}

export interface TokenInfo<Token> {
	friendlyName: string;
	token: Token | null;
	expiryTime: number;
	refreshTime?: number;
	attempts: number;
}

export class TokenStore<TokenType extends HasToken> {
	protected tokenMap: Map<string, TokenInfo<TokenType>>;
	protected callbacks: Map<string, (token: TokenType) => void>;
	protected _activePromises: Map<string, Promise<TokenType>>;

	private refreshQueue: Set<string>;
	private timeProvider: TimeProvider;
	private refreshInterval: number | null;
	private readonly refreshCheckIntervalMs: number = 60 * 1000;
	private readonly expiryMargin: number = 5 * 60 * 1000; // 5 minutes in milliseconds
	private readonly refreshJitterSeed?: string;
	private readonly refreshJitterOffsetsMs: readonly number[];
	private destroyed = false;
	private queueWaiters = new Set<() => void>();
	private activeConnections = 0;
	private maxConnections: number;
	protected getJwtExpiry: (token: TokenType) => number;
	private _log: (message: string) => void;
	private refresh: (
		documentId: string,
		onSuccess: (token: TokenType) => void,
		onError: (err: Error) => void,
		context?: RefreshContext<TokenType>,
	) => void;
	// Documents whose next refresh should carry the reconcile signal
	// (their held authorization disagrees with client-side role state).
	private reconcileRequests = new Set<string>();

	constructor(
		config: TokenStoreConfig<TokenInfo<TokenType>, TokenType>,
		maxConnections = 5,
	) {
		this._activePromises = new Map();
		if (config.getStorage) {
			this.tokenMap = config.getStorage();
		} else {
			this.tokenMap = new Map<string, TokenInfo<TokenType>>();
		}
		this.callbacks = new Map();

		this.refreshQueue = new Set();
		this._log = config.log;
		this.refresh = config.refresh;
		this.timeProvider = config.getTimeProvider();
		this.refreshJitterSeed = config.refreshJitterSeed;
		this.refreshJitterOffsetsMs =
			config.refreshJitterOffsetsMs ?? TOKEN_REFRESH_JITTER_OFFSETS_MS;
		if (config.getJwtExpiry) {
			this.getJwtExpiry = config.getJwtExpiry;
		} else {
			// XXX: Assumes TokenType is string
			this.getJwtExpiry = _getJwtExpiry<TokenType>;
		}
		this.maxConnections = maxConnections;
		this.refreshInterval = null;

		RelayInstances.set(this, "TokenStore");
	}

	protected isDestroyed(): boolean {
		return this.destroyed;
	}

	protected getDestroyedError(): Error {
		return new Error("attempted to use TokenStore after it was destroyed.");
	}

	onRefresh(documentId: string): Promise<TokenType> {
		if (this.destroyed) {
			return Promise.reject(this.getDestroyedError());
		}
		const promise = new Promise((resolve, reject) => {
			const onSuccess = (token: TokenType) => {
				if (this.destroyed) {
					reject(this.getDestroyedError());
					return;
				}
				resolve(token);
			};
			const onError = (error: Error) => {
				if (this.destroyed) {
					reject(this.getDestroyedError());
					return;
				}
				this.removeFromRefreshQueue(documentId);
				reject(error);
			};
			this.refresh(
				documentId,
				onSuccess,
				onError,
				this.consumeReconcileContext(documentId),
			);
		});
		return promise as Promise<TokenType>;
	}

	/**
	 * Take the pending reconcile signal for DOCUMENTID, attaching the held
	 * token so the refresh transport can report the authorization the
	 * client is trying to replace.
	 */
	private consumeReconcileContext(
		documentId: string,
	): RefreshContext<TokenType> | undefined {
		if (!this.reconcileRequests.delete(documentId)) {
			return undefined;
		}
		return {
			reconcile: true,
			heldToken: this.tokenMap.get(documentId)?.token ?? undefined,
		};
	}

	start() {
		if (this.destroyed) {
			throw this.getDestroyedError();
		}
		this.log("starting");
		this.report();
		this.refreshInterval = this.timeProvider.setInterval(
			() => this.checkAndRefreshTokens(),
			this.refreshCheckIntervalMs,
		); // Check every minute
		this.checkAndRefreshTokens();
	}

	stop() {
		if (this.destroyed) {
			return;
		}
		this.log("stopping");
		if (this.refreshInterval) {
			this.timeProvider.clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
	}

	private _cleanupInvalidTokens() {
		if (this.destroyed) {
			return;
		}
		const toDelete: string[] = [];
		for (const [documentId, tokenInfo] of this.tokenMap.entries()) {
			if (!this.isTokenValid(tokenInfo)) {
				toDelete.push(documentId);
			}
		}
		for (const documentId of toDelete) {
			this.tokenMap.delete(documentId);
		}
	}

	private checkAndRefreshTokens() {
		if (this.destroyed) {
			return;
		}
		this.log("check and refresh tokens");
		this._cleanupInvalidTokens();
		for (const [documentId, tokenInfo] of this.tokenMap.entries()) {
			if (
				this.callbacks.has(documentId) &&
				this.shouldRefresh(tokenInfo, documentId)
			) {
				this.log("adding to refresh queue");
				this.addToRefreshQueue(documentId);
			}
		}
		this.log(this.report());
	}

	dequeue(): string | null {
		if (this.destroyed) {
			return null;
		}
		this.log("getting next item in queue");
		if (this.refreshQueue.size > 0) {
			const nextDocumentId = this.refreshQueue.values().next().value;
			this.refreshQueue.delete(nextDocumentId);
			return nextDocumentId;
		}
		return null;
	}

	private addToRefreshQueue(documentId: string) {
		if (this.destroyed) {
			return;
		}
		if (this.activeConnections < this.maxConnections) {
			this.log(`immediate refresh of ${documentId}`);
			this.activeConnections++;
			const onSuccess = (newToken: TokenType) => {
				if (this.destroyed) {
					return;
				}
				this.onTokenRefreshed(documentId, newToken);
				this.activeConnections--;
				const next = this.dequeue();
				if (next) {
					this.addToRefreshQueue(next);
				}
			};
			const onError = () => {
				if (this.destroyed) {
					return;
				}
				this.onRefreshFailure(documentId);
				this.activeConnections--;
				const next = this.dequeue();
				if (next) {
					this.addToRefreshQueue(next);
				}
			};
			this.refresh(
				documentId,
				onSuccess,
				onError,
				this.consumeReconcileContext(documentId),
			);
		} else {
			this.log(`enqueued refresh of ${documentId}`);
			this.refreshQueue.add(documentId);
		}
	}

	removeFromRefreshQueue(documentId: string) {
		if (this.destroyed) {
			return false;
		}
		this.log(`removing ${documentId} from refresh queue`);
		if (this.refreshQueue.has(documentId)) {
			this.refreshQueue.delete(documentId);
			return true;
		}
		return false;
	}

	/**
	 * Refresh a document's token ahead of its expiry window and deliver the
	 * fresh token to the registered callback (unlike onRefresh, which only
	 * resolves the caller). Used when the held token's authorization
	 * disagrees with client-side role state; the refresh carries the
	 * reconcile signal so the server verifies against its source of truth.
	 * No-op for documents without a registered callback.
	 */
	forceRefresh(documentId: string): void {
		if (this.destroyed) {
			return;
		}
		if (!this.callbacks.has(documentId)) {
			return;
		}
		this.log(`force refresh of ${documentId}`);
		this.reconcileRequests.add(documentId);
		this.addToRefreshQueue(documentId);
	}

	log(text: string) {
		this._log(text);
	}

	private onTokenRefreshed(documentId: string, token: TokenType) {
		if (this.destroyed) {
			return;
		}
		const expiryTime = this.getJwtExpiry(token);
		if (this.tokenMap.has(documentId)) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const existing = this.tokenMap.get(documentId)!;
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const callback = this.callbacks.get(documentId)!;
			this.log(`new expiry time is ${expiryTime}`);
			this.tokenMap.set(documentId, {
				...existing,
				token,
				expiryTime,
				refreshTime: this.timeProvider.now(),
			} as TokenInfo<TokenType>);
			callback(token);
			this.log(`Token refreshed for ${existing.friendlyName} (${documentId})`);
		}
	}

	private onRefreshFailure(documentId: string) {
		if (this.destroyed) {
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const existing = this.tokenMap.get(documentId)!;
		const attempts = (existing?.attempts ?? 0) + 1;
		if (attempts <= 3) {
			this.tokenMap.set(documentId, {
				...existing,
				attempts: attempts,
			});
		} else {
			this.tokenMap.delete(documentId);
		}
	}

	private getRefreshJitterMs(
		token: TokenInfo<TokenType>,
		documentId?: string,
	): number {
		if (!documentId) {
			return 0;
		}
		return getTokenRefreshJitterMs(
			this.refreshJitterSeed,
			documentId,
			token.expiryTime,
			this.refreshJitterOffsetsMs,
		);
	}

	private getRefreshLeadTime(
		token: TokenInfo<TokenType>,
		documentId?: string,
	): number {
		const refreshJitterMs = this.getRefreshJitterMs(token, documentId);
		const configuredLeadTime =
			this.expiryMargin - Math.min(refreshJitterMs, this.expiryMargin);
		if (token.refreshTime === undefined) {
			return configuredLeadTime;
		}

		const tokenLifetime = token.expiryTime - token.refreshTime;
		if (tokenLifetime <= 0) {
			return configuredLeadTime;
		}

		return Math.min(
			configuredLeadTime,
			Math.max(this.refreshCheckIntervalMs, tokenLifetime / 2),
		);
	}

	isTokenValid(token: TokenInfo<TokenType>): boolean {
		if (this.destroyed) {
			return false;
		}
		const currentTime = this.timeProvider.now();
		return currentTime < token.expiryTime;
	}

	shouldRefresh(token: TokenInfo<TokenType>, documentId?: string): boolean {
		if (this.destroyed) {
			return false;
		}
		const currentTime = this.timeProvider.now();
		return (
			currentTime + this.getRefreshLeadTime(token, documentId) >
			token.expiryTime
		);
	}

	getTokenSync(documentId: string) {
		if (this.destroyed) {
			return undefined;
		}
		return this.tokenMap?.get(documentId)?.token;
	}

	private getTokenFromNetwork(
		documentId: string,
		friendlyName: string,
		callback: (token: TokenType) => void,
	) {
		if (this.destroyed) {
			return Promise.reject(this.getDestroyedError());
		}
		const activePromise = this._activePromises.get(documentId);
		if (activePromise) {
			return activePromise;
		}
		const existing = this.tokenMap.get(documentId);
		this.tokenMap.set(documentId, {
			token: null,
			friendlyName: friendlyName,
			expiryTime: 0,
			attempts: existing?.attempts ?? 0,
		} as TokenInfo<TokenType>);
		this.callbacks.set(documentId, callback);
		const sharedPromise = this.onRefresh(documentId)
			.then((newToken: TokenType) => {
				if (this.destroyed) {
					throw this.getDestroyedError();
				}
				this.onTokenRefreshed(documentId, newToken);
				return newToken;
			})
			.catch((err) => {
				if (this.destroyed) {
					throw this.getDestroyedError();
				}
				this.onRefreshFailure(documentId);
				throw err;
			})
			.finally(() => {
				this._activePromises?.delete(documentId);
			});
		this._activePromises.set(documentId, sharedPromise);
		return sharedPromise;
	}

	async getToken(
		documentId: string,
		friendlyName: string,
		callback: (token: TokenType) => void,
	): Promise<TokenType> {
		this.log(`getting token ${friendlyName}`);
		if (this.destroyed || !this.tokenMap) {
			return Promise.reject(this.getDestroyedError());
		}
		if (this.tokenMap.has(documentId)) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const tokenInfo = this.tokenMap.get(documentId)!;
			if (tokenInfo.token && this.isTokenValid(tokenInfo)) {
				this.callbacks.set(documentId, callback);
				tokenInfo.friendlyName = friendlyName;
				callback(tokenInfo.token);
				this.log("token was valid, cache hit!");
				this._activePromises.delete(documentId);
				return Promise.resolve(tokenInfo.token);
			}
		}
		return this.getTokenFromNetwork(documentId, friendlyName, callback);
	}

	_reportWithFilter(filter: (documentId: string) => boolean) {
		if (this.destroyed) {
			return [];
		}
		const reportLines: string[] = [];
		const currentTime = this.timeProvider.now();
		const tokens = Array.from(this.tokenMap.entries()).sort((a, b) => {
			return a[1].expiryTime - b[1].expiryTime;
		});
		for (const [documentId, tokenInfo] of tokens) {
			const { friendlyName, expiryTime, attempts } = tokenInfo;
			if (!filter(documentId)) {
				continue;
			}
			const timeUntilExpiry = expiryTime - currentTime;
			const refreshLeadTime = this.getRefreshLeadTime(tokenInfo, documentId);
			const timeUntilRefresh = timeUntilExpiry - refreshLeadTime;
			let timeReport = "";
			if (timeUntilRefresh > 0) {
				timeReport = `refreshes in ${formatTime(timeUntilRefresh)}`;
			} else if (timeUntilExpiry > 0) {
				timeReport = "refresh due";
			} else {
				timeReport = "expired";
			}
			reportLines.push(
				`${documentId} (${friendlyName}): ${attempts} attempts, (${timeReport})`,
			);
		}
		return reportLines;
	}

	report(): string {
		if (this.destroyed) {
			return "Token Store Report:\nDestroyed";
		}
		const reportLines: string[] = [];
		reportLines.push("Token Store Report:");
		reportLines.push(`Expiry Margin: ${formatTime(this.expiryMargin)}`);
		if (this.refreshJitterSeed && this.refreshJitterOffsetsMs.length > 0) {
			reportLines.push(
				`Refresh Jitter: per document/day, up to ${formatTime(
					Math.max(...this.refreshJitterOffsetsMs),
				)}`,
			);
		}
		reportLines.push("Active Tokens:");
		reportLines.push(
			...this._reportWithFilter((documentId) => {
				return this.callbacks.has(documentId);
			}),
		);
		reportLines.push("Stale Tokens:");
		reportLines.push(
			...this._reportWithFilter((documentId) => {
				return !this.callbacks.has(documentId);
			}),
		);
		reportLines.push(`Queue size: ${this.refreshQueue.size}`);
		return reportLines.join("\n");
	}

	async waitForQueue(): Promise<void> {
		if (this.destroyed) {
			return;
		}
		return new Promise((resolve) => {
			const timeProvider = this.timeProvider;
			let interval: number | null = null;
			const complete = () => {
				if (interval !== null) {
					timeProvider.clearInterval(interval);
				}
				this.queueWaiters.delete(complete);
				resolve();
			};

			this.queueWaiters.add(complete);
			interval = timeProvider.setInterval(() => {
				if (this.destroyed || this.refreshQueue.size == 0) {
					complete();
				}
			}, 100);
		});
	}

	clearState() {
		if (this.destroyed) {
			return;
		}
		this.refreshQueue.clear();
		for (const [documentId, tokenInfo] of this.tokenMap.entries()) {
			if (this.isTokenValid(tokenInfo)) {
				this.tokenMap.set(documentId, { ...tokenInfo, attempts: 0 });
			} else {
				this.tokenMap.delete(documentId);
			}
		}
	}

	clear(filter?: (token: TokenInfo<TokenType>) => boolean) {
		if (this.destroyed) {
			return;
		}
		if (filter) {
			this.tokenMap.forEach((value, key) => {
				if (filter(value)) {
					this.tokenMap.delete(key);
					this.refreshQueue.delete(key);
				}
			});
		} else {
			this.tokenMap.clear();
			this.refreshQueue.clear();
		}
	}

	destroy() {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		for (const resolve of this.queueWaiters) {
			resolve();
		}
		this.queueWaiters.clear();
		// Track active token refresh promises before clearing
		if (this._activePromises.size > 0) {
			const activePromises = Array.from(this._activePromises.values());
			trackAsyncCleanup(
				Promise.allSettled(activePromises).then(() => {}),
				"tokenStore:activeRefreshes",
			);
		}

		this.tokenMap.clear();
		this.refreshQueue.clear();
		this.timeProvider.destroy();
		this.timeProvider = null as any;
		this.refresh = null as any;
		this.callbacks.clear();
		this.callbacks = null as any;
		this._activePromises.clear();
		this._activePromises = null as any;
		this.tokenMap = null as any;
	}
}
