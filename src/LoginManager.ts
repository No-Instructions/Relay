"use strict";

import { requestUrl, type RequestUrlResponsePromise } from "obsidian";
import { User } from "./User";
import PocketBase, {
	BaseAuthStore,
	type AuthProviderInfo,
	type RecordAuthResponse,
	type RecordModel,
} from "pocketbase";
import { RelayInstances, curryLog } from "./debug";
import { Observable } from "./observable/Observable";

declare const AUTH_URL: string;
declare const API_URL: string;
declare const GIT_TAG: string;

import { customFetch } from "./customFetch";
import { LocalAuthStore } from "./pocketbase/LocalAuthStore";
import type { TimeProvider } from "./TimeProvider";
import { FeatureFlagManager } from "./flagManager";

interface GoogleUser {
	email: string;
	family_name: string;
	given_name: string;
	name: string;
	picture: string;
}

export class LoginManager extends Observable<LoginManager> {
	pb: PocketBase;
	private openSettings: () => Promise<void>;
	// XXX keep this private
	authStore: LocalAuthStore;
	user?: User;
	resolve?: (code: string) => Promise<RecordAuthResponse<RecordModel>>;

	constructor(
		vaultName: string,
		openSettings: () => Promise<void>,
		timeProvider: TimeProvider,
		private beforeLogin: () => void,
	) {
		super();
		const pbLog = curryLog("[Pocketbase]", "debug");
		this.authStore = new LocalAuthStore(`pocketbase_auth_${vaultName}`);
		this.pb = new PocketBase(AUTH_URL, this.authStore);
		this.pb.beforeSend = (url, options) => {
			pbLog(url, options);
			options.fetch = customFetch;
			options.headers = Object.assign({}, options.headers, {
				"Relay-Version": GIT_TAG,
			});
			return { url, options };
		};
		this.refreshToken();
		timeProvider.setInterval(() => this.refreshToken(), 86400000);
		this.openSettings = openSettings;
		if (!this.pb.authStore.isValid) {
			this.logout();
		}
		if (this.pb.authStore.model?.id) {
			this.pb
				.collection("users")
				.getOne(this.pb.authStore.model.id)
				.then(() => {
					this.getFlags();
				})
				.catch((response) => {
					if (response.status === 404) {
						this.logout();
					}
				});
		}
		RelayInstances.set(this, "loginManager");
	}

