"use strict";
import { HasLogging } from "./debug";
import type { TimeProvider } from "./TimeProvider";
import type { SharedFolder } from "./SharedFolder";
import { IndexeddbPersistence } from "./storage/y-indexeddb";
import * as Y from "yjs";
import { TFile, normalizePath } from "obsidian";

interface PendingUpdate {
	sharedFolder: SharedFolder;
	guid: string;
	vpath: string;
	updates: Uint8Array[];
	enqueuedAt: number;
}

const DEBOUNCE_MS = 2000;
const MAX_CONCURRENT = 2;
const PROCESS_INTERVAL_MS = 1000;

/**
 * Manages background sync for files not currently open in the editor.
 * Queues incoming Yjs updates, debounces rapid-fire changes, and applies
 * them to disk via temporary Y.Docs loaded from IndexedDB.
 */
export class ColdSyncManager extends HasLogging {
	private queue = new Map<string, PendingUpdate>();
	private processing = new Set<string>();
	private processTimer: number | null = null;
	private destroyed = false;

	constructor(private timeProvider: TimeProvider) {
		super("ColdSyncManager");
		this.processTimer = this.timeProvider.setInterval(
			() => this.processQueue(),
			PROCESS_INTERVAL_MS,
		);
	}

	enqueueUpdate(sharedFolder: SharedFolder, guid: string, vpath: string, update: Uint8Array): void {
		const existing = this.queue.get(guid);
		if (existing) {
			existing.updates.push(update);
			existing.enqueuedAt = this.timeProvider.getTime();
		} else {
			this.queue.set(guid, { sharedFolder, guid, vpath, updates: [update], enqueuedAt: this.timeProvider.getTime() });
		}
		this.debug(`Cold sync queued for ${vpath} (${(existing?.updates.length ?? 1)} pending)`);
	}

	private async processQueue(): Promise<void> {
		if (this.queue.size === 0 || this.processing.size >= MAX_CONCURRENT) return;

		const now = this.timeProvider.getTime();
		const ready: PendingUpdate[] = [];

		for (const [guid, pending] of this.queue) {
			if (this.processing.has(guid)) continue;
			if (now - pending.enqueuedAt >= DEBOUNCE_MS) ready.push(pending);
			if (ready.length + this.processing.size >= MAX_CONCURRENT) break;
		}

		for (const pending of ready) {
			this.queue.delete(pending.guid);
			this.processing.add(pending.guid);
			this.applyUpdate(pending).catch((err) => {
				this.error(`Cold sync failed for ${pending.vpath}:`, err);
			}).finally(() => {
				this.processing.delete(pending.guid);
			});
		}
	}

	private async applyUpdate({ sharedFolder, guid, vpath, updates }: PendingUpdate): Promise<void> {
		if (this.destroyed || sharedFolder.files.has(guid)) return;

		const fullPath = normalizePath(sharedFolder.getPath(vpath));
		const abstractFile = sharedFolder.vault.getAbstractFileByPath(fullPath);
		if (!(abstractFile instanceof TFile)) return;

		const tempDoc = new Y.Doc();
		let persistence: IndexeddbPersistence | null = null;

		try {
			persistence = new IndexeddbPersistence(guid, tempDoc);
			await this.waitForSync(persistence);

			const isCanvas = vpath.endsWith(".canvas");
			const getContent = () => isCanvas ? this.canvasToJSON(tempDoc) : tempDoc.getText("contents").toString();

			const contentBefore = getContent();
			for (const update of updates) Y.applyUpdate(tempDoc, update);
			const contentAfter = getContent();

			if (contentAfter === contentBefore) return;

			// Conflict detection
			const diskContent = await sharedFolder.vault.read(abstractFile);
			if (diskContent !== contentBefore) {
				// Disk and Yjs state diverge. This means either:
				// 1. Local edits exist that haven't synced yet
				// 2. IndexedDB state was lost (empty Yjs but disk has content)
				// Both cases: skip to avoid overwriting data.
				this.warn(`Conflict for ${vpath}: disk differs from Yjs state, skipping`);
				return;
			}

			await sharedFolder.vault.adapter.write(fullPath, contentAfter);
			this.log(`Cold sync: ${vpath} (${updates.length} updates, ${contentAfter.length} chars)`);

			// Let IndexedDB persist the applied updates
			await new Promise<void>((resolve) => { this.timeProvider.setTimeout(resolve, 200); });
		} finally {
			if (persistence) await persistence.destroy();
			tempDoc.destroy();
		}
	}

	private waitForSync(persistence: IndexeddbPersistence): Promise<void> {
		if (persistence.synced) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timeout = this.timeProvider.setTimeout(
				() => reject(new Error("IndexedDB sync timeout")), 10000,
			);
			persistence.once("synced", () => {
				this.timeProvider.clearTimeout(timeout);
				resolve();
			});
		});
	}

	private canvasToJSON(ydoc: Y.Doc): string {
		const edges = [...ydoc.getMap<any>("edges").entries()].map(([, e]) => ({ ...e }));
		const nodes = [...ydoc.getMap<any>("nodes").entries()].map(([, n]) => ({
			...n, text: ydoc.getText(n.id).toString() || n.text,
		}));
		return JSON.stringify({ edges, nodes });
	}

	destroy(): void {
		this.destroyed = true;
		if (this.processTimer !== null) {
			this.timeProvider.clearInterval(this.processTimer);
			this.processTimer = null;
		}
		this.queue.clear();
		this.processing.clear();
	}
}
