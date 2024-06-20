import { requestUrl } from "obsidian";
import { curryLog } from "./debug";

type Callback = () => void;

class NetworkStatus {
	private url: string;
	private interval: number;
	private onOnline: Callback[] = [];
	private _onceOnline: Set<Callback>;
	private onOffline: Callback[] = [];
	private timer?: NodeJS.Timer;
	private _log: (message: string, ...args: unknown[]) => void;
	online = true;

	constructor(url: string, interval = 10000) {
		this._log = curryLog("[NetworkStatus]");
		this.url = url;
		this.interval = interval;
		this._onceOnline = new Set();
	}

	log(message: string, ...args: unknown[]) {
		this._log(message, ...args);
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
				if (error.message.includes("ERR_NETWORK_CHANGED")) {
					// This doesn't necessarily imply a disconnect,
					// We should immediately try again to get a name resolution error.
					this._checkStatus();
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
