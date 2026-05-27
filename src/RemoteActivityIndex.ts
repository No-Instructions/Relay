"use strict";

export interface RemoteActivityEntry {
	guid: string;
	timestamp: number;
	userId?: string;
}

export const REMOTE_ACTIVITY_MAX_ENTRIES = 100;
export const REMOTE_ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const FUTURE_SKEW_MS = 60 * 1000;
const SECONDS_THRESHOLD = 10_000_000_000;

export class RemoteActivityIndex {
	private readonly byGuid = new Map<string, RemoteActivityEntry>();
	private readonly ordered: RemoteActivityEntry[] = [];

	constructor(
		private readonly capacity: number = REMOTE_ACTIVITY_MAX_ENTRIES,
	) {}

	upsert(entry: RemoteActivityEntry): boolean {
		if (!entry.guid || !Number.isFinite(entry.timestamp) || entry.timestamp <= 0) {
			return false;
		}

		const existing = this.byGuid.get(entry.guid);
		if (existing && entry.timestamp < existing.timestamp) {
			return false;
		}

		const next: RemoteActivityEntry = {
			guid: entry.guid,
			timestamp: entry.timestamp,
			userId: entry.userId ?? existing?.userId,
		};

		if (
			existing &&
			existing.timestamp === next.timestamp &&
			existing.userId === next.userId
		) {
			return false;
		}

		if (existing) {
			this.removeFromOrdered(entry.guid);
		}

		this.byGuid.set(entry.guid, next);
		this.insertOrdered(next);
		this.trim();
		return true;
	}

	get(guid: string): RemoteActivityEntry | undefined {
		const entry = this.byGuid.get(guid);
		return entry ? { ...entry } : undefined;
	}

	remove(guid: string): boolean {
		if (!this.byGuid.delete(guid)) {
			return false;
		}
		this.removeFromOrdered(guid);
		return true;
	}

	entries(limit: number = this.capacity): RemoteActivityEntry[] {
		return this.ordered.slice(0, limit).map((entry) => ({ ...entry }));
	}

	serialize(): RemoteActivityEntry[] {
		return this.entries(this.capacity);
	}

	hydrate(entries: readonly RemoteActivityEntry[]): void {
		this.byGuid.clear();
		this.ordered.length = 0;
		for (const entry of entries) {
			this.upsert(entry);
		}
	}

	pruneOlderThan(cutoff: number): boolean {
		let changed = false;
		for (let index = this.ordered.length - 1; index >= 0; index--) {
			const entry = this.ordered[index];
			if (entry.timestamp >= cutoff) {
				break;
			}
			this.byGuid.delete(entry.guid);
			this.ordered.pop();
			changed = true;
		}
		return changed;
	}

	private insertOrdered(entry: RemoteActivityEntry): void {
		let low = 0;
		let high = this.ordered.length;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			if (compareNewestFirst(entry, this.ordered[mid]) < 0) {
				high = mid;
			} else {
				low = mid + 1;
			}
		}
		this.ordered.splice(low, 0, entry);
	}

	private removeFromOrdered(guid: string): void {
		const index = this.ordered.findIndex((entry) => entry.guid === guid);
		if (index >= 0) {
			this.ordered.splice(index, 1);
		}
	}

	private trim(): void {
		while (this.ordered.length > this.capacity) {
			const removed = this.ordered.pop();
			if (removed) {
				this.byGuid.delete(removed.guid);
			}
		}
	}
}

export function normalizeRemoteActivityTimestamp(
	timestamp: unknown,
	now: number,
): number | null {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
		return null;
	}

	const millis = timestamp < SECONDS_THRESHOLD ? timestamp * 1000 : timestamp;
	if (millis > now + FUTURE_SKEW_MS) {
		return null;
	}
	return millis;
}

function compareNewestFirst(
	a: RemoteActivityEntry,
	b: RemoteActivityEntry,
): number {
	if (a.timestamp !== b.timestamp) {
		return b.timestamp - a.timestamp;
	}
	return a.guid.localeCompare(b.guid);
}
