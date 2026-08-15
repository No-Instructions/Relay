"use strict";

/**
 * The localDoc↔remoteDoc conduit for a shared folder's membership maps.
 *
 * Two documents, not one: `localDoc` is the vault-facing realm (our claims,
 * our identity), `remoteDoc` is the server's realm (the provider attaches to
 * it), and this bridge is the only crossing. Because the realms are distinct
 * objects, realm reads are structural — asking which realm is asking a
 * different document — and snapshotting the server's view never needs to
 * subtract un-flushed local ops.
 *
 * Outbound is an entry queue. Unheld traffic flows as soon as the host
 * permits it; entries whose keys are held (an undecided claim, a gated
 * deletion) stay queued, so an un-flushed claim is un-sendable by
 * structure. Entries flush in capture order under one discipline: every
 * insert-bearing local transaction ships eventually, because one client's
 * items carry sequential clocks and a permanently skipped insert leaves
 * every later ship with an integration gap the remote can never fill. A
 * claim the server decided against therefore never ships as itself: its
 * never-seen items are rewritten in place to the committed value (or
 * scrubbed empty on abandonment) and the queued bytes swapped
 * (`replaceOutboundUpdate`), so the clocks contiguity owes cross carrying
 * nothing private. Only deletion-only entries (delete-set ranges, no
 * clock of their own) may be discarded outright, which is what the
 * deletion gate's restore does. A held insert-bearing entry blocks the
 * queue behind it; a held deletion-only entry blocks nothing.
 *
 * Inbound needs no queue: remote updates are never held per-key, so the
 * crossing is a state reconcile — apply to localDoc whatever remoteDoc
 * holds beyond it. A key whose local deletion is held stays diverged by
 * CRDT structure (the local tombstone covers an item the remote still holds
 * live; the reconcile re-sends neither), which is the durable form of the
 * hold. A peer's re-assertion of the key inserts a fresh item the local
 * tombstone does not cover, so it lands — a held deletion can never defeat
 * work a peer did after it.
 *
 * No Obsidian or logging dependencies; the module tests as a value against
 * real Y.Docs.
 */

import * as Y from "yjs";

/** Origin of staged claim writes into localDoc's membership maps. */
export const FOLDER_CLAIM_ORIGIN = Symbol.for("relay:folder-claim");

/** Origin of local membership deletions staged for the deletion gate. */
export const FOLDER_LOCAL_DELETE_ORIGIN = Symbol.for(
	"relay:folder-local-delete",
);

/** Origin the bridge applies inbound remote updates to localDoc under. */
export const FOLDER_BRIDGE_INBOUND_ORIGIN = Symbol.for(
	"relay:folder-bridge-inbound",
);

/** Origin the bridge applies outbound flushes to remoteDoc under. */
export const FOLDER_BRIDGE_OUTBOUND_ORIGIN = Symbol.for(
	"relay:folder-bridge-outbound",
);

/** Origin of the bridge's own value-convergence echo writes on localDoc. */
export const FOLDER_BRIDGE_ECHO_ORIGIN = Symbol.for(
	"relay:folder-bridge-echo",
);

interface OutboundEntry {
	update: Uint8Array;
	/** Map keys this transaction changed (its hold tags). */
	paths: Set<string>;
	/** Whether the transaction created items (advanced an insert clock). */
	hasInsertions: boolean;
}

export interface FolderCaptureBridgeOptions {
	localDoc: Y.Doc;
	remoteDoc: Y.Doc;
	/** Membership map names bridged between the documents. */
	scope: string[];
	/** Keys whose outbound entries are held (undecided claims and gated
	 * deletions). Read at each flush, never cached. */
	heldPaths: () => Set<string>;
	/** Remote updates may reach localDoc (the bootstrap bridge permission). */
	mayFlushInbound: () => boolean;
	/** Local updates may reach remoteDoc (publication permission and write
	 * scope, gated together). */
	mayFlushOutbound: () => boolean;
	/** Origins whose localDoc transactions never enter the outbound queue
	 * (the persistence instance replaying its own store — historical ops the
	 * flush safety net re-derives when anything unshipped remains). */
	outboundExcludedOrigins?: () => ReadonlySet<unknown>;
	/**
	 * Remote traffic is about to cross into localDoc. The host withdraws
	 * losing claims here, synchronously, before the update applies: a
	 * winner's entry integrated while a claim's item still occupies the
	 * key is tombstoned on arrival by map conflict resolution, and no
	 * later withdrawal can resurrect it. Cancel first, apply second — the
	 * order is what makes the cancel a clean convergence.
	 */
	beforeInbound?: () => void;
	/**
	 * Remote traffic crossed into localDoc. The local map's own observer
	 * cannot stand in for this: an inbound entry shadowed by a local
	 * claim's item never surfaces as a visible map change, and the claim
	 * reconciliation must still see it.
	 */
	onInbound?: () => void;
}

