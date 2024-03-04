import { requestUrl } from "obsidian";
import { ObservableSet } from "./ObservableSet";
import { User } from "./User";
import PocketBase, { BaseAuthStore } from "pocketbase";

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

	constructor(user: User) {
		super();
		this.user = user;
		this.getPaymentLink();
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
			url: "https://api.dnup.org/billing",
			method: "POST",
			headers: headers,
		}).then((response) => {
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
		});
	}
}

export class LoginManager extends ObservableSet<User> {
	pb: PocketBase;
	sm: SubscriptionManager;

	setup(): boolean {
		this.pb = new PocketBase("https://auth.dnup.org");
		if (!this.pb.authStore.isValid) {
			this.notifyListeners(); // notify anyway
			return false;
		}
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
			url: "https://api.dnup.org/whoami",
			method: "GET",
			headers: headers,
		}).then((response) => {
			console.log(response.json);
		});
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

	async login() {
		if (this.hasUser) {
			return;
		}
		await this.pb.collection("users").authWithOAuth2({
			provider: "google",
		});
		this.setup();
	}
}
