"use strict";

import { TFile, type MetadataCache } from "obsidian";
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

export interface MetadataRepairResult {
	ok: boolean;
	message: string;
	replayedEntries: number;
	reindexQueued: number;
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

	/**
	 * Attempt to recover Obsidian's metadata cache after its IndexedDB
	 * connection has been force-closed. Obsidian never reopens the
	 * connection itself: its save path keeps throwing on the dead handle
	 * and a failed preload leaves the whole vault unindexed until restart.
	 *
	 * The repair opens a fresh connection to the same database, swaps a
	 * facade with the surface Obsidian uses (`transaction`, `clear`) into
	 * `metadataCache.db`, rebuilds the `transactionSave` closure against
	 * the new connection, replays the in-memory cache through Obsidian's
	 * own save methods so persisted shapes stay canonical, and queues
	 * Obsidian's per-file indexer for any file missing from the cache.
	 *
	 * Every touched internal is probed first; if Obsidian's shape has
	 * changed, the repair reports failure and the caller should fall back
	 * to recommending an app reload.
	 */
	async repair(): Promise<MetadataRepairResult> {
		const mc = this.metadataCache as any;
		const fail = (message: string): MetadataRepairResult => ({
			ok: false,
			message,
			replayedEntries: 0,
			reindexQueued: 0,
		});

		if (!mc) return fail("Metadata cache is unavailable.");
		if (this.check().status === "ok") {
			return {
				ok: true,
				message: "Metadata database is healthy; nothing to repair.",
				replayedEntries: 0,
				reindexQueued: 0,
			};
		}

		const oldDb = mc.db;
		const dbName = typeof oldDb?.name === "string" ? oldDb.name : null;
		if (!dbName) return fail("Could not determine the metadata database name.");
		if (
			typeof mc.saveFileCache !== "function" ||
			typeof mc.saveMetaCache !== "function" ||
			typeof mc.transactionSave !== "function"
		) {
			return fail(
				"Obsidian's metadata cache internals look different than expected; reload the app instead.",
			);
		}

		try {
			oldDb.close?.();
		} catch {
			// The dead handle may refuse even close(); nothing depends on it.
		}

		let raw: IDBDatabase;
		try {
			raw = await openExistingDatabase(dbName);
		} catch (error) {
			return fail(`Could not reopen the metadata database: ${formatError(error)}`);
		}

		const stores = Array.from(raw.objectStoreNames ?? []);
		if (!stores.includes("file") || !stores.includes("metadata")) {
			raw.close();
			return fail(
				"The metadata database is missing its expected stores; reload the app instead.",
			);
		}

		// If this connection dies too, surface the banner again right away.
		raw.addEventListener("close", () => {
			this.check();
		});

		const facade = {
			get name() {
				return raw.name;
			},
			get version() {
				return raw.version;
			},
			get objectStoreNames() {
				return raw.objectStoreNames;
			},
			transaction(
				names: string | string[],
				mode?: IDBTransactionMode,
				options?: IDBTransactionOptions,
			) {
				return raw.transaction(names, mode, options);
			},
			// Obsidian's clear() awaits the idb-library promise helper.
			clear(storeName: string) {
				return new Promise<void>((resolve, reject) => {
					const tx = raw.transaction(storeName, "readwrite");
					tx.objectStore(storeName).clear();
					tx.oncomplete = () => resolve();
					tx.onerror = () => reject(tx.error);
					tx.onabort = () => reject(tx.error);
				});
			},
			close() {
				raw.close();
			},
		};

		mc.db = facade;
		mc.transactionSave = createTransactionSave(facade, ["file", "metadata"]);

		// Replay in-memory state through Obsidian's own save methods so the
		// persisted record shapes (frontmatter position renames, key pruning)
		// stay canonical. Entries written while the connection was dead were
		// lost from disk; the in-memory copies are authoritative.
		let replayedEntries = 0;
		const fileCache = mc.fileCache ?? {};
		const metadataCache = mc.metadataCache ?? {};
		try {
			for (const [path, info] of Object.entries(fileCache)) {
				mc.saveFileCache(path, info);
				replayedEntries++;
			}
			for (const [hash, meta] of Object.entries(metadataCache)) {
				mc.saveMetaCache(hash, meta);
				replayedEntries++;
			}
		} catch (error) {
			return fail(`Repair failed while replaying cache entries: ${formatError(error)}`);
		}

		// A preload that failed at boot leaves files unindexed. Queue
		// Obsidian's own indexer for anything the cache doesn't cover.
		let reindexQueued = 0;
		const vault = mc.vault;
		if (typeof mc.computeFileMetadataAsync === "function" && vault?.getAllLoadedFiles) {
			for (const file of vault.getAllLoadedFiles()) {
				if (file instanceof TFile && !fileCache[file.path]) {
					mc.computeFileMetadataAsync(file);
					reindexQueued++;
				}
			}
		}

		const after = this.check();
		if (after.status !== "ok") {
			return fail(
				"The database connection was replaced but is still unhealthy; reload the app instead.",
			);
		}

		this.log(
			`repaired metadata database ${dbName}: replayed ${replayedEntries} entries, queued ${reindexQueued} files for reindex`,
		);
		return {
			ok: true,
			message: "Metadata database repaired.",
			replayedEntries,
			reindexQueued,
		};
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

/**
 * Open an existing IndexedDB database at its current version. An
 * `upgradeneeded` event means the database did not exist (the open
 * auto-created it), which is not a state the repair should proceed from.
 */
function openExistingDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(name);
		let created = false;
		req.onupgradeneeded = () => {
			created = true;
		};
		req.onblocked = () => reject(new Error("open blocked by another connection"));
		req.onerror = () => reject(req.error ?? new Error("open failed"));
		req.onsuccess = () => {
			const db = req.result;
			if (created) {
				db.close();
				indexedDB.deleteDatabase(name);
				reject(new Error("database did not exist"));
				return;
			}
			resolve(db);
		};
	});
}

/**
 * Rebuild Obsidian's `transactionSave` closure against a live connection.
 * Mirrors the upstream behavior: reuse one relaxed-durability readwrite
 * transaction across a microtask, falling back to a fresh transaction when
 * the cached one has already committed.
 */
function createTransactionSave(
	db: { transaction(names: string[], mode: IDBTransactionMode, options?: IDBTransactionOptions): IDBTransaction },
	storeNames: string[],
): (storeName: string, key: string, value?: unknown) => IDBRequest {
	let cached: IDBTransaction | null = null;
	return (storeName: string, key: string, value?: unknown) => {
		if (cached) {
			try {
				const store = cached.objectStore(storeName);
				return value ? store.put(value, key) : store.delete(key);
			} catch {
				// Cached transaction already committed; fall through.
			}
		}
		const tx = (cached = db.transaction(storeNames, "readwrite", {
			durability: "relaxed",
		}));
		queueMicrotask(() => {
			if (cached === tx) cached = null;
		});
		const store = cached.objectStore(storeName);
		return value ? store.put(value, key) : store.delete(key);
	};
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