export class FolderCaptureBridge {
	private outbound: OutboundEntry[] = [];
	private flushScheduled = false;
	private isDestroyed = false;
	private localHandler:
		| ((update: Uint8Array, origin: unknown, doc: Y.Doc, tr: Y.Transaction) => void)
		| null = null;
	private remoteHandler:
		| ((update: Uint8Array, origin: unknown) => void)
		| null = null;

	constructor(private readonly opts: FolderCaptureBridgeOptions) {}

	/** Attach the update listeners and run the initial inbound reconcile. */
	start(): void {
		if (!this.localHandler) {
			this.localHandler = (update, origin, _doc, tr) => {
				if (origin === FOLDER_BRIDGE_INBOUND_ORIGIN) return;
				if (this.opts.outboundExcludedOrigins?.().has(origin)) return;
				this.outbound.push({
					update,
					paths: this.changedScopeKeys(tr),
					hasInsertions: this.transactionInserted(tr),
				});
				// Unheld traffic flows without waiting for a flush edge — a
				// mid-session rename must not sit queued until the next
				// posture change. The microtask batches a transaction burst
				// into one wire update; held entries stay held.
				this.scheduleFlush();
			};
			this.opts.localDoc.on("update", this.localHandler);
		}
		if (!this.remoteHandler) {
			this.remoteHandler = (_update, origin) => {
				if (origin === FOLDER_BRIDGE_OUTBOUND_ORIGIN) return;
				this.flushInbound();
			};
			this.opts.remoteDoc.on("update", this.remoteHandler);
		}
		this.flushInbound();
	}

	get pendingOutbound(): number {
		return this.outbound.length;
	}

	/** Keys currently sitting in un-flushed outbound entries. */
	queuedOutboundPaths(): Set<string> {
		const paths = new Set<string>();
		for (const entry of this.outbound) {
			for (const path of entry.paths) paths.add(path);
		}
		return paths;
	}

	/**
	 * Replace the stored wire bytes of the entries wholly tagged with the
	 * given keys. When a never-shipped item's value is rewritten in place,
	 * the bytes captured at write time still carry the old value; the
	 * caller re-derives them from the document and swaps them here before
	 * the hold lifts.
	 */
	replaceOutboundUpdate(paths: Set<string>, update: Uint8Array): boolean {
		let replaced = false;
		for (const entry of this.outbound) {
			if (entry.paths.size === 0) continue;
			let allMatch = true;
			for (const path of entry.paths) {
				if (!paths.has(path)) {
					allMatch = false;
					break;
				}
			}
			if (!allMatch) continue;
			if (!replaced) {
				entry.update = update;
				replaced = true;
			} else {
				// Multiple entries for the key collapse into the re-derived
				// bytes once; the rest become empty no-ops.
				entry.update = update.slice(0, 0);
				entry.paths = new Set();
				entry.hasInsertions = false;
			}
		}
		this.outbound = this.outbound.filter(
			(entry) => entry.update.length > 0,
		);
		return replaced;
	}

	/**
	 * Drop queued deletion-only entries that touch only the given keys —
	 * the deletion gate's restore. Discarding is legal exactly for entries
	 * with no insertions: delete-set ranges carry no clock, so removing
	 * them leaves no integration gap. Insert-bearing entries are kept
	 * whatever their keys — their withdrawal is a compensating cancel that
	 * ships behind them, never a hole in the clock sequence.
	 */
	discardOutbound(paths: Iterable<string>): void {
		const targets = new Set(paths);
		this.outbound = this.outbound.filter((entry) => {
			if (entry.hasInsertions || entry.paths.size === 0) return true;
			for (const path of entry.paths) {
				if (!targets.has(path)) return true;
			}
			return false;
		});
	}

