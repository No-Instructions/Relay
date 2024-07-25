"use strict";

import { requestUrl } from "obsidian";
import { User } from "./User";
import PocketBase, { BaseAuthStore } from "pocketbase";
import { curryLog } from "./debug";
import { Observable } from "./observable/Observable";

declare const AUTH_URL: string;
declare const API_URL: string;

import { customFetch } from "./customFetch";

export class OAuth2Url extends Observable<OAuth2Url> {
	url?: string;
	delay: number = 0;
	_age: number = 0;

	set(value: string) {
		this.url = value;
		this._age = Date.now();
		this.notifyListeners();
	}

	public get age() {
		return Date.now() - this._age;
	}
}

export class LoginManager extends Observable<LoginManager> {
	pb: PocketBase;
	private _log: (message: string, ...args: unknown[]) => void;
	private openSettings: () => Promise<void>;
	url: OAuth2Url;
	user?: User;

	constructor(openSettings: () => Promise<void>) {
		super();
		this._log = curryLog("[LoginManager]");
		this.pb = new PocketBase(AUTH_URL);
		this.pb.beforeSend = (url, options) => {
			this._log(url, options);
			return { url, options };
		};
		this.openSettings = openSettings;
		this.url = new OAuth2Url();
		this.user = this.pb.authStore.isValid
			? this.makeUser(this.pb.authStore)
			: undefined;
	}

	log(message: string, ...args: unknown[]) {
		this._log(message, ...args);
	}

	setup(): boolean {
		if (!this.pb.authStore.isValid) {
			this.notifyListeners(); // notify anyway
			return false;
		}
		this.log("LoginManager", this);
		this.user = this.makeUser(this.pb.authStore);
		this.notifyListeners();
		//this.whoami();
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
		this.pb.authStore.clear();
		this.user = undefined;
		this.notifyListeners();
	}

	async getLoginUrl(): Promise<number> {
		const start = Date.now();
		return new Promise<number>((resolve, reject) => {
			this.pb
				.collection("users")
				.authWithOAuth2({
					provider: "google",
					urlCallback: (url) => {
						this.url.set(url);
						const end = Date.now();
						this.url.delay = end - start;
						resolve(this.url.delay);
					},
					fetch: customFetch,
				})
				.then((authData) => {
					this.pb
						.collection("oauth2_response")
						.create({
							user: authData.record.id,
							oauth_response: authData.meta?.rawUser,
						})
						.catch((e) => {
							// OAuth2 data already exists
						});
					this.setup();
				});
		});
	}

	async login(): Promise<boolean> {
		await this.pb
			.collection("users")
			.authWithOAuth2({
				provider: "google",
				fetch: customFetch,
			})
			.then((authData) => {
				this.pb
					.collection("oauth2_response")
					.create({
						user: authData.record.id,
						oauth_response: authData.meta?.rawUser,
						fetch: customFetch,
					})
					.catch((e) => {
						// OAuth2 data already exists
					});
			});
		return this.setup();
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
