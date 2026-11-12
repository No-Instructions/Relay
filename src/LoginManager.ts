"use strict";

import {
	refreshRelayToken,
	logoutRelay,
	recordOAuthResponse,
} from "../packages/relay-auth/src/session";
import {
	RelayOAuthClient,
	Provider,
} from "../packages/relay-auth/src/OAuthClient";
export { Provider } from "../packages/relay-auth/src/OAuthClient";

import type { RequestUrlResponsePromise } from "obsidian";
import {
	User,
	resolveProfileEmail,
	resolveProfileName,
	resolveProfilePicture,
	type ProfileFileUrl,
} from "./User";
import PocketBase, {
	BaseAuthStore,
	type RecordAuthResponse,
	type RecordModel,
} from "pocketbase";
import { RelayInstances, curryLog } from "./debug";
import { Observable } from "./observable/Observable";

import {
	customFetch,
	getRelayRequestHeaders,
	requestUrlWithMetrics,
	setNetworkDomainUrls,
} from "./customFetch";
import { LocalAuthStore } from "./pocketbase/LocalAuthStore";
import { routeRealtimeSubmit } from "./pocketbase/realtimeSubmit";
import type { TimeProvider } from "./TimeProvider";
import { type ServerFlags, FeatureFlagManager } from "./flagManager";
import type { NamespacedSettings } from "./SettingsStorage";
import { type EndpointManager } from "./EndpointManager";

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
function normalizeOAuthUser(rawUser: unknown): NormalizedOAuthUser | null {
	const user = rawUser as Record<string, unknown>;
	// Handle Google user
	if (
		"email" in user &&
		"name" in user &&
		"given_name" in user &&
		"family_name" in user
	) {
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
	if ("email" in user && "login" in user && "avatar_url" in user) {
		const githubUser = rawUser as GitHubUser;
		const nameParts = (githubUser.name || githubUser.login).split(" ");
		return {
			name: githubUser.name || githubUser.login,
			given_name: nameParts[0] || githubUser.login,
			family_name: nameParts.slice(1).join(" ") || "",
			email: githubUser.email,
			picture: githubUser.avatar_url,
		};
	}

	// Handle Microsoft user
	if ("mail" in user && "displayName" in user) {
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
	if ("email" in user && "given_name" in user && "family_name" in user) {
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
	authStoreModel: {
		name?: string;
		email?: string;
		picture?: string;
	},
	rawUser?: unknown,
	getFileUrl?: ProfileFileUrl,
	streamerMode = false,
): User {
	const normalizedOAuth =
		rawUser && !streamerMode ? normalizeOAuthUser(rawUser) : null;

	return new User(
		id,
		resolveProfileName(
			authStoreModel,
			normalizedOAuth?.name || "",
			streamerMode,
		),
		resolveProfileEmail(
			authStoreModel,
			normalizedOAuth?.email || "",
			streamerMode,
		),
		resolveProfilePicture(
			authStoreModel,
			normalizedOAuth?.picture || "",
			getFileUrl,
			streamerMode,
		),
		token,
	);
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
		private timeProvider: TimeProvider,
		private beforeLogin: () => void,
		public loginSettings: NamespacedSettings<LoginSettings>,
		endpointManager: EndpointManager,
	) {
		super();
		this.authStore = new LocalAuthStore(`pocketbase_auth_${vaultName}`);
		this.endpointManager = endpointManager;
		this.updateNetworkMetricDomains();
		this.pb = this.createPocketBase(this.endpointManager.getAuthUrl());
		this.refreshToken();
		timeProvider.setInterval(() => this.refreshToken(), 86400000);
		this.unsubscribes.push(
			FeatureFlagManager.getInstance().on(() => {
				if (!this.pb.authStore.isValid) return;
				this.user = this.makeUser(this.pb.authStore);
				this.notifyListeners();
			}),
		);
		this.openSettings = openSettings;
		if (!this.pb.authStore.isValid) {
			this.logout();
		}
		if (this.pb.authStore.model?.id) {
			this.pb
				.collection("users")
				.getOne(this.pb.authStore.model.id as string)
				.then(() => {
					this.getFlags();
				})
				.catch((response: { status?: number }) => {
					if (response.status === 404) {
						this.logout();
					}
				});
		}
		RelayInstances.set(this, "loginManager");
	}

	private updateNetworkMetricDomains(): void {
		setNetworkDomainUrls({
			apiUrl: this.endpointManager.getApiUrl(),
			authUrl: this.endpointManager.getAuthUrl(),
		});
	}

	refreshToken() {
		if (this.pb.authStore.isValid) {
			const pb = this.pb;
			this.user = this.makeUser(pb.authStore);
			refreshRelayToken(pb)
				.then((authData) => {
					if (this.pb !== pb) {
						return;
					}
					this.user = this.makeUser(pb.authStore);
					this.notifyListeners();
					const token = authData.token;
					const [, payload] = token.split(".");
					const decodedPayload = JSON.parse(atob(payload)) as {
						exp: number;
						id?: string;
						email?: string;
					};

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
						...(FeatureFlagManager.getInstance().getFlag("enableStreamerMode")
							? {}
							: { email: decodedPayload.email }),
					});
				})
				.catch((reason) => {
					this.log("Token refresh failed", reason);
				});
		}
	}

	setup(
		authData?: RecordAuthResponse<RecordModel>,
		provider?: string,
	): boolean {
		if (!this.pb.authStore.isValid) {
			this.notifyListeners(); // notify anyway
			return false;
		}
		this.user = this.makeUser(
			this.pb.authStore,
			authData?.meta?.rawUser as
				| GoogleUser
				| GitHubUser
				| MicrosoftUser
				| OIDCUser
				| undefined,
		);
		this.notifyListeners();
		if (authData) {
			recordOAuthResponse(this.pb, authData)
				.then(() => {
					this.notifyListeners();
				})
				.catch((reason) => {
					this.log(reason);
				});
		}
		if (provider) {
			void this.loginSettings.set({ provider });
		}
		return true;
	}

	clearPreferredProvider() {
		void this.loginSettings.set({ provider: undefined });
	}

	async checkRelayHost(relay_guid: string): Promise<RequestUrlResponsePromise> {
		const headers = {
			Authorization: `Bearer ${this.pb.authStore.token}`,
			...getRelayRequestHeaders(),
		};
		return requestUrlWithMetrics({
			url: `${this.endpointManager.getApiUrl()}/relay/${relay_guid}/check-host`,
			method: "GET",
			headers: headers,
			relayNetworkDomain: "api",
		});
	}

	getFlags() {
		const headers = {
			Authorization: `Bearer ${this.pb.authStore.token}`,
			...getRelayRequestHeaders(),
		};
		requestUrlWithMetrics({
			url: `${this.endpointManager.getApiUrl()}/flags`,
			method: "GET",
			headers: headers,
			relayNetworkDomain: "api",
		})
			.then((response) => {
				if (response.status === 200) {
					const serverFlags = response.json as ServerFlags[];
					void FeatureFlagManager.getInstance().applyServerFlags(serverFlags);
				}
			})
			.catch((reason) => {
				this.log(reason);
			});
	}

	whoami() {
		const headers = {
			Authorization: `Bearer ${this.pb.authStore.token}`,
			...getRelayRequestHeaders(),
		};
		requestUrlWithMetrics({
			url: `${this.endpointManager.getApiUrl()}/whoami`,
			method: "GET",
			headers: headers,
			relayNetworkDomain: "api",
		})
			.then((response) => {
				this.log(
					FeatureFlagManager.getInstance().getFlag("enableStreamerMode")
						? { id: (response.json as { id?: string } | undefined)?.id }
						: (response.json as unknown),
				);
			})
			.catch((reason) => {
				this.log(reason);
			});
	}

	public get loggedIn() {
		return this.user !== undefined;
	}

	public getAccountEmailForRequest(): string {
		return (this.pb.authStore.model?.email as string | undefined) || "";
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
		licenseInfo?: unknown;
	}> {
		const result =
			await this.endpointManager.validateAndSetEndpoints(timeoutMs);
		if (result.success) {
			this.updateNetworkMetricDomains();
		}

		if (result.success && this.endpointManager.hasValidatedEndpoints()) {
			// Clean up old PocketBase instance before creating new one
			this.pb.cancelAllRequests();
			void this.pb.realtime.unsubscribe();

			// Recreate PocketBase instance with new auth URL
			this.pb = this.createPocketBase(this.endpointManager.getAuthUrl());
			this.log("Updated PocketBase instance with validated endpoints");
		}

		return result;
	}

	private createPocketBase(authUrl: string): PocketBase {
		const pbLog = curryLog("[Pocketbase]", "debug");
		// Concurrent consumers must not cancel one another when the transport honors signals.
		const pb = new PocketBase(authUrl, this.authStore).autoCancellation(false);
		pb.beforeSend = (url, options) => {
			pbLog(url, options);
			if (!this.pb.authStore.isValid && this.user) {
				this.logout();
			}
			options.fetch = customFetch;
			routeRealtimeSubmit(url, options, () => pb.realtime.clientId);
			options.headers = Object.assign(
				{},
				options.headers,
				getRelayRequestHeaders(),
			);
			return { url, options };
		};
		return pb;
	}

	get hasUser() {
		return this.user !== undefined;
	}

	private makeUser(
		authStore: BaseAuthStore,
		rawUser?: GoogleUser | GitHubUser | MicrosoftUser | OIDCUser,
	): User {
		return createUserFromOAuth(
			authStore.model?.id as string,
			authStore.token,
			authStore.model as {
				name?: string;
				email?: string;
				picture?: string;
			},
			rawUser,
			(record, filename, options) =>
				this.pb.files.getUrl(record, filename, options),
			FeatureFlagManager.getInstance().getFlag("enableStreamerMode"),
		);
	}

	logout() {
		logoutRelay(this.pb);
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
			const escapedBaseUrl = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
				console.debug(
					"[OIDC Provider] Creating dynamic intercept for authUrl:",
					oidcProvider.info.authUrl,
				);
				intercepts.push(createInterceptFromAuthUrl(oidcProvider.info.authUrl));
			}
		} else {
			// Fallback generic OIDC pattern when no provider info is available
			intercepts.push(
				new RegExp(
					`.*?/auth.*?[?&]redirect_uri=(${redirectUrl}|${encodeURIComponent(redirectUrl)})`,
					"i",
				),
			);
		}

		return intercepts;
	}

	updateWebviewIntercepts(providers: Record<string, Provider>) {
		// This method can be called to update webview intercepts with provider info
		// Implementation depends on how the main plugin handles intercept updates
		const newIntercepts = this.getWebviewIntercepts(providers);
		console.debug(
			"[OIDC Provider] Updated webview intercepts:",
			newIntercepts.map((r) => r.source),
		);
		return newIntercepts;
	}

	private oauthClient() {
		return new RelayOAuthClient(
			() => this.pb,
			this.timeProvider,
			(data, provider) => this.setup(data, provider),
			this.beforeLogin,
		);
	}
	async initiateManualOAuth2CodeFlow(
		whichFetch: typeof fetch | typeof customFetch,
		providerNames: string[],
	): Promise<Record<string, Provider>> {
		return this.oauthClient().initiateManualOAuth2CodeFlow(
			whichFetch,
			providerNames,
		);
	}
	async poll(provider: Provider): Promise<RecordAuthResponse<RecordModel>> {
		return this.oauthClient().poll(provider);
	}
	async login(provider: string): Promise<boolean> {
		return this.oauthClient().login(provider);
	}

	async openLoginPage() {
		await this.openSettings();
		const promise = new Promise<boolean>((resolve, reject) => {
			const isLoggedIn = () => {
				if (this.loggedIn) {
					this.off(isLoggedIn);
					resolve(true);
				}
			};
			this.on(isLoggedIn);
		});
		return await promise;
	}

	destroy() {
		this.pb.cancelAllRequests();
		void this.pb.realtime.unsubscribe();
		this.pb = null as unknown as typeof this.pb;
		this.authStore.destroy();
		this.authStore = null as unknown as typeof this.authStore;
		this.user = undefined;
		this.openSettings = null as unknown as typeof this.openSettings;
		super.destroy();
	}
}
