"use strict";

import { requestUrl } from "obsidian";
import { User } from "./User";
import PocketBase, {
	BaseAuthStore,
	ClientResponseError,
	type AuthProviderInfo,
	type RecordAuthResponse,
	type RecordModel,
} from "pocketbase";
import { curryLog } from "./debug";
import { Observable } from "./observable/Observable";

declare const AUTH_URL: string;
declare const API_URL: string;
declare const GIT_TAG: string;

import { customFetch } from "./customFetch";

function openBrowserPopup(url?: string): Window | null {
	if (typeof window === "undefined" || !window?.open) {
		throw new ClientResponseError(
			new Error(
				`Not in a browser context - please pass a custom urlCallback function.`
			)
		);
	}

	let width = 1024;
	let height = 768;

	let windowWidth = window.innerWidth;
	let windowHeight = window.innerHeight;

	// normalize window size
	width = width > windowWidth ? windowWidth : width;
	height = height > windowHeight ? windowHeight : height;

	let left = windowWidth / 2 - width / 2;
	let top = windowHeight / 2 - height / 2;

	// note: we don't use the noopener and noreferrer attributes since
	// for some reason browser blocks such windows then url is undefined/blank
	return window.open(
		url,
		"popup_window",
		"width=" +
			width +
			",height=" +
			height +
			",top=" +
			top +
			",left=" +
			left +
			",resizable,menubar=no"
	);
}

export class LoginManager extends Observable<LoginManager> {
	pb: PocketBase;
	private _log: (message: string, ...args: unknown[]) => void;
	private openSettings: () => Promise<void>;
	user?: User;
	resolve?: (code: string) => Promise<RecordAuthResponse<RecordModel>>;

	constructor(openSettings: () => Promise<void>) {
		super();
		this._log = curryLog("[LoginManager]");
		const pbLog = curryLog("[Pocketbase]");
		this.pb = new PocketBase(AUTH_URL);
		this.pb.beforeSend = (url, options) => {
			pbLog(url, this.pb, options);
			options.fetch = customFetch;
			options.headers = Object.assign({}, options.headers, {
				"Relay-Version": GIT_TAG,
			});
			return { url, options };
		};
		this.openSettings = openSettings;
		this.user = this.pb.authStore.isValid
			? this.makeUser(this.pb.authStore)
			: undefined;
		this._log("instance", this);
	}

	log(message: string, ...args: unknown[]) {
		this._log(message, ...args);
	}

	setup(authData?: RecordAuthResponse<RecordModel> | undefined): boolean {
		if (!this.pb.authStore.isValid) {
			this.notifyListeners(); // notify anyway
			return false;
		}
		this.log("LoginManager", this);
		this.user = this.makeUser(this.pb.authStore);
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

	private makeUser(authStore: BaseAuthStore): User {
		return new User(
			authStore.model?.id,
			authStore.model?.email,
			authStore.token
		);
	}

	public get anon(): User {
		return new User("", "Anonymous", "");
	}

	logout() {
		this.pb.cancelAllRequests();
		this.pb.authStore.clear();
		this.user = undefined;
		this.notifyListeners();
	}

	async initiateManualOAuth2CodeFlow(
		whichFetch: typeof fetch | typeof customFetch
	): Promise<
		[
			string,
			AuthProviderInfo,
			(code: string) => Promise<RecordAuthResponse<RecordModel>>
		]
	> {
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
						}
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
		authWithCode: (code: string) => Promise<RecordAuthResponse<RecordModel>>
	): Promise<RecordAuthResponse<RecordModel>> {
		let counter = 0;
		const interval = 1000;
		return new Promise((resolve, reject) => {
			const timer = setInterval(() => {
				counter += 1;
				if (counter > 30) {
					clearInterval(timer);
					return reject(
						new Error(
							`Auth timeout: Timed out after ${
								(counter * interval) / 1000
							} seconds`
						)
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
		try {
			const authData = await this.pb.collection("users").authWithOAuth2({
				provider: "google",
			});
			return this.setup(authData);
		} catch (e) {
			this.log("request failed", e);
			console.error("Authenticating failed", e);
			return false;
		}
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
}
