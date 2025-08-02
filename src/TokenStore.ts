"use strict";

import { decodeJwt } from "jose";
import type { TimeProvider } from "./TimeProvider";
import { RelayInstances } from "./debug";

interface TokenStoreConfig<StorageToken, NetToken> {
	log: (message: string) => void;
	refresh: (
		documentId: string,
		onSuccess: (token: NetToken) => void,
		onError: (err: Error) => void,
	) => void;
	getTimeProvider: () => TimeProvider;
	getJwtExpiry?: (token: NetToken) => number;
	getStorage?: () => Map<string, StorageToken>;
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
	attempts: number;
}

export class TokenStore<TokenType extends HasToken> {
	protected tokenMap: Map<string, TokenInfo<TokenType>>;
	protected callbacks: Map<string, (token: TokenType) => void>;
	protected _activePromises: Map<string, Promise<TokenType>>;

	private refreshQueue: Set<string>;
	private timeProvider: TimeProvider;
	private refreshInterval: number | null;
	private readonly expiryMargin: number = 5 * 60 * 1000; // 5 minutes in milliseconds
	private activeConnections = 0;
	private maxConnections: number;
	protected getJwtExpiry: (token: TokenType) => number;
	private _log: (message: string) => void;
	private refresh: (
		documentId: string,
		onSuccess: (token: TokenType) => void,
		onError: (err: Error) => void,
	) => void;

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

	onRefresh(documentId: string): Promise<TokenType> {
		const promise = new Promise((resolve, reject) => {
			const onSuccess = (token: TokenType) => {
				resolve(token);
			};
			const onError = (error: Error) => {
				this.removeFromRefreshQueue(documentId);
				reject(error);
			};
			this.refresh(documentId, onSuccess, onError);
		});
		return promise as Promise<TokenType>;
	}

	start() {
		this.log("starting");
		this.report();
		this.refreshInterval = this.timeProvider.setInterval(
			() => this.checkAndRefreshTokens(),
			60 * 1000,
		); // Check every minute
		this.checkAndRefreshTokens();
	}

	stop() {
		this.log("stopping");
		if (this.refreshInterval) {
			this.timeProvider.clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
	}

	private _cleanupInvalidTokens() {
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
		this.log("check and refresh tokens");
		this._cleanupInvalidTokens();
		for (const [documentId, tokenInfo] of this.tokenMap.entries()) {
			if (this.callbacks.has(documentId) && this.shouldRefresh(tokenInfo)) {
				this.log("adding to refresh queue");
				this.addToRefreshQueue(documentId);
			}
		}
		this.log(this.report());
	}

	dequeue(): string | null {
		this.log("getting next item in queue");
		if (this.refreshQueue.size > 0) {
			const nextDocumentId = this.refreshQueue.values().next().value;
			this.refreshQueue.delete(nextDocumentId);
			return nextDocumentId;
		}
		return null;
	}

	private addToRefreshQueue(documentId: string) {
		if (this.activeConnections < this.maxConnections) {
			this.log(`immediate refresh of ${documentId}`);
			this.activeConnections++;
			const onSuccess = (newToken: TokenType) => {
				this.onTokenRefreshed(documentId, newToken);
				this.activeConnections--;
				const next = this.dequeue();
				if (next) {
					this.addToRefreshQueue(next);
				}
			};
			const onError = () => {
				this.onRefreshFailure(documentId);
				this.activeConnections--;
				const next = this.dequeue();
				if (next) {
					this.addToRefreshQueue(next);
				}
			};
			this.refresh(documentId, onSuccess, onError);
		} else {
			this.log(`enqueued refresh of ${documentId}`);
			this.refreshQueue.add(documentId);
		}
	}

	removeFromRefreshQueue(documentId: string) {
		this.log(`removing ${documentId} from refresh queue`);
		if (this.refreshQueue.has(documentId)) {
			this.refreshQueue.delete(documentId);
			return true;
		}
		return false;
	}

	log(text: string) {
		this._log(text);
	}

	private onTokenRefreshed(documentId: string, token: TokenType) {
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
			} as TokenInfo<TokenType>);
			callback(token);
			this.log(`Token refreshed for ${existing.friendlyName} (${documentId})`);
		}
	}

	private onRefreshFailure(documentId: string) {
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

	isTokenValid(token: TokenInfo<TokenType>): boolean {
		const currentTime = this.timeProvider.getTime();
		return currentTime < token.expiryTime;
	}

	shouldRefresh(token: TokenInfo<TokenType>): boolean {
		const currentTime = this.timeProvider.getTime();
		return currentTime + this.expiryMargin > token.expiryTime;
	}

	getTokenSync(documentId: string) {
		return this.tokenMap?.get(documentId)?.token;
	}

	private getTokenFromNetwork(
		documentId: string,
		friendlyName: string,
		callback: (token: TokenType) => void,
	) {
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
				this.onTokenRefreshed(documentId, newToken);
				this._activePromises.delete(documentId);
				return newToken;
			})
			.catch((err) => {
				this.onRefreshFailure(documentId);
				this._activePromises.delete(documentId);
				throw err;
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
		if (!this.tokenMap) {
			Promise.reject(
				new Error(
					"attempted to get token after TokenStore was destroyed.",
				),
			);
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
		const reportLines: string[] = [];
		const currentTime = this.timeProvider.getTime();
		const tokens = Array.from(this.tokenMap.entries()).sort((a, b) => {
			return a[1].expiryTime - b[1].expiryTime;
		});
		for (const [documentId, { friendlyName, expiryTime, attempts }] of tokens) {
			if (!filter(documentId)) {
				continue;
			}
			const timeUntilExpiry = expiryTime - currentTime;
			let timeReport = "";
			if (timeUntilExpiry > 0) {
				timeReport = `expires in ${formatTime(
					timeUntilExpiry - this.expiryMargin,
				)}`;
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
		const reportLines: string[] = [];
		reportLines.push("Token Store Report:");
		reportLines.push(`Expiry Margin: ${formatTime(this.expiryMargin)}`);
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
		return new Promise((resolve) => {
			setInterval(() => {
				if (this.refreshQueue.size == 0) {
					return resolve();
				}
			}, 100);
		});
	}

	clearState() {
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
		this.clear();
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
