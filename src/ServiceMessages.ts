import { LocalStorage } from "./LocalStorage";
import { curryLog } from "./debug";

export interface MessageValidity {
	validFrom?: string;
	validUntil?: string;
}

export type ServiceMessageAction =
	| { type: "settings"; label: string; path: string }
	| { type: "link"; label: string; url: string }
	| { type: "markdown"; label: string; markdown: string; url?: never }
	| { type: "markdown"; label: string; url: string; markdown?: never };

export function httpUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
	} catch { return undefined; }
}

export function readMessageActions(value: unknown): ServiceMessageAction[] {
	if (!Array.isArray(value)) return [];
	const actions: ServiceMessageAction[] = [];
	for (const action of value) {
		if (!action || typeof action !== "object" || typeof action.label !== "string" || !action.label.trim()) continue;
		const label: string = action.label;
		if (action.type === "settings") {
			const path: unknown = action.path ?? "/";
			if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) actions.push({ type: "settings", label, path });
		} else if (action.type === "link") {
			const url = httpUrl(action.url);
			if (url) actions.push({ type: "link", label, url });
		} else if (action.type === "markdown") {
			if (typeof action.markdown === "string" && action.markdown.trim() && action.url === undefined) {
				actions.push({ type: "markdown", label, markdown: action.markdown });
			} else if (action.markdown === undefined) {
				const url = httpUrl(action.url);
				if (url?.startsWith("https:")) actions.push({ type: "markdown", label, url });
			}
		}
	}
	return actions;
}

/** A health-response announcement. Changing its ID makes it visible after dismissal. */
export interface ServiceMessage extends MessageValidity {
	id: string;
	title: string;
	message: string;
	link?: string;
	backgroundColor?: string;
	color?: string;
	actions?: readonly ServiceMessageAction[];
}

export function readMessageValidity(value: Record<string, unknown>): MessageValidity | undefined {
	const result: MessageValidity = {};
	for (const key of ["validFrom", "validUntil"] as const) {
		if (!(key in value)) continue;
		const bound = value[key];
		if (typeof bound !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(bound)) return undefined;
		const ms = Date.parse(bound);
		if (!Number.isFinite(ms) || new Date(ms).toISOString() !== (bound.includes(".") ? bound : bound.replace("Z", ".000Z"))) return undefined;
		result[key] = bound;
	}
	if (result.validFrom && result.validUntil && Date.parse(result.validFrom) >= Date.parse(result.validUntil)) return undefined;
	return result;
}

export function messageIsCurrent(message: MessageValidity, now: number): boolean {
	return (!message.validFrom || Date.parse(message.validFrom) <= now) &&
		(!message.validUntil || now < Date.parse(message.validUntil));
}

export function readServiceMessage(value: unknown): ServiceMessage | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	const { id, title, message, link } = entry;
	if (typeof id !== "string" || !id.trim() || typeof title !== "string" || !title.trim() ||
		typeof message !== "string" || !message.trim()) return undefined;
	const validity = readMessageValidity(entry);
	if (!validity) return undefined;
	const safeLink = httpUrl(link);
	const actions = readMessageActions(entry.actions);
	const colors: Pick<ServiceMessage, "backgroundColor" | "color"> = {};
	for (const key of ["backgroundColor", "color"] as const) {
		const value = entry[key];
		if (typeof value === "string") colors[key] = value;
	}
	return { id, title, message, ...validity, ...colors, ...(safeLink ? { link: safeLink } : {}), ...(actions.length ? { actions } : {}) };
}

/** Vault-local dismissals, scoped to the service rather than its version query. */
export class ServiceMessages {
	private dismissed: LocalStorage<boolean>;
	private sessionDismissals = new Set<string>();
	private message: ServiceMessage | null = null;
	private listeners = new Set<(message: ServiceMessage | null) => void>();
	private log = curryLog("[ServiceMessages]");

	constructor(appId: string, pluginId: string, serviceUrl: string) {
		const url = new URL(serviceUrl);
		const service = encodeURIComponent(url.origin + url.pathname);
		this.dismissed = new LocalStorage<boolean>(`${appId}-${pluginId}/serviceMessages/${service}`);
	}

	update(message: ServiceMessage | null): void {
		this.message = message;
		this.notify();
	}

	dismiss(id: string): void {
		if (this.message?.id !== id) return;
		this.sessionDismissals.add(id);
		try {
			this.dismissed.set(id, true);
		} catch (error) {
			this.log("Unable to persist announcement dismissal", error);
		}
		this.notify();
	}

	subscribe(listener: (message: ServiceMessage | null) => void): () => void {
		this.listeners.add(listener);
		listener(this.visible());
		return () => { this.listeners.delete(listener); };
	}

	private visible(): ServiceMessage | null {
		const message = this.message;
		return message && !this.sessionDismissals.has(message.id) && !this.dismissed.has(message.id) ? message : null;
	}

	private notify(): void {
		const visible = this.visible();
		this.listeners.forEach(listener => listener(visible));
	}
}
