import { LocalStorage } from "./LocalStorage";
import { curryLog } from "./debug";

/** A health-response announcement. Changing its ID makes it visible after dismissal. */
export interface ServiceMessage {
	id: string;
	title: string;
	message: string;
	link?: string;
}

export function readServiceMessages(value: unknown): ServiceMessage[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const messages: ServiceMessage[] = [];
	const ids = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const { id, title, message, link } = entry as Record<string, unknown>;
		if (typeof id !== "string" || !id.trim() || ids.has(id) ||
			typeof title !== "string" || !title.trim() ||
			typeof message !== "string" || !message.trim()) continue;
		let safeLink: string | undefined;
		if (typeof link === "string") {
			try {
				const url = new URL(link);
				if (url.protocol === "https:" || url.protocol === "http:") safeLink = url.href;
			} catch { /* An invalid link does not hide the announcement. */ }
		}
		messages.push({ id, title, message, ...(safeLink ? { link: safeLink } : {}) });
		ids.add(id);
	}
	return messages;
}

/** Vault-local dismissals, scoped to the service rather than its version query. */
export class ServiceMessages {
	private dismissed: LocalStorage<boolean>;
	private sessionDismissals = new Set<string>();
	private messages: readonly ServiceMessage[] = [];
	private listeners = new Set<(messages: readonly ServiceMessage[]) => void>();
	private log = curryLog("[ServiceMessages]");

	constructor(appId: string, pluginId: string, serviceUrl: string) {
		const url = new URL(serviceUrl);
		const service = encodeURIComponent(url.origin + url.pathname);
		this.dismissed = new LocalStorage<boolean>(`${appId}-${pluginId}/serviceMessages/${service}`);
	}

	update(messages: readonly ServiceMessage[]): void {
		this.messages = messages;
		this.notify();
	}

	dismiss(id: string): void {
		if (!this.messages.some(message => message.id === id)) return;
		this.sessionDismissals.add(id);
		try {
			this.dismissed.set(id, true);
		} catch (error) {
			this.log("Unable to persist announcement dismissal", error);
		}
		this.notify();
	}

	subscribe(listener: (messages: readonly ServiceMessage[]) => void): () => void {
		this.listeners.add(listener);
		listener(this.visible());
		return () => { this.listeners.delete(listener); };
	}

	private visible(): readonly ServiceMessage[] {
		return this.messages.filter(message =>
			!this.sessionDismissals.has(message.id) && !this.dismissed.has(message.id));
	}

	private notify(): void {
		const visible = this.visible();
		this.listeners.forEach(listener => listener(visible));
	}
}
