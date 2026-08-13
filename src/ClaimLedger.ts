"use strict";

/**
 * The capture staging over a folder's localDoc: the durable record of
 * membership intent the device has not published, and the two withdrawal
 * primitives that rework it against the server's answer.
 *
 * The ledger owns no machine and no policy. It answers three structural
 * questions — which keys carry un-flushed claims, which carry held local
 * deletions, and whether a captured entry's items crossed the boundary —
 * and executes the withdrawal each answer licenses:
 *
 * - `cancel` is a true undo, legal only for entries peers have not seen.
 *   No new items are produced, so a remote update performing the same
 *   edits applies with no duplication.
 * - Entries peers have seen must be withdrawn by a new operation instead;
 *   `decide` reports which side of the boundary an entry sits on.
 *
 * The boundary is containment, observed rather than remembered: whether
 * the entry's items are contained in the remote document — insert clocks
 * for what reached the server, the delete set for what was superseded
 * there. A persisted flag could not answer this (the serialized entry
 * carries no sync status, so every restored entry reads as un-synced);
 * containment re-decides correctly after any restart. The comparison is
 * genuine server truth only once the bootstrap machine reaches its
 * crossing — callers decide at or after it, never against a cold replica.
 *
 * No Obsidian or logging dependencies; the module tests as a value.
 */

import * as Y from "yjs";
import { OpCapture, CapturedOp } from "./merge-hsm/undo";
import { deleteSetContains, type DecodedDeleteSet } from "./merge-hsm/snapshots";
import {
	FOLDER_CLAIM_ORIGIN,
	FOLDER_LOCAL_DELETE_ORIGIN,
} from "./FolderCaptureBridge";

export type WithdrawalDecision = "cancel" | "reverse";

/**
 * The identity carried by a captured map value. Membership writes land in
 * two maps in one transaction — `filemeta_v0` holds a Meta and the
 * compatibility map holds the guid itself — and either shape answers.
 */
function identityOf(value: unknown): string | null {
	if (typeof value === "string") return value;
	const id = (value as { id?: unknown } | undefined)?.id;
	return typeof id === "string" ? id : null;
}

type InternalDeleteSet = {
	clients: Map<number, { clock: number; len: number }[]>;
};

type InternalSnapshot = {
	sv: Map<number, number>;
	ds: InternalDeleteSet;
};

function decodedRanges(ds: InternalDeleteSet): DecodedDeleteSet {
	const out: DecodedDeleteSet = new Map();
	for (const [client, items] of ds.clients) {
		if (items.length === 0) continue;
		out.set(
			client,
			items.map((item) => ({ clock: item.clock, len: item.len })),
		);
	}
	return out;
}

function svCoversRanges(
	sv: Map<number, number>,
	ds: InternalDeleteSet,
): boolean {
	for (const [client, items] of ds.clients) {
		const clock = sv.get(client) ?? 0;
		for (const item of items) {
			if (item.clock + item.len > clock) return false;
		}
	}
	return true;
}

/**
 * Whether a captured entry's items are contained in `doc` — its insertions
 * covered by the doc's insert clocks and its deletions by the doc's delete
 * set. Both halves matter: an entry whose items reached the server and were
 * then superseded there is still contained, which is the case an
 * insert-clock-only test gets wrong.
 */
export function entryContainedInDoc(entry: CapturedOp, doc: Y.Doc): boolean {
	const snapshot = Y.snapshot(doc) as unknown as InternalSnapshot;
	const insertions = entry.insertions as unknown as InternalDeleteSet;
	const deletions = entry.deletions as unknown as InternalDeleteSet;
	return (
		svCoversRanges(snapshot.sv, insertions) &&
		deleteSetContains(decodedRanges(snapshot.ds), decodedRanges(deletions))
	);
}

export class ClaimLedger {
	/**
	 * Keys per entry, computed once: with `captureTimeout: 0` an entry
	 * never coalesces, so its key set is immutable after capture.
	 */
	private readonly keyCache = new WeakMap<CapturedOp, Set<string>>();

	constructor(
		private readonly opCapture: OpCapture,
		/** The server replica containment decides against, read live. */
		private readonly remoteDoc: () => Y.Doc,
	) {}

	get isEmpty(): boolean {
		return this.opCapture.entries.length === 0;
	}

	/** Keys with un-flushed claim entries: the provisional realm's paths. */
	claims(): Set<string> {
		return this.keysByOrigin(FOLDER_CLAIM_ORIGIN);
	}

	/** Keys with un-flushed local deletion entries: the gate's held burst. */
	heldDeletions(): Set<string> {
		return this.keysByOrigin(FOLDER_LOCAL_DELETE_ORIGIN);
	}

	/** Every key with un-flushed staged work — the bridge's hold set. */
	heldPaths(): Set<string> {
		const paths = this.claims();
		for (const path of this.heldDeletions()) paths.add(path);
		return paths;
	}

	/** Un-flushed entries touching a key, in capture order. */
	entriesFor(path: string): CapturedOp[] {
		return this.opCapture.entries.filter(
			(entry) => !entry._synced && this.entryKeys(entry).has(path),
		);
	}

	/**
	 * Which withdrawal a key's staged entries admit: contained in the
	 * server replica → the items crossed the boundary and peers may hold
	 * them → `reverse`; not contained → they never crossed → `cancel` is a
	 * clean undo. Any contained entry makes the whole key `reverse` —
	 * cancelling around published items risks tombstoning a peer's survivor.
	 */
	decide(path: string): WithdrawalDecision {
		const remote = this.remoteDoc();
		for (const entry of this.entriesFor(path)) {
			if (entryContainedInDoc(entry, remote)) return "reverse";
		}
		return "cancel";
	}

