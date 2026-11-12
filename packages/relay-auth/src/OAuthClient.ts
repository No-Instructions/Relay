import type PocketBase from "pocketbase";
import type {
	AuthProviderInfo,
	RecordAuthResponse,
	RecordModel,
} from "pocketbase";
export interface OAuthClock {
	setInterval(callback: () => unknown, ms: number): number;
	clearInterval(timer: number): void;
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

export class RelayOAuthClient {
	constructor(
		private client: PocketBase | (() => PocketBase),
		private timeProvider: OAuthClock,
		private onAuth: (
			data: RecordAuthResponse<RecordModel>,
			provider: string,
		) => boolean,
		private beforeLogin: () => void = () => {},
	) {}
	private get pb(): PocketBase {
		return typeof this.client === "function" ? this.client() : this.client;
	}
	async initiateManualOAuth2CodeFlow(
		whichFetch: typeof fetch,
		providerNames?: string[],
	): Promise<Record<string, Provider>> {
		this.beforeLogin();
		const authMethods = await this.pb
			.collection("users")
			.listAuthMethods({ fetch: whichFetch })
			.catch((e: { originalError?: unknown }) => {
				throw e.originalError ?? e;
			});

		const redirectUrl = this.pb.buildUrl("/api/oauth2-redirect");
		const providers: Record<string, Provider> = {};

		for (const providerName of providerNames ??
			authMethods.authProviders.map((provider) => provider.name)) {
			const provider = authMethods.authProviders.find((provider_) => {
				return provider_.name === providerName;
			});

			if (!provider) {
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
						this.onAuth(authData, provider.name);
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
				`No valid providers found from requested list: ${(providerNames ?? []).join(", ")}`,
			);
		}

		return providers;
	}

	async poll(
		provider: Provider,
		signal?: AbortSignal,
	): Promise<RecordAuthResponse<RecordModel>> {
		if (signal?.aborted)
			throw new DOMException("Login cancelled", "AbortError");
		let counter = 0;
		return new Promise((resolve, reject) => {
			let finished = false,
				inFlight = false;
			const cleanup = () => {
				this.timeProvider.clearInterval(timer);
				signal?.removeEventListener("abort", abort);
			};
			const abort = () => {
				if (!finished) {
					finished = true;
					cleanup();
					reject(new DOMException("Login cancelled", "AbortError"));
				}
			};
			const timer = this.timeProvider.setInterval(() => {
				if (finished) return;
				if (++counter >= 30) {
					finished = true;
					cleanup();
					reject(new Error(`Auth timeout: Timed out after ${counter} seconds`));
					return;
				}
				if (inFlight) return;
				inFlight = true;
				this.pb
					.collection("code_exchange")
					.getOne(provider.info.state.slice(0, 15))
					.then(async (response) => {
						if (!response || finished || signal?.aborted) return;
						finished = true;
						cleanup();
						try {
							resolve(
								await provider.login(
									(response as unknown as { code: string }).code,
								),
							);
						} catch (error) {
							reject(error);
						}
					})
					.catch(() => {})
					.finally(() => {
						inFlight = false;
					});
			}, 1000);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	async login(provider: string): Promise<boolean> {
		this.beforeLogin();
		try {
			const authData = await this.pb.collection("users").authWithOAuth2({
				provider: provider,
			});
			return this.onAuth(authData, provider);
		} catch (e) {
			// Clean up realtime subscription to prevent reconnection loops
			// authWithOAuth2 internally subscribes to @oauth2 via SSE, and if it fails,
			// PocketBase's realtime client will keep trying to reconnect indefinitely
			void this.pb.realtime.unsubscribe();
			throw e;
		}
	}
}
