import { requestUrl } from "obsidian";

type Callback = () => void;

class NetworkStatus {
	private url: string;
	private interval: number;
	private onOnline: Callback[] = [];
	private _onceOnline: Set<Callback>;
	private onOffline: Callback[] = [];
	online = true;

	constructor(url: string, interval = 10000) {
		this.url = url;
		this.interval = interval;
		this._onceOnline = new Set();
		this.checkStatusRepeatedly();
	}

	private checkStatusRepeatedly(): void {
		setInterval(this._checkStatus.bind(this), this.interval);
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
		console.log(`checking network connection. online? ${this.online}`);
		return requestUrl({ url: this.url, method: "HEAD" })
			.then((response) => {
				if (response.status === 200 && !this.online) {
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
