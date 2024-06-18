import { requestUrl } from "obsidian";
import { ObservableSet } from "./observable/ObservableSet";
import { User } from "./User";
import PocketBase, { BaseAuthStore } from "pocketbase";
import { curryLog } from "./debug";

declare const API_URL: string;
declare const AUTH_URL: string;

class Subscription {
	active: boolean;
	subscribe: string | null;
	cancel: string | null;

	constructor(
		active: boolean,
		subscribe: string | null,
		cancel: string | null
	) {
		this.active = active;
		this.subscribe = subscribe;
		this.cancel = cancel;
	}
}

class SubscriptionManager extends ObservableSet<Subscription> {
	user: User;
	private _log: (message: string, ...args: unknown[]) => void;

	constructor(user: User) {
		super();
		this._log = curryLog("[SubscriptionManager]");
		this.user = user;
		this.getPaymentLink();
	}

	log(message: string, ...args: unknown[]) {
		this._log(message, ...args);
	}

	hasSubscription() {
		return this.items().length > 0;
	}

	public get subscription(): Subscription | null {
		if (this.items().length == 0) {
			return null;
		} else if (this.items().length == 1) {
			return this.items()[0];
		}
		throw new Error(
			"Unexpected multiple subscriptions in subscription manager"
		);
	}

	getPaymentLink() {
		const headers = {
			Authorization: `Bearer ${this.user.token}`,
		};
		requestUrl({
			url: `${API_URL}/billing`,
			method: "POST",
			headers: headers,
		})
			.then((response) => {
				if (response.status !== 200) {
					throw Error(
						`Received status code ${response.status} from an API.`
					);
				}
				const response_json = response.json;
				this.add(
					new Subscription(
						response_json["active"],
						response_json["subscribe"],
						response_json["cancel"]
					)
				);
			})
			.catch((reason) => {
				this.log(reason);
			});
	}
}

export class LoginManager extends ObservableSet<User> {
	pb: PocketBase;
	sm?: SubscriptionManager;
	private _log: (message: string, ...args: unknown[]) => void;

	constructor() {
		super();
		this._log = curryLog("[LoginManager]");
		this.pb = new PocketBase(AUTH_URL);
	}

	log(message: string, ...args: unknown[]) {
		this._log(message, ...args);
	}

	setup(): boolean {
		this.pb = new PocketBase(AUTH_URL);
		if (!this.pb.authStore.isValid) {
			this.notifyListeners(); // notify anyway
			return false;
		}
		this.log("LoginManager", this);
		const user = this.makeUser(this.pb.authStore);
		this.sm = new SubscriptionManager(user);
		this.add(user);
		this.whoami();
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
		return this.pb.authStore.isValid;
	}

	get hasUser() {
		return this.items().length > 0;
	}

	private makeUser(authStore: BaseAuthStore): User {
		return new User(authStore.model?.email, authStore.token);
	}

	public get anon(): User {
		return new User("Anonymous", "");
	}

	public get user(): User {
		if (this.items().length == 0) {
			return this.anon;
		} else if (this.items().length == 1) {
			return this.items()[0];
		}
		throw new Error("Unexpected multiple users in login manager");
	}

	logout() {
		this.pb.authStore.clear();
		this.forEach((user) => {
			this.delete(user);
		});
	}

	async login(): Promise<boolean> {
		if (this.hasUser) {
			return true;
		}
		const authData = await this.pb.collection("users").authWithOAuth2({
			provider: "google",
		});
		this.pb
			.collection("oauth2_response")
			.create({
				user: authData.record.id,
				oauth_response: authData.meta?.rawUser,
			})
			.catch((e) => {
				// OAuth2 data already exists
			});
		return this.setup();
	}
}