	refreshToken() {
		if (this.pb.authStore.isValid) {
			this.user = this.makeUser(this.pb.authStore);
			this.pb
				.collection("users")
				.authRefresh()
				.then((authData) => {
					const token = authData.token;
					const [, payload] = token.split(".");
					const decodedPayload = JSON.parse(atob(payload));

					const expiryDate = new Date(decodedPayload.exp * 1000);
					const now = new Date();
					const daysUntilExpiry = Math.ceil(
						(expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
					);

					this.log("Token Refreshed");
					this.log("JWT Info:", {
						expiresAt: expiryDate.toLocaleString(),
						expiresIn: `${daysUntilExpiry} days`,
						userId: decodedPayload.id,
						email: decodedPayload.email,
					});
				});
		}
	}

	setup(authData?: RecordAuthResponse<RecordModel> | undefined): boolean {
		if (!this.pb.authStore.isValid) {
			this.notifyListeners(); // notify anyway
			return false;
		}
		this.user = this.makeUser(this.pb.authStore, authData?.meta?.rawUser);
		this.notifyListeners();
		if (authData) {
			this.pb
				.collection("oauth2_response")
				.create({
					user: authData.record.id,
					oauth_response: authData.meta?.rawUser,
				})
				.then(() => {
					this.notifyListeners();
				})
				.catch((reason) => {
					this.log(reason);
				});
		}
		return true;
	}

	async checkRelayHost(relay_guid: string): Promise<RequestUrlResponsePromise> {
		const headers = {
			Authorization: `Bearer ${this.pb.authStore.token}`,
			"Relay-Version": GIT_TAG,
		};
		return requestUrl({
			url: `${API_URL}/relay/${relay_guid}/check-host`,
			method: "GET",
			headers: headers,
		});
	}

	getFlags() {
		const headers = {
			Authorization: `Bearer ${this.pb.authStore.token}`,
			"Relay-Version": GIT_TAG,
		};
		requestUrl({
			url: `${API_URL}/flags`,
			method: "GET",
			headers: headers,
		})
			.then((response) => {
				if (response.status === 200) {
					const serverFlags = response.json;
					FeatureFlagManager.getInstance().applyServerFlags(serverFlags);
				}
			})
			.catch((reason) => {
				this.log(reason);
			});
	}

	whoami() {
		const headers = {
			Authorization: `Bearer ${this.pb.authStore.token}`,
		};
		requestUrl({
			url: `${API_URL}/whoami`,
			method: "GET",
			headers: headers,
		})
			.then((response) => {
				this.log(response.json);
			})
			.catch((reason) => {
				this.log(reason);
			});
	}

	public get loggedIn() {
		return this.user !== undefined;
	}

	get hasUser() {
		return this.user !== undefined;
	}

	private makeUser(authStore: BaseAuthStore, rawUser?: GoogleUser): User {
		return new User(
			authStore.model?.id,
			authStore.model?.name || rawUser?.name,
			authStore.model?.email,
			authStore.model?.picture || rawUser?.picture,
			authStore.token,
		);
	}

	logout() {
		this.pb.cancelAllRequests();
		this.pb.authStore.clear();
		this.user = undefined;
		this.notifyListeners();
	}

	webviewIntercept(): RegExp {
		const redirectUrl = this.pb.buildUrl("/api/oauth2-redirect");
		const authProvider =
			"https:\\/\\/accounts\\.google\\.com\\/o\\/oauth2\\/auth";
		return new RegExp(
			`^${authProvider}.*?[?&]redirect_uri=(${redirectUrl}|${encodeURIComponent(redirectUrl)})`,
			"i",
		);
	}

	async initiateManualOAuth2CodeFlow(
		whichFetch: typeof fetch | typeof customFetch,
	): Promise<
		[
			string,
			AuthProviderInfo,
			(code: string) => Promise<RecordAuthResponse<RecordModel>>,
		]
	> {
		this.beforeLogin();
		const authMethods = await this.pb
			.collection("users")
			.listAuthMethods({ fetch: whichFetch })
			.catch((e) => {
				throw e.originalError;
			});
		const provider = authMethods.authProviders[0];
		const redirectUrl = this.pb.buildUrl("/api/oauth2-redirect");
		return [
			provider.authUrl + redirectUrl,
			provider,
			async (code: string) => {
				return this.pb
					.collection("users")
					.authWithOAuth2Code(
						provider.name,
						code,
						provider.codeVerifier,
						redirectUrl,
						{
							fetch: whichFetch,
						},
					)
					.then((authData) => {
						this.setup(authData);
						return authData;
					});
			},
		];
	}

	async poll(
		provider: AuthProviderInfo,
		authWithCode: (code: string) => Promise<RecordAuthResponse<RecordModel>>,
	): Promise<RecordAuthResponse<RecordModel>> {
		let counter = 0;
		const interval = 1000;
		return new Promise((resolve, reject) => {
			const timer = setInterval(() => {
				counter += 1;
				if (counter >= 30) {
					clearInterval(timer);
					return reject(
						new Error(
							`Auth timeout: Timed out after ${
								(counter * interval) / 1000
							} seconds`,
						),
					);
				}
				this.pb
					.collection("code_exchange")
					.getOne(provider.state.slice(0, 15))
					.then((response) => {
						if (response) {
							clearInterval(timer);
							return resolve(authWithCode(response.code));
						}
					})
					.catch((e) => {});
			}, interval);
		});
	}

	async login(): Promise<boolean> {
		this.beforeLogin();
		const authData = await this.pb.collection("users").authWithOAuth2({
			provider: "google",
		});
		return this.setup(authData);
	}

	async openLoginPage() {
		await this.openSettings();
		const promise = new Promise<boolean>((resolve, reject) => {
			const isLoggedIn = () => {
				if (this.loggedIn) {
					this.off(isLoggedIn);
					resolve(true);
				}
				resolve(false);
			};
			this.on(isLoggedIn);
		});
		return await promise;
	}

	destroy() {
		this.pb.cancelAllRequests();
		this.pb.realtime.unsubscribe();
		this.pb = null as any;
		this.authStore.destroy();
		this.authStore = null as any;
		this.user = undefined;
		this.openSettings = null as any;
		super.destroy();
	}
}
