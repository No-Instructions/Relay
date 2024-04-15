import jwt from "jsonwebtoken";
import { LocalStorage } from "./LocalStorage";

interface TokenStoreConfig {
	log: (message: string) => void;
	refresh: (
		documentId: string,
		onSuccess: (token: any) => void,
		onError: (err: Error) => void
	) => void;
	getTimeProvider?: () => TimeProvider;
	getJwtExpiry?: (token: any) => number;
}

export interface TimeProvider {
	getTime: () => number;
	setInterval: (callback: () => void, ms: number) => NodeJS.Timer;
	clearInterval: (timerId: NodeJS.Timer) => void;
}

function _getJwtExpiry(token: string): number {
	// Attempt to decode the token without verification
	const decoded = jwt.decode(token);
	if (typeof decoded === "string") {
		return 0;
	}
	const exp = decoded?.exp;
	if (!exp) {
		return 0;
	}
	return exp * 1000; // Convert to milliseconds
}

interface TokenInfo<Token> {
	friendlyName: string;
	token: Token | null;
	expiryTime: number;
	attempts: number;
	callback: (token: Token) => void;
	_timeProvider?: TimeProvider;
}

export class TokenStore<TokenType> {
	private tokenMap: Map<string, TokenInfo<TokenType>>;
	private refreshQueue: Set<string>;
	private timeProvider: TimeProvider;
	private refreshInterval: NodeJS.Timer | null;
	private readonly expiryMargin: number = 5 * 60 * 1000; // 5 minutes in milliseconds
	private activeConnections = 0;
	private maxConnections: number;
	private getJwtExpiry: (token: any) => number;
	private _log: (message: string) => void;
	private _activePromises: Map<string, Promise<TokenType>>;
	private refresh: (
		documentId: string,
		onSuccess: (token: TokenType) => void,
		onError: (err: Error) => void
	) => void;

	constructor(config: TokenStoreConfig, maxConnections = 5) {
		this._activePromises = new Map();
		this.tokenMap = new LocalStorage<TokenInfo<TokenType>>("TokenStore");

		this.refreshQueue = new Set();
		this._log = config.log;
		this.refresh = config.refresh;
		if (config.getTimeProvider) {
			this.timeProvider = config.getTimeProvider();
		} else {
			this.timeProvider = new DefaultTimeProvider();
		}
		if (config.getJwtExpiry) {
			this.getJwtExpiry = config.getJwtExpiry;
		} else {
			// XXX: Assumes TokenType is string
			this.getJwtExpiry = _getJwtExpiry;
		}
		this.maxConnections = maxConnections;
		this.refreshInterval = null;
	}

	onRefresh(documentId: string): Promise<TokenType> {
		const promise = new Promise((resolve, reject) => {
			const onSuccess = (token: TokenType) => {
				resolve(token);
			};
			const onError = (error: Error) => {
				reject(error);
			};
			this.refresh(documentId, onSuccess, onError);
		});
		return promise as Promise<TokenType>;
	}

	start() {
		this.log("starting");
		this.refreshInterval = this.timeProvider.setInterval(
			() => this.checkAndRefreshTokens(),
			20 * 1000
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

	private checkAndRefreshTokens() {
		this.log("check and refresh tokens");
		for (const [documentId, tokenInfo] of this.tokenMap.entries()) {
			const diff =
				(tokenInfo.expiryTime - this.timeProvider.getTime()) / 1000;
			this.log(
				`documentId: ${documentId}, expiryTime: ${tokenInfo.expiryTime} (in ${diff}s)`
			);
			if (this.shouldRefresh(tokenInfo)) {
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

	log(text: string) {
		this._log(text);
	}

	private onTokenRefreshed(documentId: string, token: TokenType) {
		const expiryTime = this.getJwtExpiry(token);
		if (this.tokenMap.has(documentId)) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const existing = this.tokenMap.get(documentId)!;
			this.log(`new expiry time is ${expiryTime}`);
			this.tokenMap.set(documentId, {
				...existing,
				token,
				expiryTime,
				attempts: existing.attempts,
			} as TokenInfo<TokenType>);
			existing.callback(token);
			this.log(
				`Token refreshed for ${existing.friendlyName} (${documentId})`
			);
		}
	}

	private onRefreshFailure(documentId: string) {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const existing = this.tokenMap.get(documentId)!;
		this.tokenMap.set(documentId, {
			...existing,
			attempts: (existing?.attempts || 0) + 1,
		});
	}

	isTokenValid(token: TokenInfo<TokenType>): boolean {
		const currentTime = this.timeProvider.getTime();
		return currentTime < token.expiryTime;
	}

	shouldRefresh(token: TokenInfo<TokenType>): boolean {
		const currentTime = this.timeProvider.getTime();
		return token.expiryTime - currentTime <= this.expiryMargin;
	}

	getTokenSync(documentId: string) {
		return this.tokenMap.get(documentId)?.token;
	}

	async getToken(
		documentId: string,
		friendlyName: string,
		callback: (token: TokenType, err: Error | null) => void
	): Promise<TokenType> {
		this.log(`getting token ${friendlyName}`);
		if (this.tokenMap.has(documentId)) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const tokenInfo = this.tokenMap.get(documentId)!;
			if (tokenInfo.token && this.isTokenValid(tokenInfo)) {
				// && this.isTokenValid(tokenInfo)) {
				console.log("token was valid, cache hit!");
				return Promise.resolve(tokenInfo.token);
			} else {
				console.log(
					"token was invalid???",
					tokenInfo,
					this.timeProvider.getTime()
				);
			}
		}
		const activePromise = this._activePromises.get(documentId);
		if (activePromise) {
			return activePromise;
		}
		this.tokenMap.set(documentId, {
			token: null,
			friendlyName: friendlyName,
			expiryTime: 0,
			attempts: 0,
			callback: callback,
		} as TokenInfo<TokenType>);
		if (!documentId) {
			throw new Error("missing document ID!");
		}
		const sharedPromise = this.onRefresh(documentId)
			.then((newToken: TokenType) => {
				this.onTokenRefreshed(documentId, newToken);
				this._activePromises.delete(documentId);
				return newToken;
			})
			.catch((err) => {
				this.onRefreshFailure(documentId);
				this._activePromises.delete(documentId);
				return err;
			});
		this._activePromises.set(documentId, sharedPromise);
		return sharedPromise;
	}

	report(): string {
		const reportLines: string[] = [];
		const currentTime = this.timeProvider.getTime();
		for (const [
			documentId,
			{ friendlyName, expiryTime, attempts },
		] of this.tokenMap.entries()) {
			const timeUntilExpiry = (expiryTime - currentTime) / 1000; // Convert to seconds
			reportLines.push(
				`${documentId} (${friendlyName}): ${attempts} attempts, expires in ${timeUntilExpiry.toFixed(
					2
				)} seconds`
			);
		}
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
}

export class DefaultTimeProvider implements TimeProvider {
	getTime(): number {
		return Date.now();
	}

	setInterval(callback: () => void, ms: number): NodeJS.Timer {
		return setInterval(callback, ms);
	}

	clearInterval(timerId: NodeJS.Timer): void {
		clearInterval(timerId);
	}
}
