import { requestUrl } from "obsidian";

type Callback = () => void;

class NetworkStatus {
	private url: string;
	private interval: number;
	private onOnline: Callback[] = [];
	private _onceOnline: Set<Callback>;
	private onOffline: Callback[] = [];
	private timer?: NodeJS.Timer;
	online = true;

	constructor(url: string, interval = 10000) {
		this.url = url;
		this.interval = interval;
		this._onceOnline = new Set();
		this.start();
	}

	log(text: string) {
		console.log(text);
	}

	public start() {
		if (!this.timer) {
			this.timer = this.checkStatusRepeatedly();
		}
	}

	public stop() {
		if (this.timer) {
			clearInterval(this.timer);
		}
	}

	private checkStatusRepeatedly(): NodeJS.Timer {
		return setInterval(this._checkStatus.bind(this), this.interval);
	}

	public checkStatus(): Promise<boolean> {
		if (this.online) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			this._checkStatus().then(() => {
				resolve(this.online);
			});
		});
	}

	private async _checkStatus(): Promise<void> {
		return requestUrl({ url: this.url, method: "HEAD" })
			.then((response) => {
				if (response.status === 200 && !this.online) {
					this.log("back online");
					this.online = true;
					this.onOnline.forEach((callback) => callback());

					this._onceOnline.forEach((callback) => callback());
					this._onceOnline.clear();

					return;
				} else if (response.status !== 200 && this.online) {
					throw new Error("disconnected");
				}
			})
			.catch((error) => {
				console.log(error);
				if (error.message.includes("ERR_NETWORK_CHANGED")) {
					console.warn("error in message", error);
					return;
				}
				if (error.name.includes("ERR_NETWORK_CHANGED")) {
					console.warn("error in name", error);
					return;
				}
				this.online = false;
				this.onOffline.forEach((callback) => callback());
			});
	}

	public onceOnline(callback: Callback): void {
		this._onceOnline.add(callback);
	}

	public addEventListener(
		eventType: "online" | "offline",
		callback: Callback
	): void {
		if (eventType === "online") {
			this.onOnline.push(callback);
		} else if (eventType === "offline") {
			this.onOffline.push(callback);
		}
	}
}

export default NetworkStatus;