	/**
	 * A key's un-flushed claim entries whose items have provably never
	 * shipped — the entries in-place value replacement is legal for.
	 */
	unshippedClaimEntries(path: string): CapturedOp[] {
		const remote = this.remoteDoc();
		return this.entriesFor(path).filter(
			(entry) =>
				entry.origin === FOLDER_CLAIM_ORIGIN &&
				!entryContainedInDoc(entry, remote),
		);
	}

	/**
	 * Rewrite a claim's staged values in place — no replica has seen the
	 * items, so they simply become items that always said the replacement.
	 * The metadata row takes `meta`; the compatibility row takes its guid.
	 * Returns the freshly encoded wire bytes for the rewritten entries, or
	 * null when the key holds no rewritable claim. The caller swaps the
	 * queued bytes and compacts persistence before lifting the hold.
	 */
	rewriteClaim(
		path: string,
		meta: { id: string },
	): { entries: CapturedOp[]; update: Uint8Array } | null {
		const entries = this.unshippedClaimEntries(path);
		if (entries.length === 0) return null;
		const updates: Uint8Array[] = [];
		for (const entry of entries) {
			this.opCapture.replaceUnshippedContent(entry, (_key, current) =>
				typeof current === "string" ? meta.id : meta,
			);
			updates.push(this.opCapture.encodeEntryInsertions(entry));
		}
		return { entries, update: Y.mergeUpdates(updates) };
	}

	/**
	 * The claim is resolved: its entries leave the ledger without touching
	 * the document. Used after a rewrite, when the items are no longer
	 * pending intent but ordinary agreeing writes.
	 */
	resolveClaim(entries: CapturedOp[]): void {
		this.opCapture.drop(entries);
	}

	/**
	 * Cancel a key's staged claim: a true undo of the captured ops, leaving
	 * the map exactly as if the claim had never been made. Legal only while
	 * `decide` answers `cancel`.
	 */
	cancelClaim(path: string): void {
		const entries = this.entriesFor(path).filter(
			(entry) => entry.origin === FOLDER_CLAIM_ORIGIN,
		);
		if (entries.length > 0) {
			this.opCapture.cancel(entries);
		}
	}

	/**
	 * Cancel held local deletions — the gate's restore. The un-tombstone
	 * produces no new items, so the map re-asserts the entries as if the
	 * deletions had never been made.
	 */
	cancelDeletions(paths: Iterable<string>): void {
		const targets = new Set(paths);
		const entries = this.opCapture.entries.filter((entry) => {
			if (entry._synced || entry.origin !== FOLDER_LOCAL_DELETE_ORIGIN) {
				return false;
			}
			for (const key of this.entryKeys(entry)) {
				if (targets.has(key)) return true;
			}
			return false;
		});
		if (entries.length > 0) {
			this.opCapture.cancel(entries);
		}
	}

	/**
	 * Release keys for publication: mark exactly their entries synced so
	 * the bridge's hold lifts and the next outbound flush ships them.
	 * Returns the marked entries (the flushed batch).
	 */
	flush(paths: Iterable<string>): CapturedOp[] {
		const targets = new Set(paths);
		const batch: CapturedOp[] = [];
		for (const entry of this.opCapture.entries) {
			if (entry._synced) continue;
			for (const key of this.entryKeys(entry)) {
				if (targets.has(key)) {
					batch.push(entry);
					break;
				}
			}
		}
		this.opCapture.notifySyncedEntries(batch);
		return batch;
	}

	/**
	 * The identity a staged claim minted for a path, read from the claim
	 * entry's own inserted value. The blended map cannot answer this — a
	 * competing committed entry can shadow the staged item at the key —
	 * so the claim's identity comes from the op that staged it.
	 */
	claimIdentity(path: string): string | null {
		for (const entry of this.opCapture.entries) {
			if (entry._synced || entry.origin !== FOLDER_CLAIM_ORIGIN) continue;
			const guid = identityOf(
				this.opCapture.insertedEntryValues(entry).get(path),
			);
			if (guid) return guid;
		}
		return null;
	}

	/**
	 * The identity a held deletion observed at decision time, re-derived
	 * from the tombstoned value the capture retains. Null when the entry
	 * carries no readable identity.
	 */
	deletionIdentity(path: string): string | null {
		for (const entry of this.opCapture.entries) {
			if (entry._synced || entry.origin !== FOLDER_LOCAL_DELETE_ORIGIN) {
				continue;
			}
			const guid = identityOf(
				this.opCapture.deletedEntryValues(entry).get(path),
			);
			if (guid) return guid;
		}
		return null;
	}

	/**
	 * Retire entries the server has acknowledged: marked flushed, or
	 * restored from a session whose flush already reached the replica —
	 * either way their items are contained in the remote document, so they
	 * are published membership, not pending intent. The ledger must be
	 * durable exactly until acknowledgement; this is the drop.
	 */
	acknowledge(): void {
		const remote = this.remoteDoc();
		const acknowledged = this.opCapture.entries.filter((entry) =>
			entryContainedInDoc(entry, remote),
		);
		if (acknowledged.length > 0) {
			this.opCapture.drop(acknowledged);
		}
	}

	private keysByOrigin(origin: unknown): Set<string> {
		const keys = new Set<string>();
		for (const entry of this.opCapture.entries) {
			if (entry._synced || entry.origin !== origin) continue;
			for (const key of this.entryKeys(entry)) keys.add(key);
		}
		return keys;
	}

	private entryKeys(entry: CapturedOp): Set<string> {
		const cached = this.keyCache.get(entry);
		if (cached) return cached;
		const keys = new Set<string>(this.opCapture.insertedKeys(entry));
		for (const key of this.opCapture.deletedKeys(entry)) keys.add(key);
		this.keyCache.set(entry, keys);
		return keys;
	}
}
