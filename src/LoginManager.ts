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

declare const GIT_TAG: string;

import { customFetch } from "./customFetch";
import { LocalAuthStore } from "./pocketbase/LocalAuthStore";
import type { TimeProvider } from "./TimeProvider";
import { FeatureFlagManager } from "./flagManager";
import type { NamespacedSettings } from "./SettingsStorage";
import { type EndpointManager, type EndpointSettings } from "./EndpointManager";

interface GoogleUser {
	email: string;
	family_name: string;
	given_name: string;
	name: string;
	picture: string;
}

interface GitHubUser {
	email: string;
	name: string;
	login: string;
	avatar_url: string;
}

interface MicrosoftUser {
	mail: string;
	surname: string;
	givenName: string;
	displayName: string;
}

interface OIDCUser {
	email: string;
	given_name: string;
	family_name: string;
	name?: string;
	picture?: string;
}

/**
 * Normalized OAuth user data structure that standardizes information across providers
 */
interface NormalizedOAuthUser {
	name: string;
	given_name: string;
	family_name: string;
	email: string;
	picture?: string;
}

/**
 * Normalizes OAuth2 user data from different providers into a consistent format
 */
function normalizeOAuthUser(rawUser: any): NormalizedOAuthUser | null {
	// Handle Google user
	if ("email" in rawUser && "name" in rawUser && "given_name" in rawUser && "family_name" in rawUser) {
		const googleUser = rawUser as GoogleUser;
		return {
			name: googleUser.name,
			given_name: googleUser.given_name,
			family_name: googleUser.family_name,
			email: googleUser.email,
			picture: googleUser.picture,
		};
	}

	// Handle GitHub user
	if ("email" in rawUser && "login" in rawUser && "avatar_url" in rawUser) {
		const githubUser = rawUser as GitHubUser;
		const nameParts = (githubUser.name || githubUser.login).split(' ');
		return {
			name: githubUser.name || githubUser.login,
			given_name: nameParts[0] || githubUser.login,
			family_name: nameParts.slice(1).join(' ') || '',
			email: githubUser.email,
			picture: githubUser.avatar_url,
		};
	}

	// Handle Microsoft user
	if ("mail" in rawUser && "displayName" in rawUser) {
		const microsoftUser = rawUser as MicrosoftUser;
		return {
			name: microsoftUser.displayName,
			given_name: microsoftUser.givenName,
			family_name: microsoftUser.surname,
			email: microsoftUser.mail,
			// Microsoft doesn't typically provide picture in basic profile
		};
	}

	// Handle OIDC user (standard OpenID Connect claims)
	if ("email" in rawUser && "given_name" in rawUser && "family_name" in rawUser) {
		const oidcUser = rawUser as OIDCUser;
		return {
			name: oidcUser.name || `${oidcUser.given_name} ${oidcUser.family_name}`,
			given_name: oidcUser.given_name,
			family_name: oidcUser.family_name,
			email: oidcUser.email,
			picture: oidcUser.picture,
		};
	}

	return null;
}

/**
 * Creates a User object from OAuth2 payload data, supporting multiple providers
 * @param id - User ID from the auth store
 * @param token - Authentication token
 * @param authStoreModel - Model data from the auth store
 * @param rawUser - Raw OAuth user data from the provider (Google, GitHub, Microsoft, OIDC, etc.)
 * @returns A new User instance with normalized data from the OAuth provider
 */
export function createUserFromOAuth(
	id: string,
	token: string,
	authStoreModel: any,
	rawUser?: GoogleUser | GitHubUser | MicrosoftUser | OIDCUser | any,
): User {
	const normalizedOAuth = rawUser ? normalizeOAuthUser(rawUser) : null;

	return new User(
		id,
		authStoreModel?.name || normalizedOAuth?.name || "",
		authStoreModel?.email || normalizedOAuth?.email || "",
		authStoreModel?.picture || normalizedOAuth?.picture || "",
		token,
	);
}

