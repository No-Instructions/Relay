import { requestUrl } from "obsidian";
import { curryLog } from "./debug";
import type { TimeProvider } from "./TimeProvider";
import { getRelayRequestHeaders, requestUrlWithMetrics } from "./customFetch";
import { nodeRequestUrl, useNativeNetworking } from "./NodeHttp";

interface ServiceStatus {
	status: string;
	versions?: { stable: string; beta: string };
	backgroundColor?: string;
	color?: string;
	link?: string;
}

type Callback = (status?: ServiceStatus) => void;
type Transport = "obsidian" | "fetch" | "node";
export type NetworkTransportFailure = "obsidian" | "node" | null;
interface ProbeResponse {
	status: number;
	serviceStatus?: ServiceStatus;
	invalidBody?: boolean;
}
type ProbeResult = { response: ProbeResponse } | { error: unknown };

interface PendingProbe {
	sequence: number;
	result?: ProbeResult;
	timedOut: boolean;
	listeners: Set<(result: ProbeResult) => void>;
}

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
	// Keep at most two uncancellable Obsidian requests, leaving room to
	// recover through a fresh connection after the first request stalls.
	private requests = new Map<Transport, PendingProbe[]>();
	private requestSequence = 0;
	private latestVerdict = new Map<Transport, number>();
	private failureListeners = new Set<(failure: NetworkTransportFailure) => void>();
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

	public start(): void {
		if (this.destroyed || this.timer !== undefined) return;
		this.timer = this.timeProvider.setInterval(() => { void this._checkStatus(); }, this.interval);
	}

	public stop(): void {
		if (this.timer !== undefined) this.timeProvider.clearInterval(this.timer);
		this.timer = undefined;
		this.generation++;
		for (const controller of this.controllers) controller.abort();
		this.checking = undefined;
		this.requests.clear();
		this.latestVerdict.clear();
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
			this.recordTransportFailure(null);
			if (result.response.serviceStatus) this.status = result.response.serviceStatus;
			this.setOnline(isHealthy(result.response));
			return;
		}

		this.setOnline(false);
		if (!isCurrent()) return;
		const alternatives: Transport[] = ["fetch"];
		if (primary === "node") alternatives.push("obsidian");
		const results = await Promise.all(alternatives.map(transport => this.probe(transport)));
		if (!isCurrent()) return;
		const working = alternatives.filter((_, index) => {
			const alternate = results[index];
			return "response" in alternate && isHealthy(alternate.response);
		});
		const confirmed = primary === "obsidian" ? working.includes("fetch") : working.length > 0;
		this.recordTransportFailure(confirmed ? primary : null);
		if (working.length) this.log("Health probes disagree", { failed: primary, working });
	}

	private async probe(transport: Transport, primary = false): Promise<ProbeResult> {
		const controller = new AbortController();
		this.controllers.add(controller);
		let pool = this.requests.get(transport);
		if (!pool) {
			pool = [];
			this.requests.set(transport, pool);
		}
		// Consume a late result before opening another connection. Once all
		// pending requests have timed out, allow one fresh request up to the cap.
		if (!pool.some(probe => probe.result || !probe.timedOut) &&
			pool.length < (transport === "obsidian" ? 2 : 1)) {
			const probe: PendingProbe = { sequence: ++this.requestSequence, timedOut: false, listeners: new Set() };
			pool.push(probe);
			const settle = (result: ProbeResult) => {
				// A deadline already counted this failure. A later rejection
				// must not replay it, and no old result may undo a newer verdict.
				if ((probe.timedOut && "error" in result) ||
					probe.sequence < (this.latestVerdict.get(transport) ?? 0)) {
					const index = pool.indexOf(probe);
					if (index >= 0) pool.splice(index, 1);
					probe.listeners.clear();
					return;
				}
				probe.result = result;
				probe.listeners.forEach(listener => listener(result));
				probe.listeners.clear();
			};
			void this.request(transport, primary, controller.signal).then(
				response => settle({ response }), error => settle({ error }),
			);
		}
		let timedOut = false;
		let onAbort!: () => void;
		const cancelled = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("Health probe cancelled or timed out"));
			controller.signal.addEventListener("abort", onAbort, { once: true });
		});
		const timer = this.timeProvider.setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, primary ? PRIMARY_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS);
		const unsubscribe: (() => void)[] = [];
		try {
			const observations = [...pool].reverse().map(probe => new Promise<{ probe: PendingProbe; result: ProbeResult }>(resolve => {
				const receive = (result: ProbeResult) => resolve({ probe, result });
				if (probe.result) receive(probe.result);
				else {
					probe.listeners.add(receive);
					unsubscribe.push(() => probe.listeners.delete(receive));
				}
			}));
			let { probe, result } = await Promise.race([...observations, cancelled]);
			// More than one request can settle before this continuation runs.
			for (const candidate of pool) {
				if (candidate.result && candidate.sequence > probe.sequence) {
					probe = candidate;
					result = candidate.result;
				}
			}
			pool.splice(pool.indexOf(probe), 1);
			if (this.requests.get(transport) === pool) {
				this.latestVerdict.set(transport, probe.sequence);
				// Pending old requests still occupy a slot until they settle.
				for (let index = pool.length - 1; index >= 0; index--) {
					if (pool[index].result && pool[index].sequence < probe.sequence) pool.splice(index, 1);
				}
			}
			return result;
		} catch (error) {
			return { error };
		} finally {
			unsubscribe.forEach(remove => remove());
			if (timedOut) pool.forEach(probe => { probe.timedOut = true; });
			if (transport !== "obsidian" || !pool.length) {
				if (this.requests.get(transport) === pool) this.requests.delete(transport);
			}
			this.timeProvider.clearTimeout(timer);
			controller.signal.removeEventListener("abort", onAbort);
			this.controllers.delete(controller);
		}
	}

	private async request(transport: Transport, primary: boolean, signal: AbortSignal): Promise<ProbeResponse> {
		const params = { url: this.url, method: "GET", headers: getRelayRequestHeaders(), throw: false };
		if (transport === "fetch") {
			const response = await window.fetch(this.url, {
				method: "GET", signal, cache: "no-store", credentials: "omit",
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

	private recordTransportFailure(transport: NetworkTransportFailure): void {
		this.failureCount = transport ? (this.failingTransport === transport ? this.failureCount + 1 : 1) : 0;
		this.failingTransport = transport;
		const failure = this.failureCount >= TRANSPORT_FAILURE_CONFIRMATIONS ? transport : null;
		if (failure === this.transportFailure) return;
		this.transportFailure = failure;
		this.failureListeners.forEach(listener => this.notify(listener, failure));
	}

	public subscribeTransportFailure(listener: (failure: NetworkTransportFailure) => void): () => void {
		if (this.destroyed) return () => {};
		this.failureListeners.add(listener);
		this.notify(listener, this.transportFailure);
		return () => { this.failureListeners.delete(listener); };
	}

	public onceOnline(callback: Callback): void { this._onceOnline.add(callback); }

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
		this.requests.clear();
	}
}

function isHealthy(response: ProbeResponse): boolean {
	return response.status === 200 && !response.invalidBody;
}

function readResponse(status: number, readBody: () => unknown): ProbeResponse {
	if (status !== 200) return { status };
	try {
		const body = readBody();
		const serviceStatus = body && typeof body === "object" && "status" in body && typeof body.status === "string"
			? body as ServiceStatus : undefined;
		return { status, serviceStatus };
	} catch {
		return { status, invalidBody: true };
	}
}

export default NetworkStatus;
