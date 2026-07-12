"use strict";

import type { MetadataCache } from "obsidian";
import { Observable } from "./observable/Observable";
import type { TimeProvider } from "./TimeProvider";

export type MetadataHealthStatus = "ok" | "metadata-db-locked";

export interface MetadataHealthState {
	status: MetadataHealthStatus;
	message: string | null;
	details: string | null;
	databaseName: string | null;
	checkedAt: number | null;
}

const OK_STATE: MetadataHealthState = {
	status: "ok",
	message: null,
	details: null,
	databaseName: null,
	checkedAt: null,
};

export class MetadataHealth extends Observable<MetadataHealth> {
	state: MetadataHealthState = OK_STATE;
	private intervalId: number | null = null;

	constructor(
		private metadataCache: MetadataCache | undefined,
		private timeProvider: TimeProvider,
		private intervalMs = 30_000,
	) {
		super("MetadataHealth");
	}

	start(): void {
		if (this.intervalId !== null) return;
		this.check();
		this.intervalId = this.timeProvider.setInterval(() => this.check(), this.intervalMs);
	}

	check(): MetadataHealthState {
		const next = this.inspect();
		const changed = !sameHealthState(this.state, next);
		this.state = next;
		if (changed) {
			this.notifyListeners();
		}
		return this.state;
	}

	destroy(): void {
		if (this.intervalId !== null) {
			this.timeProvider.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.metadataCache = undefined;
		super.destroy();
	}

	private inspect(): MetadataHealthState {
		const checkedAt = this.timeProvider.now();
		const db = (this.metadataCache as any)?.db;
		if (!db || typeof db.transaction !== "function") {
			return { ...OK_STATE, checkedAt };
		}

		const databaseName = typeof db.name === "string" ? db.name : null;
		const storeName = getProbeStoreName(db);
		if (!storeName) {
			return { ...OK_STATE, databaseName, checkedAt };
		}

		try {
			const tx = db.transaction(storeName, "readonly");
			tx.objectStore(storeName);
			return { ...OK_STATE, databaseName, checkedAt };
		} catch (error) {
			return {
				status: "metadata-db-locked",
				message: "Obsidian metadata database is locked. Restart Obsidian.",
				details: formatError(error),
				databaseName,
				checkedAt,
			};
		}
	}
}

function getProbeStoreName(db: IDBDatabase): string | null {
	const storeNames = Array.from(db.objectStoreNames ?? []);
	return storeNames.includes("file") ? "file" : storeNames[0] ?? null;
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`;
	}
	return String(error);
}

function sameHealthState(
	a: MetadataHealthState,
	b: MetadataHealthState,
): boolean {
	return (
		a.status === b.status &&
		a.message === b.message &&
		a.details === b.details &&
		a.databaseName === b.databaseName
	);
}