export class Provider {
	fullAuthUrl: string;
	info: AuthProviderInfo;
	login: (code: string) => Promise<RecordAuthResponse<RecordModel>>;

	constructor(
		authUrl: string,
		info: AuthProviderInfo,
		loginFn: (code: string) => Promise<RecordAuthResponse<RecordModel>>,
	) {
		this.fullAuthUrl = authUrl;
		this.info = info;
		this.login = loginFn;
	}
}

export interface LoginSettings {
	provider: string | undefined;
}

export class LoginManager extends Observable<LoginManager> {
	pb: PocketBase;
	private openSettings: () => Promise<void>;
	// XXX keep this private
	authStore: LocalAuthStore;
	user?: User;
	resolve?: (code: string) => Promise<RecordAuthResponse<RecordModel>>;
	private endpointManager: EndpointManager;

	constructor(
		vaultName: string,
		openSettings: () => Promise<void>,
		timeProvider: TimeProvider,
		private beforeLogin: () => void,
		public loginSettings: NamespacedSettings<LoginSettings>,
		endpointManager: EndpointManager,
	) {
		super();
		const pbLog = curryLog("[Pocketbase]", "debug");
		this.authStore = new LocalAuthStore(`pocketbase_auth_${vaultName}`);
		this.endpointManager = endpointManager;
		this.pb = new PocketBase(this.endpointManager.getAuthUrl(), this.authStore);
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

	setup(
		authData?: RecordAuthResponse<RecordModel> | undefined,
		provider?: string,
	): boolean {
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
		if (provider) {
			this.loginSettings.set({ provider });
		}
		return true;
	}

	clearPreferredProvider() {
		this.loginSettings.set({ provider: undefined });
	}

	async checkRelayHost(relay_guid: string): Promise<RequestUrlResponsePromise> {
		const headers = {
			Authorization: `Bearer ${this.pb.authStore.token}`,
			"Relay-Version": GIT_TAG,
		};
		return requestUrl({
			url: `${this.endpointManager.getApiUrl()}/relay/${relay_guid}/check-host`,
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
			url: `${this.endpointManager.getApiUrl()}/flags`,
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
			url: `${this.endpointManager.getApiUrl()}/whoami`,
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

	/**
	 * Get the endpoint manager for endpoint configuration
	 */
	getEndpointManager(): EndpointManager {
		return this.endpointManager;
	}

	/**
	 * Validate and apply custom endpoints
	 */
	async validateAndApplyEndpoints(timeoutMs?: number): Promise<{
		success: boolean;
		error?: string;
		licenseInfo?: any;
	}> {
		const result = await this.endpointManager.validateAndSetEndpoints(timeoutMs);
		
		if (result.success && this.endpointManager.hasValidatedEndpoints()) {
			// Recreate PocketBase instance with new auth URL
			const pbLog = curryLog("[Pocketbase]", "debug");
			this.pb = new PocketBase(this.endpointManager.getAuthUrl(), this.authStore);
			this.pb.beforeSend = (url, options) => {
				pbLog(url, options);
				options.fetch = customFetch;
				options.headers = Object.assign({}, options.headers, {
					"Relay-Version": GIT_TAG,
				});
				return { url, options };
			};
			this.log("Updated PocketBase instance with validated endpoints");
		}
		
		return result;
	}

	get hasUser() {
		return this.user !== undefined;
	}

	private makeUser(
		authStore: BaseAuthStore,
		rawUser?: GoogleUser | GitHubUser | MicrosoftUser | OIDCUser,
	): User {
		return createUserFromOAuth(
			authStore.model?.id,
			authStore.token,
			authStore.model,
			rawUser,
		);
	}

	logout() {
		this.pb.cancelAllRequests();
		this.pb.authStore.clear();
		this.user = undefined;
		this.notifyListeners();
	}

	getWebviewIntercepts(providers?: Record<string, Provider>): RegExp[] {
		const redirectUrl = this.pb.buildUrl("/api/oauth2-redirect");
		const createIntercept = (authProviderUrl: string): RegExp => {
			// Escape forward slashes in the auth URL
			const escapedAuthProvider = authProviderUrl.replace(/\//g, "\\/");
			return new RegExp(
				`^${escapedAuthProvider}.*?[?&]redirect_uri=(${redirectUrl}|${encodeURIComponent(redirectUrl)})`,
				"i",
			);
		};

		const createInterceptFromAuthUrl = (authUrl: string): RegExp => {
			// Extract the base authorization URL (everything before the query parameters)
			const url = new URL(authUrl);
			const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
			
			// Escape special regex characters
			const escapedBaseUrl = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			
			return new RegExp(
				`^${escapedBaseUrl}.*?[?&]redirect_uri=(${redirectUrl}|${encodeURIComponent(redirectUrl)})`,
				"i",
			);
		};

		const intercepts = [
			// Google
			createIntercept("https://accounts.google.com/o/oauth2/auth"),
			// GitHub
			createIntercept("https://github.com/login/oauth/authorize"),
			// Discord
			createIntercept("https://discord.com/api/oauth2/authorize"),
			// Microsoft
			createIntercept(
				"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
			),
		];

		// Add dynamic OIDC intercepts if provider info is available
		if (providers) {
			const oidcProvider = providers["oidc"];
			if (oidcProvider?.info?.authUrl) {
				console.log("[OIDC Provider] Creating dynamic intercept for authUrl:", oidcProvider.info.authUrl);
				intercepts.push(createInterceptFromAuthUrl(oidcProvider.info.authUrl));
			}
		} else {
			// Fallback generic OIDC pattern when no provider info is available
			intercepts.push(new RegExp(
				`.*?/auth.*?[?&]redirect_uri=(${redirectUrl}|${encodeURIComponent(redirectUrl)})`,
				"i",
			));
		}

		return intercepts;
	}

	updateWebviewIntercepts(providers: Record<string, Provider>) {
		// This method can be called to update webview intercepts with provider info
		// Implementation depends on how the main plugin handles intercept updates
		const newIntercepts = this.getWebviewIntercepts(providers);
		console.log("[OIDC Provider] Updated webview intercepts:", newIntercepts.map(r => r.source));
		return newIntercepts;
	}

	async initiateManualOAuth2CodeFlow(
		whichFetch: typeof fetch | typeof customFetch,
		providerNames: string[],
	): Promise<Record<string, Provider>> {
		this.beforeLogin();
		const authMethods = await this.pb
			.collection("users")
			.listAuthMethods({ fetch: whichFetch })
			.catch((e) => {
				throw e.originalError;
			});

		const redirectUrl = this.pb.buildUrl("/api/oauth2-redirect");
		const providers: Record<string, Provider> = {};

		for (const providerName of providerNames) {
			const provider = authMethods.authProviders.find((provider_) => {
				return provider_.name === providerName;
			});

			if (!provider) {
				this.log(`Warning: unable to find provider: ${providerName}`);
				continue;
			}

			const loginFunction = async (code: string) => {
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
						this.setup(authData, provider.name);
						return authData;
					});
			};

			providers[providerName] = new Provider(
				provider.authUrl + redirectUrl,
				provider,
				loginFunction,
			);
		}

		if (Object.keys(providers).length === 0) {
			throw new Error(
				`No valid providers found from requested list: ${providerNames.join(", ")}`,
			);
		}

		return providers;
	}

	async poll(provider: Provider): Promise<RecordAuthResponse<RecordModel>> {
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
					.getOne(provider.info.state.slice(0, 15))
					.then((response) => {
						if (response) {
							clearInterval(timer);
							return resolve(provider.login(response.code));
						}
					})
					.catch((e) => {});
			}, interval);
		});
	}

	async login(provider: string): Promise<boolean> {
		this.beforeLogin();
		const authData = await this.pb.collection("users").authWithOAuth2({
			provider: provider,
		});
		return this.setup(authData, provider);
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
