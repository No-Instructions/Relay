import { curryLog } from "./debug";
import type { TimeProvider } from "./TimeProvider";
import { StatusRequest } from "./StatusRequest";

interface ServiceStatus {
	status: string;
	versions?: { stable: string; beta: string };
	backgroundColor?: string;
	color?: string;
	link?: string;
}

type Callback = (status?: ServiceStatus) => void;
const NETWORK_CHANGED_RETRY_LIMIT = 3;

class NetworkStatus {
	private onOnline: Callback[] = [];
	private onOffline: Callback[] = [];
	private _onceOnline = new Set<Callback>();
	private timer?: number;
	private generation = 0;
	private requestSequence = 0;
	private latestResultSequence = 0;
	private destroyed = false;
	private _log = curryLog("[NetworkStatus]");
	private readonly request: StatusRequest;
	status?: ServiceStatus;
	online = true;

	constructor(private timeProvider: TimeProvider, url: string, private interval = 10000) {
		this.request = new StatusRequest(timeProvider, url);
	}

	log(message: string, ...args: unknown[]) {
		this._log(message, ...args);
	}

	public start(): void {
		if (this.destroyed || this.timer !== undefined) return;
		this.timer = this.timeProvider.setInterval(() => { void this._checkStatus(); }, this.interval);
	}

	public stop(): void {
		if (this.timer !== undefined) this.timeProvider.clearInterval(this.timer);
		this.timer = undefined;
		this.generation++;
		this.request.stop();
	}

	public async checkStatus(): Promise<boolean> {
		if (!this.online && !this.destroyed) await this._checkStatus();
		return this.online;
	}

	private async _checkStatus(): Promise<void> {
		if (this.destroyed) return;
		const generation = this.generation;
		const sequence = ++this.requestSequence;
		const isCurrent = () => !this.destroyed && generation === this.generation && sequence >= this.latestResultSequence;
		for (let attempt = 0; attempt <= NETWORK_CHANGED_RETRY_LIMIT; attempt++) {
			try {
				const response = await this.request.request();
				if (!isCurrent()) return;
				this.latestResultSequence = sequence;
				if (response.status === 200) {
					const body = response.json as ServiceStatus | undefined;
					if (body?.status) this.status = body;
					this.setOnline(true);
				} else this.setOnline(false);
				return;
			} catch (error) {
				if (!isCurrent()) return;
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("ERR_NETWORK_CHANGED") && attempt < NETWORK_CHANGED_RETRY_LIMIT) continue;
				this.latestResultSequence = sequence;
				this.setOnline(false);
				return;
			}
		}
	}

	private setOnline(online: boolean): void {
		if (this.online === online) return;
		this.online = online;
		if (online) {
			this.log("back online");
			const once = [...this._onceOnline];
			this._onceOnline.clear();
			this.onOnline.forEach(callback => this.notify(callback));
			once.forEach(callback => this.notify(callback));
		} else this.onOffline.forEach(callback => this.notify(callback));
	}

	private notify(callback: Callback): void {
		try { callback(this.status); }
		catch (error) { this.log("Network status listener failed", error); }
	}

	public onceOnline(callback: Callback): void { this._onceOnline.add(callback); }

	public addEventListener(eventType: "online" | "offline", callback: Callback): void {
		(eventType === "online" ? this.onOnline : this.onOffline).push(callback);
	}

	destroy(): void {
		this.stop();
		this.destroyed = true;
		this._onceOnline.clear();
		this.onOnline = [];
		this.onOffline = [];
	}
}

export default NetworkStatus;
