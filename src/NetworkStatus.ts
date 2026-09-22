import { curryLog } from "./debug";
import type { TimeProvider } from "./TimeProvider";
import { getRelayRequestHeaders, requestUrlWithMetrics } from "./customFetch";
import { httpUrl, readServiceMessage, readMessageValidity, readMessageActions, messageIsCurrent, type MessageValidity, type ServiceMessage, type ServiceMessageAction, type ServiceMessageSelection } from "./ServiceMessages";

export interface ServiceStatus extends MessageValidity {
	id?: string;
	status: string;
	versions?: {
		stable: string;
		beta: string;
	};
	backgroundColor?: string;
	color?: string;
	link?: string;
	actions?: readonly ServiceMessageAction[];
}

type Callback = (status?: ServiceStatus) => void;
interface ProbeResponse {
	status: number;
	serviceStatus?: ServiceStatus | null;
	sidebar?: ServiceMessage | null;
	note?: ServiceMessage | null;
	invalidBody?: boolean;
}
// A network switch (VPN toggle, interface change) surfaces as
// ERR_NETWORK_CHANGED without implying a disconnect, so the check retries
// immediately — but a flapping interface must not recurse unbounded.
const NETWORK_CHANGED_RETRY_LIMIT = 3;

class NetworkStatus {
	private url: string;
	private interval: number;
	private onOnline: Callback[] = [];
	private _onceOnline: Set<Callback>;
	private onOffline: Callback[] = [];
	private timer?: number;
	private _log: (message: string, ...args: unknown[]) => void;
	status?: ServiceStatus;
	online = true;
	private messageListeners = new Set<(message: ServiceMessage | null) => void>();
	private statusListeners = new Set<(status: ServiceStatus | undefined) => void>();
	private noteListeners = new Set<(message: ServiceMessage | null) => void>();
	private selectionListeners = new Set<(selection: ServiceMessageSelection) => void>();
	private selectedNote: ServiceMessage | null = null;
	private note: ServiceMessage | null = null;
	private selectedStatus: ServiceStatus | null = null;
	private selectedSidebar: ServiceMessage | null = null;
	private sidebar: ServiceMessage | null = null;
	private validityTimer?: number;
	private observingValidity = false;
	private refreshOnResume = () => this.refreshMessages();
	private monitorConnectivity = true;
	private destroyed = false;
	private generation = 0;
	private requestSequence = 0;
	private latestResultSequence = 0;

	constructor(
		private timeProvider: TimeProvider,
		url: string,
		interval = 10000,
	) {
		this._log = curryLog("[NetworkStatus]");
		this.url = url;
		this.interval = interval;
		this._onceOnline = new Set();
	}

	log(message: string, ...args: unknown[]) {
		this._log(message, ...args);
	}

