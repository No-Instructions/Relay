import { LocalStorage } from "./LocalStorage";
import { curryLog } from "./debug";
import type { TimeProvider } from "./TimeProvider";

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

type ServiceMessageSurface = "sidebar" | "note";
export type ServiceMessageSelection = Record<ServiceMessageSurface, ServiceMessage | null>;
interface Dismissal { expiresAt: string }
const DISMISSAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Vault-local dismissals, shared by message ID across surfaces and plugin versions. */
export class ServiceMessages {
	private dismissed: LocalStorage<Dismissal>;
	private deadlines = new Map<string, number>();
	private messages: ServiceMessageSelection = { sidebar: null, note: null };
	private timer?: number;
	private destroyed = false;
	private listeners = {
		sidebar: new Set<(message: ServiceMessage | null) => void>(),
		note: new Set<(message: ServiceMessage | null) => void>(),
	};
	private log = curryLog("[ServiceMessages]");

	constructor(appId: string, pluginId: string, private time: Pick<TimeProvider, "now" | "setTimeout" | "clearTimeout">) {
		this.dismissed = new LocalStorage<Dismissal>(`${appId}-${pluginId}/serviceMessages`);
		const now = time.now();
		for (const id of this.dismissed.keys()) {
			try {
				const record: unknown = this.dismissed.get(id);
				// Boolean records carry no date; give them a bounded retention window.
				if (record === true) {
					this.persist(id, now + DISMISSAL_RETENTION_MS);
					continue;
				}
				const expiresAt = record && typeof record === "object" && "expiresAt" in record ? record.expiresAt : undefined;
				const validity = readMessageValidity({ validUntil: expiresAt });
				if (validity?.validUntil && Date.parse(validity.validUntil) > now) {
					this.deadlines.set(id, Date.parse(validity.validUntil));
					continue;
				}
			} catch (error) {
				this.log("Unable to read announcement dismissal", error);
			}
			this.remove(id);
		}
		this.schedule();
	}

	update(message: ServiceMessage | null, surface: ServiceMessageSurface = "sidebar"): void {
		this.updateSelection({ ...this.messages, [surface]: message });
	}

	/** Apply both surfaces together so shared IDs use the complete server-selected expiry. */
	updateSelection(messages: ServiceMessageSelection): void {
		if (this.destroyed) return;
		// An extension received after expiry must not resurrect a forgotten dismissal.
		this.prune();
		this.messages = { ...messages };
		for (const id of this.deadlines.keys()) {
			if (Object.values(messages).some(message => message?.id === id)) this.persist(id, this.expiry(id));
		}
		this.refresh();
	}

	dismiss(id: string): void {
		if (this.destroyed || !Object.values(this.messages).some(message => message?.id === id && messageIsCurrent(message, this.time.now()))) return;
		this.prune();
		this.persist(id, this.expiry(id));
		this.refresh();
	}

	private expiry(id: string): number {
		const fallback = this.deadlines.get(id) ?? this.time.now() + DISMISSAL_RETENTION_MS;
		return Math.max(...Object.values(this.messages)
			.filter((message): message is ServiceMessage => message?.id === id)
			.map(message => message.validUntil ? Date.parse(message.validUntil) : fallback));
	}

	private persist(id: string, deadline: number): void {
		if (this.deadlines.get(id) === deadline) return;
		this.deadlines.set(id, deadline);
		try {
			this.dismissed.set(id, { expiresAt: new Date(deadline).toISOString() });
		} catch (error) {
			this.log("Unable to persist announcement dismissal", error);
		}
	}

	private remove(id: string): void {
		this.deadlines.delete(id);
		try {
			this.dismissed.delete(id);
		} catch (error) {
			this.log("Unable to delete announcement dismissal", error);
		}
	}

	private prune(): void {
		const now = this.time.now();
		for (const [id, deadline] of this.deadlines) if (deadline <= now) this.remove(id);
	}

	private refresh(): void {
		this.prune();
		this.schedule();
		for (const surface of ["sidebar", "note"] as const) {
			const visible = this.visible(surface);
			this.listeners[surface].forEach(listener => this.notify(listener, visible));
		}
	}

	private schedule(): void {
		if (this.timer !== undefined) this.time.clearTimeout(this.timer);
		this.timer = undefined;
		const now = this.time.now();
		const boundaries = Object.values(this.messages).flatMap(message =>
			message ? [message.validFrom, message.validUntil].filter((bound): bound is string => !!bound).map(Date.parse) : []);
		let next = Infinity;
		for (const boundary of [...this.deadlines.values(), ...boundaries]) if (boundary > now) next = Math.min(next, boundary);
		if (Number.isFinite(next)) this.timer = this.time.setTimeout(() => {
			this.timer = undefined;
			this.refresh();
		}, Math.min(next - now, 2_147_483_647));
	}

	subscribe(listener: (message: ServiceMessage | null) => void, surface: ServiceMessageSurface = "sidebar"): () => void {
		if (this.destroyed) return () => {};
		this.listeners[surface].add(listener);
		this.notify(listener, this.visible(surface));
		return () => { this.listeners[surface].delete(listener); };
	}

	private visible(surface: ServiceMessageSurface): ServiceMessage | null {
		const message = this.messages[surface];
		return message && messageIsCurrent(message, this.time.now()) && (this.deadlines.get(message.id) ?? 0) <= this.time.now() ? message : null;
	}

	private notify(listener: (message: ServiceMessage | null) => void, message: ServiceMessage | null): void {
		try { listener(message); }
		catch (error) { this.log("Announcement listener failed", error); }
	}

	destroy(): void {
		this.destroyed = true;
		if (this.timer !== undefined) this.time.clearTimeout(this.timer);
		this.timer = undefined;
		this.listeners.sidebar.clear();
		this.listeners.note.clear();
		this.messages = { sidebar: null, note: null };
		this.deadlines.clear();
	}
}
