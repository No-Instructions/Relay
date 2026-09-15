import { Platform, requestUrl } from "obsidian";
import { curryLog } from "./debug";
import type { TimeProvider } from "./TimeProvider";
import { getRelayRequestHeaders, requestUrlWithMetrics } from "./customFetch";
import { nodeRequestUrl, useNativeNetworking } from "./NodeHttp";
import { readServiceMessage, readMessageValidity, readMessageActions, messageIsCurrent, type MessageValidity, type ServiceMessage, type ServiceMessageAction } from "./ServiceMessages";

export interface ServiceStatus extends MessageValidity {
	id?: string;
	status: string;
	versions?: { stable: string; beta: string };
	backgroundColor?: string;
	color?: string;
	link?: string;
	actions?: readonly ServiceMessageAction[];
}

type Callback = (status?: ServiceStatus) => void;
type Transport = "obsidian" | "fetch" | "node";
export type NetworkTransportFailure = "obsidian" | "node" | null;
interface ProbeResponse {
	status: number;
	serviceStatus?: ServiceStatus | null;
	sidebar?: ServiceMessage | null;
	note?: ServiceMessage | null;
	invalidBody?: boolean;
}
type ProbeResult = { response: ProbeResponse } | { error: unknown };

const NETWORK_CHANGED_RETRY_LIMIT = 3;
const PROBE_TIMEOUT_MS = 5000;
const PRIMARY_PROBE_TIMEOUT_MS = 30000;
const TRANSPORT_FAILURE_CONFIRMATIONS = 2;

class NetworkStatus {
	private onOnline: Callback[] = [];
	private _onceOnline = new Set<Callback>();
	private onOffline: Callback[] = [];
	private timer?: number;
	private _log = curryLog("[NetworkStatus]");
	private checking?: Promise<void>;
	private generation = 0;
	private destroyed = false;
	private controllers = new Set<AbortController>();
	// requestUrl cannot be cancelled. Retain its pending request across probe
	// deadlines so a stuck Obsidian request cannot accumulate on every poll.
	private requests = new Map<Transport, Promise<ProbeResponse>>();
	private failureListeners = new Set<(failure: NetworkTransportFailure) => void>();
	private messageListeners = new Set<(message: ServiceMessage | null) => void>();
	private statusListeners = new Set<(status: ServiceStatus | undefined) => void>();
	private noteListeners = new Set<(message: ServiceMessage | null) => void>();
	private selectedNote: ServiceMessage | null = null;
	private note: ServiceMessage | null = null;
	private selectedStatus: ServiceStatus | null = null;
	private selectedSidebar: ServiceMessage | null = null;
	private sidebar: ServiceMessage | null = null;
	private validityTimer?: number;
	private observingValidity = false;
	private refreshOnResume = () => this.refreshMessages();
	private monitorConnectivity = true;
	private failingTransport: NetworkTransportFailure = null;
	private failureCount = 0;
	transportFailure: NetworkTransportFailure = null;
	status?: ServiceStatus;
	online = true;