	public start({ monitorConnectivity = true }: { monitorConnectivity?: boolean } = {}): void {
		if (this.destroyed || this.timer !== undefined) return;
		this.monitorConnectivity = monitorConnectivity;
		this.observingValidity = true;
		if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("focus", this.refreshOnResume);
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.refreshOnResume);
		this.refreshMessages();
		this.timer = this.timeProvider.setInterval(() => { void this._checkStatus(); }, this.interval);
	}

	public stop(): void {
		this.observingValidity = false;
		if (this.validityTimer !== undefined) this.timeProvider.clearTimeout(this.validityTimer);
		this.validityTimer = undefined;
		if (typeof window !== "undefined" && typeof window.removeEventListener === "function") window.removeEventListener("focus", this.refreshOnResume);
		if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.refreshOnResume);
		if (this.timer !== undefined) this.timeProvider.clearInterval(this.timer);
		this.timer = undefined;
		this.generation++;
	}

	public checkStatus(): Promise<boolean> {
		if (this.online) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			void this._checkStatus().then(() => {
				resolve(this.online);
			});
		});
	}

	private async _checkStatus(): Promise<void> {
		if (this.destroyed) return;
		const generation = this.generation;
		const sequence = ++this.requestSequence;
		const isCurrent = () => !this.destroyed && generation === this.generation && sequence >= this.latestResultSequence;
		for (let attempt = 0; attempt <= NETWORK_CHANGED_RETRY_LIMIT; attempt++) {
			try {
				const response = await requestUrlWithMetrics({
					url: this.url, method: "GET", headers: getRelayRequestHeaders(),
					throw: false, maxResponseBytes: 64 * 1024, relayNetworkDomain: "api",
				});
				if (!isCurrent()) return;
				this.latestResultSequence = sequence;
				const result = readResponse(response.status, () => response.json as unknown);
				if (result.serviceStatus !== undefined) this.selectedStatus = result.serviceStatus;
				if (result.sidebar !== undefined) this.selectedSidebar = result.sidebar;
				if (result.note !== undefined) this.selectedNote = result.note;
				const selection = { sidebar: this.selectedSidebar, note: this.selectedNote };
				this.selectionListeners.forEach(listener => this.notify(listener, selection));
				this.refreshMessages();
				if (this.monitorConnectivity) this.setOnline(isHealthy(result));
				return;
			} catch (error) {
				if (!isCurrent()) return;
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("ERR_NETWORK_CHANGED") && attempt < NETWORK_CHANGED_RETRY_LIMIT) continue;
				this.latestResultSequence = sequence;
				if (this.monitorConnectivity) this.setOnline(false);
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
			this.onOnline.forEach(callback => this.notify(callback, this.status));
			once.forEach(callback => this.notify(callback, this.status));
		} else this.onOffline.forEach(callback => this.notify(callback, this.status));
	}

	private notify<T>(callback: (value: T) => void, value: T): void {
		try {
			callback(value);
		} catch (error) {
			this.log("Network status listener failed", error);
		}
	}

	private refreshMessages(): void {
		if (this.destroyed) return;
		if (this.validityTimer !== undefined) this.timeProvider.clearTimeout(this.validityTimer);
		this.validityTimer = undefined;
		const now = this.timeProvider.now();
		const status = this.selectedStatus && messageIsCurrent(this.selectedStatus, now) ? this.selectedStatus : undefined;
		const sidebar = this.selectedSidebar && messageIsCurrent(this.selectedSidebar, now) ? this.selectedSidebar : null;
		if (this.status !== status) {
			this.status = status;
			this.statusListeners.forEach(listener => this.notify(listener, status));
		}
		if (this.sidebar !== sidebar) {
			this.sidebar = sidebar;
			this.messageListeners.forEach(listener => this.notify(listener, sidebar));
		}
		const note = this.selectedNote && messageIsCurrent(this.selectedNote, now) ? this.selectedNote : null;
		if (this.note !== note) {
			this.note = note;
			this.noteListeners.forEach(listener => this.notify(listener, note));
		}
		if (!this.observingValidity) return;
		const boundaries = [this.selectedStatus, this.selectedSidebar, this.selectedNote].flatMap(message =>
			message ? [message.validFrom, message.validUntil].filter((bound): bound is string => !!bound).map(Date.parse) : []);
		const next = Math.min(...boundaries.filter(bound => bound > now));
		if (Number.isFinite(next)) {
			this.validityTimer = this.timeProvider.setTimeout(() => {
				this.validityTimer = undefined;
				this.refreshMessages();
			}, Math.min(next - now, 2_147_483_647));
		}
	}

	/** Includes inactive messages so dismissal metadata can follow server expiry edits. */
	public subscribeServiceMessageSelection(listener: (selection: ServiceMessageSelection) => void): () => void {
		if (this.destroyed) return () => {};
		this.selectionListeners.add(listener);
		this.notify(listener, { sidebar: this.selectedSidebar, note: this.selectedNote });
		return () => { this.selectionListeners.delete(listener); };
	}

	public subscribeServiceStatus(listener: (status: ServiceStatus | undefined) => void): () => void {
		if (this.destroyed) return () => {};
		this.refreshMessages();
		this.statusListeners.add(listener);
		this.notify(listener, this.status);
		return () => { this.statusListeners.delete(listener); };
	}

	public subscribeServiceMessage(listener: (message: ServiceMessage | null) => void): () => void {
		if (this.destroyed) return () => {};
		this.refreshMessages();
		this.messageListeners.add(listener);
		this.notify(listener, this.sidebar);
		return () => { this.messageListeners.delete(listener); };
	}

	public subscribeNoteMessage(listener: (message: ServiceMessage | null) => void): () => void {
		if (this.destroyed) return () => {};
		this.refreshMessages();
		this.noteListeners.add(listener);
		this.notify(listener, this.note);
		return () => { this.noteListeners.delete(listener); };
	}

	public onceOnline(callback: Callback): () => void {
		this._onceOnline.add(callback);
		return () => { this._onceOnline.delete(callback); };
	}

	public addEventListener(
		eventType: "online" | "offline",
		callback: Callback,
	): void {
		if (eventType === "online") {
			this.onOnline.push(callback);
		} else if (eventType === "offline") {
			this.onOffline.push(callback);
		}
	}

	destroy(): void {
		this.stop();
		this.destroyed = true;
		this._onceOnline.clear();
		this.onOnline = [];
		this.onOffline = [];
		this.messageListeners.clear();
		this.statusListeners.clear();
		this.noteListeners.clear();
		this.selectionListeners.clear();
		this.selectedNote = null;
		this.note = null;
		this.selectedStatus = null;
		this.selectedSidebar = null;
		this.sidebar = null;
		this.status = undefined;
	}
}

function isHealthy(response: ProbeResponse): boolean {
	return response.status === 200 && !response.invalidBody;
}

function readResponse(status: number, readBody: () => unknown): ProbeResponse {
	try {
		const body = readBody();
		if (!body || typeof body !== "object" || Array.isArray(body)) return { status };
		const entry = body as Record<string, unknown>;
		const validity = readMessageValidity(entry);
		const cleared = entry.status === undefined || entry.status === null ||
			(typeof entry.status === "string" && !entry.status.trim()) ||
			(entry.status === "ok" && entry.backgroundColor === "transparent" && entry.color === "transparent");
		let serviceStatus: ServiceStatus | null | undefined = cleared ? null : undefined;
		if (!cleared && typeof entry.status === "string" && validity) {
			serviceStatus = { status: entry.status, ...validity };
			const actions = readMessageActions(entry.actions);
			if (actions.length) serviceStatus.actions = actions;
			const link = httpUrl(entry.link);
			if (link) serviceStatus.link = link;
			for (const key of ["id", "backgroundColor", "color"] as const) {
				const value = entry[key];
				if (typeof value === "string") serviceStatus[key] = value;
			}
			const versions = entry.versions as Record<string, unknown> | undefined;
			if (versions && typeof versions.stable === "string" && typeof versions.beta === "string") {
				serviceStatus.versions = { stable: versions.stable, beta: versions.beta };
			}
		}
		return { status, serviceStatus, sidebar: readServiceMessage(entry.sidebar), note: readServiceMessage(entry.note) };
	} catch {
		return { status, invalidBody: true };
	}
}

export default NetworkStatus;