	/**
	 * Apply to localDoc whatever remoteDoc holds beyond it. Idempotent and
	 * self-healing: the diff carries the remote's full delete set, and a
	 * no-op application is skipped.
	 */
	flushInbound(): void {
		if (!this.opts.mayFlushInbound()) return;
		const { localDoc, remoteDoc } = this.opts;
		let diff = Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(localDoc));
		if (Y.snapshotContainsUpdate(Y.snapshot(localDoc), diff)) return;
		if (this.opts.beforeInbound) {
			this.opts.beforeInbound();
			// The withdrawal may have moved localDoc; recompute the diff so
			// the apply is against the state the decision left behind.
			diff = Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(localDoc));
			if (Y.snapshotContainsUpdate(Y.snapshot(localDoc), diff)) {
				this.reconcileShadowedKeys();
				this.opts.onInbound?.();
				return;
			}
		}
		Y.applyUpdate(localDoc, diff, FOLDER_BRIDGE_INBOUND_ORIGIN);
		this.reconcileShadowedKeys();
		this.opts.onInbound?.();
	}

	/**
	 * Assert value-level convergence for un-held keys after an inbound
	 * apply. Map conflict resolution keys visibility to the rightmost
	 * item, deleted or not: a withdrawn claim's tombstone with a higher
	 * client id shadows a concurrent committed entry at the key — locally
	 * and, once the withdrawal ships, on every replica — and no update can
	 * dig it out, because the entry is already applied, just invisible.
	 * The bridge re-asserts the remote's own value as a fresh local write:
	 * causally after both contenders, it wins everywhere, and it ships
	 * through the normal queue so peers heal too. It traces to the
	 * remote's committed value (a reconciliation adoption), and the steady
	 * state writes nothing.
	 */
	private reconcileShadowedKeys(): void {
		const { localDoc, remoteDoc } = this.opts;
		const held = this.opts.heldPaths();
		const queued = this.queuedOutboundPaths();
		const shadowed: Array<[string, string, unknown]> = [];
		for (const name of this.opts.scope) {
			const remoteMap = remoteDoc.getMap(name);
			const localMap = localDoc.getMap(name);
			remoteMap.forEach((value, key) => {
				if (held.has(key) || queued.has(key)) return;
				const localValue = localMap.get(key);
				if (JSON.stringify(localValue) !== JSON.stringify(value)) {
					shadowed.push([name, key, value]);
				}
			});
		}
		if (shadowed.length === 0) return;
		// One transaction across every scope map: a membership entry must
		// never be observable in one map without the other.
		localDoc.transact(() => {
			for (const [name, key, value] of shadowed) {
				localDoc.getMap(name).set(key, value);
			}
		}, FOLDER_BRIDGE_ECHO_ORIGIN);
	}

	/**
	 * Release the longest queue prefix free of held work into remoteDoc.
	 * Entries the remote already contains drop; a held insert-bearing
	 * entry blocks everything behind it (clock contiguity); a held
	 * deletion-only entry merely stays queued. When nothing is queued and
	 * nothing is held, a state diff ships whatever local work the queue
	 * never carried — staged operations restored from a previous session's
	 * ledger, whose replay predates the bridge's listeners.
	 */
	flushOutbound(): void {
		if (!this.opts.mayFlushOutbound()) return;
		const { localDoc, remoteDoc } = this.opts;
		const held = this.opts.heldPaths();
		const isHeld = (entry: OutboundEntry) => {
			for (const path of entry.paths) {
				if (held.has(path)) return true;
			}
			return false;
		};

		if (this.outbound.length > 0) {
			const remoteSnapshot = Y.snapshot(remoteDoc);
			const toSend: Uint8Array[] = [];
			const remaining: OutboundEntry[] = [];
			let blocked = false;
			for (const entry of this.outbound) {
				if (Y.snapshotContainsUpdate(remoteSnapshot, entry.update)) {
					continue;
				}
				if (blocked) {
					remaining.push(entry);
					continue;
				}
				if (isHeld(entry)) {
					remaining.push(entry);
					if (entry.hasInsertions) blocked = true;
					continue;
				}
				toSend.push(entry.update);
			}
			this.outbound = remaining;

			if (toSend.length > 0) {
				Y.applyUpdate(
					remoteDoc,
					Y.mergeUpdates(toSend),
					FOLDER_BRIDGE_OUTBOUND_ORIGIN,
				);
			}
		}

		if (this.outbound.length === 0 && held.size === 0) {
			const diff = Y.encodeStateAsUpdate(
				localDoc,
				Y.encodeStateVector(remoteDoc),
			);
			if (!Y.snapshotContainsUpdate(Y.snapshot(remoteDoc), diff)) {
				Y.applyUpdate(remoteDoc, diff, FOLDER_BRIDGE_OUTBOUND_ORIGIN);
			}
		}
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		void Promise.resolve().then(() => {
			this.flushScheduled = false;
			if (this.isDestroyed) return;
			this.flushOutbound();
		});
	}

	destroy(): void {
		this.isDestroyed = true;
		if (this.localHandler) {
			this.opts.localDoc.off("update", this.localHandler);
			this.localHandler = null;
		}
		if (this.remoteHandler) {
			this.opts.remoteDoc.off("update", this.remoteHandler);
			this.remoteHandler = null;
		}
		this.outbound = [];
	}

	private changedScopeKeys(tr: Y.Transaction): Set<string> {
		const keys = new Set<string>();
		for (const name of this.opts.scope) {
			const map = this.opts.localDoc.getMap(name) as unknown as Parameters<
				typeof tr.changed.get
			>[0];
			const changed = tr.changed.get(map);
			if (!changed) continue;
			for (const key of changed) {
				if (key !== null) keys.add(key);
			}
		}
		return keys;
	}

	private transactionInserted(tr: Y.Transaction): boolean {
		for (const [client, endClock] of tr.afterState) {
			if ((tr.beforeState.get(client) ?? 0) < endClock) return true;
		}
		return false;
	}
}