	constructor(
		private timeProvider: TimeProvider,
		private url: string,
		private interval = 10000,
	) {}

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
		for (const controller of this.controllers) controller.abort();
		this.checking = undefined;
		this.requests.clear();
	}

	public async checkStatus(): Promise<boolean> {
		if (!this.online && !this.destroyed) await this._checkStatus();
		return this.online;
	}

	private _checkStatus(): Promise<void> {
		if (this.destroyed) return Promise.resolve();
		if (this.checking) return this.checking;
		const pending = this.runCheck(this.generation).finally(() => {
			if (this.checking === pending) this.checking = undefined;
		});
		this.checking = pending;
		return pending;
	}

	private async runCheck(generation: number): Promise<void> {
		const primary = useNativeNetworking() ? "node" : "obsidian";
		const isCurrent = () => !this.destroyed && generation === this.generation &&
			(useNativeNetworking() ? "node" : "obsidian") === primary;
		let result: ProbeResult;
		for (let attempt = 0; ; attempt++) {
			result = await this.probe(primary, true);
			if (!isCurrent()) return;
			if (!("error" in result) || attempt >= NETWORK_CHANGED_RETRY_LIMIT ||
				!String(result.error).includes("ERR_NETWORK_CHANGED")) break;
		}
		if ("response" in result) {
			if (result.response.serviceStatus !== undefined) this.selectedStatus = result.response.serviceStatus;
			if (result.response.sidebar !== undefined) this.selectedSidebar = result.response.sidebar;
			if (result.response.note !== undefined) this.selectedNote = result.response.note;
			this.refreshMessages();
			if (!this.monitorConnectivity) return;
			this.recordTransportFailure(null);
			this.setOnline(isHealthy(result.response));
			return;
		}

		if (!this.monitorConnectivity) return;
		this.setOnline(false);
		if (!isCurrent()) return;
		const alternatives: Transport[] = ["fetch"];
		if (primary === "node") alternatives.push("obsidian");
		else if (Platform.isDesktopApp) alternatives.push("node");
		const results = await Promise.all(alternatives.map(transport => this.probe(transport)));
		if (!isCurrent()) return;
		const working = alternatives.filter((_, index) => {
			const alternate = results[index];
			return "response" in alternate && isHealthy(alternate.response);
		});
		this.recordTransportFailure(working.length ? primary : null);
		if (working.length) this.log("Health probes disagree", { failed: primary, working });
	}

	private async probe(transport: Transport, primary = false): Promise<ProbeResult> {
		const controller = new AbortController();
		this.controllers.add(controller);
		const timeProvider = this.timeProvider;
		let timer: number | undefined;
		let request: Promise<ProbeResponse> | undefined;
		let timedOut = false;
		let onAbort: () => void;
		const cancelled = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("Health probe cancelled or timed out"));
			controller.signal.addEventListener("abort", onAbort, { once: true });
			// Give primary requests several poll intervals before diagnosing a stall.
			timer = timeProvider.setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, primary ? PRIMARY_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS);
		});
		try {
			request = this.requests.get(transport);
			if (!request) {
				request = this.request(transport, primary, controller.signal);
				this.requests.set(transport, request);
			}
			return { response: await Promise.race([request, cancelled]) };
		} catch (error) {
			return { error };
		} finally {
			// Obsidian cannot cancel its request. Retain it after a deadline,
			// including a response arriving between polls, until a probe consumes it.
			if ((!timedOut || transport !== "obsidian") && this.requests.get(transport) === request) {
				this.requests.delete(transport);
			}
			if (timer !== undefined) timeProvider.clearTimeout(timer);
			controller.signal.removeEventListener("abort", onAbort!);
			this.controllers.delete(controller);
		}
	}

	private async request(transport: Transport, primary: boolean, signal: AbortSignal): Promise<ProbeResponse> {
		const params = { url: this.url, method: "GET", headers: getRelayRequestHeaders(), throw: false };
		if (transport === "fetch") {
			const response = await window.fetch(this.url, {
				method: "GET", headers: params.headers, signal, cache: "no-store", credentials: "omit",
			});
			if (response.status !== 200) {
				await response.body?.cancel();
				return { status: response.status };
			}
			const body = await response.text();
			return readResponse(response.status, () => JSON.parse(body) as unknown);
		}
		const response = primary
			? await requestUrlWithMetrics({ ...params, signal, maxResponseBytes: 64 * 1024, relayNetworkDomain: "api" })
			: transport === "node"
				? await nodeRequestUrl(params, { signal, maxResponseBytes: 64 * 1024 })
				: await requestUrl(params);
		return readResponse(response.status, () => response.json as unknown);
	}

	private setOnline(online: boolean): void {
		if (this.online === online) return;
		this.online = online;
		if (online) {
			this.log("back online");
			this.onOnline.forEach(callback => callback(this.status));
			this._onceOnline.forEach(callback => callback(this.status));
			this._onceOnline.clear();
		} else this.onOffline.forEach(callback => callback(this.status));
	}

	private recordTransportFailure(transport: NetworkTransportFailure): void {
		this.failureCount = transport ? (this.failingTransport === transport ? this.failureCount + 1 : 1) : 0;
		this.failingTransport = transport;
		const failure = this.failureCount >= TRANSPORT_FAILURE_CONFIRMATIONS ? transport : null;
		if (failure === this.transportFailure) return;
		this.transportFailure = failure;
		this.failureListeners.forEach(listener => listener(failure));
	}

	public subscribeTransportFailure(listener: (failure: NetworkTransportFailure) => void): () => void {
		if (this.destroyed) return () => {};
		this.failureListeners.add(listener);
		listener(this.transportFailure);
		return () => { this.failureListeners.delete(listener); };
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
			this.statusListeners.forEach(listener => listener(status));
		}
		if (this.sidebar !== sidebar) {
			this.sidebar = sidebar;
			this.messageListeners.forEach(listener => listener(sidebar));
		}
		const note = this.selectedNote && messageIsCurrent(this.selectedNote, now) ? this.selectedNote : null;
		if (this.note !== note) {
			this.note = note;
			this.noteListeners.forEach(listener => listener(note));
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

	public subscribeServiceStatus(listener: (status: ServiceStatus | undefined) => void): () => void {
		if (this.destroyed) return () => {};
		this.refreshMessages();
		this.statusListeners.add(listener);
		listener(this.status);
		return () => { this.statusListeners.delete(listener); };
	}

	public subscribeServiceMessage(listener: (message: ServiceMessage | null) => void): () => void {
		if (this.destroyed) return () => {};
		this.refreshMessages();
		this.messageListeners.add(listener);
		listener(this.sidebar);
		return () => { this.messageListeners.delete(listener); };
	}

	public subscribeNoteMessage(listener: (message: ServiceMessage | null) => void): () => void {
		if (this.destroyed) return () => {};
		this.refreshMessages();
		this.noteListeners.add(listener);
		listener(this.note);
		return () => { this.noteListeners.delete(listener); };
	}

	public onceOnline(callback: Callback): () => void {
		this._onceOnline.add(callback);
		return () => { this._onceOnline.delete(callback); };
	}

	public addEventListener(eventType: "online" | "offline", callback: Callback): void {
		(eventType === "online" ? this.onOnline : this.onOffline).push(callback);
	}

	destroy(): void {
		this.destroyed = true;
		this.stop();
		this._onceOnline.clear();
		this.onOnline = [];
		this.onOffline = [];
		this.failureListeners.clear();
		this.messageListeners.clear();
		this.statusListeners.clear();
		this.noteListeners.clear();
		this.selectedNote = null;
		this.note = null;
		this.selectedStatus = null;
		this.selectedSidebar = null;
		this.sidebar = null;
		this.status = undefined;
		this.requests.clear();
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
			for (const key of ["id", "link", "backgroundColor", "color"] as const) {
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
