/**
 * Yjs snapshot helpers.
 *
 * A Yjs document snapshot is defined by both:
 * - insertion clocks per client (the state vector)
 * - delete set: tombstone ranges
 *
 * Snapshots are the only head representation the sync engine stores or
 * compares: insert-clock-only comparisons cannot answer "are these documents
 * equal?" because delete-only changes leave insert clocks unchanged.
 *
 * The decoded insert-clock (`DecodedSV`) and delete-set helpers below are
 * internal surgery primitives — every exported comparison that decides
 * equality, containment, or aheadness accounts for the delete set.
 */

import * as Y from "yjs";

/** Decoded state vector: Map<clientId, clock> */
export type DecodedSV = Map<number, number>;

export interface DeleteRange {
	clock: number;
	len: number;
}

/** Decoded delete set: Map<clientId, sorted merged delete ranges> */
export type DecodedDeleteSet = Map<number, DeleteRange[]>;

export interface YjsSnapshot {
	snapshot: Uint8Array;
}

const docSnapshotCache = new WeakMap<Y.Doc, YjsSnapshot>();

function invalidateDocSnapshot(doc: Y.Doc): void {
	docSnapshotCache.delete(doc);
}

type SnapshotLike = {
	sv: DecodedSV;
	ds: {
		clients: DecodedDeleteSet;
	};
};

function toSnapshotLike(snapshot: unknown): SnapshotLike {
	return snapshot as SnapshotLike;
}

function snapshotDataFromDoc(doc: Y.Doc): SnapshotLike {
	return toSnapshotLike(Y.snapshot(doc));
}

function decodeSnapshotData(snapshot: YjsSnapshot): SnapshotLike {
	return toSnapshotLike(Y.decodeSnapshot(snapshot.snapshot));
}

function decodeUpdateData(update: Uint8Array) {
	return Y.decodeUpdate(update);
}

/**
 * Decode a Uint8Array state vector into a Map<clientId, clock>.
 */
export function decodeSV(sv: Uint8Array): DecodedSV {
	return Y.decodeStateVector(sv);
}

/**
 * Check if `superset` contains every client clock present in `subset`.
 */
export function svContains(superset: DecodedSV, subset: DecodedSV): boolean {
	for (const [clientId, clock] of subset) {
		if ((superset.get(clientId) ?? 0) < clock) return false;
	}
	return true;
}

/**
 * Check if two state vectors are identical (same clients, same clocks).
 */
export function svEqual(a: DecodedSV, b: DecodedSV): boolean {
	if (a.size !== b.size) return false;
	for (const [clientId, clock] of a) {
		if (b.get(clientId) !== clock) return false;
	}
	return true;
}

/**
 * Check if `a` is strictly ahead of `b` — i.e. `a` contains at least one
 * client with a higher clock than `b`.
 */
export function svIsAhead(a: DecodedSV, b: DecodedSV): boolean {
	for (const [clientId, clock] of a) {
		const bClock = b.get(clientId) ?? 0;
		if (clock > bClock) return true;
	}
	return false;
}

/**
 * Check if `a` is stale relative to `b` — i.e. `a` contains at least one
 * client with a lower clock than `b`. This means `b` has progressed past
 * some operations that `a` depends on.
 */
export function svIsStale(a: DecodedSV, b: DecodedSV): boolean {
	for (const [clientId, clock] of a) {
		const bClock = b.get(clientId);
		if (bClock !== undefined && clock < bClock) return true;
	}
	return false;
}

/**
 * Extract the dependency SV from a delta — the minimum clock per client
 * across all structs. This tells us what state the receiving doc must
 * have before this delta can be meaningfully applied.
 */
export function extractDependencySV(update: Uint8Array): DecodedSV {
	const decoded = decodeUpdateData(update);
	const dep: DecodedSV = new Map();
	for (const struct of decoded.structs) {
		const { client, clock } = struct.id;
		const existing = dep.get(client);
		if (existing === undefined || clock < existing) {
			dep.set(client, clock);
		}
	}
	return dep;
}

/**
 * Classify a delta update relative to a tracked baseline SV.
 *
 * Uses the delta's dependency SV (min clock per client from decoded structs)
 * to detect real gaps — cases where the delta's ops start beyond what
 * our tracked state covers, meaning intermediate ops are missing.
 *
 * - 'apply': baseline covers the delta's dependencies — safe to apply
 * - 'stale': delta's ops are all already covered by baseline — drop it
 * - 'gap': no baseline, or baseline is missing ops the delta depends on
 */
export function classifyUpdate(
	update: Uint8Array,
	tracked: DecodedSV | undefined,
): "apply" | "stale" | "gap" {
	if (!tracked) return "gap";

	const decoded = decodeUpdateData(update);
	if (decoded.structs.length === 0) return "stale";

	let hasNewOps = false;

	for (const struct of decoded.structs) {
		const { client, clock } = struct.id;
		const trackedClock = tracked.get(client) ?? 0;

		// This struct starts beyond what we've tracked — missing intermediate ops
		if (clock > trackedClock) return "gap";

		// This struct extends beyond what we've tracked — contains new ops
		const endClock = clock + (struct.length ?? 1);
		if (endClock > trackedClock) hasNewOps = true;
	}

	return hasNewOps ? "apply" : "stale";
}

/**
 * Check whether a Y.Doc is empty (no CRDT operations from any client).
 * An empty Y.Doc has a zero-entry state vector.
 */
export function isEmptyDoc(doc: Y.Doc): boolean {
	return decodeSV(Y.encodeStateVector(doc)).size === 0;
}

/**
 * Check if every tombstone range in `subset` is covered by `superset`.
 */
export function deleteSetContains(superset: DecodedDeleteSet, subset: DecodedDeleteSet): boolean {
	for (const [clientId, subsetRanges] of subset) {
		const supersetRanges = superset.get(clientId) ?? [];
		let supersetIndex = 0;

		for (const range of subsetRanges) {
			let coveredUntil = range.clock;
			const rangeEnd = range.clock + range.len;

			while (
				supersetIndex < supersetRanges.length &&
				supersetRanges[supersetIndex].clock + supersetRanges[supersetIndex].len <= coveredUntil
			) {
				supersetIndex++;
			}

			let scanIndex = supersetIndex;
			while (scanIndex < supersetRanges.length && coveredUntil < rangeEnd) {
				const candidate = supersetRanges[scanIndex];
				if (candidate.clock > coveredUntil) return false;
				coveredUntil = Math.max(coveredUntil, candidate.clock + candidate.len);
				scanIndex++;
			}

			if (coveredUntil < rangeEnd) return false;
			supersetIndex = Math.max(supersetIndex, scanIndex - 1);
		}
	}

	return true;
}

/**
 * Capture the full Yjs snapshot for a document: insert clocks + delete set.
 */
export function snapshotFromDoc(doc: Y.Doc): YjsSnapshot {
	const cached = docSnapshotCache.get(doc);
	if (cached) return cached;

	const snapshot = { snapshot: Y.encodeSnapshot(Y.snapshot(doc)) };
	docSnapshotCache.set(doc, snapshot);
	doc.once("beforeObserverCalls", () => invalidateDocSnapshot(doc));
	return snapshot;
}

/**
 * Compare a live document with an encoded snapshot. Unequal insert clocks
 * prove inequality without materializing the document's delete set; equal
 * clocks still require the full snapshot comparison.
 */
export function docMatchesSnapshot(doc: Y.Doc, snapshot: YjsSnapshot): boolean {
	const docSV = Y.decodeStateVector(Y.encodeStateVector(doc));
	const expectedSV = snapshotStateVector(snapshot);
	if (!svEqual(docSV, expectedSV)) return false;
	return snapshotsEqual(snapshotFromDoc(doc), snapshot);
}

/**
 * Build a Yjs snapshot from a standalone update.
 */
export function snapshotFromUpdate(update: Uint8Array): YjsSnapshot {
	const doc = new Y.Doc();
	try {
		Y.applyUpdate(doc, update);
		return snapshotFromDoc(doc);
	} finally {
		doc.destroy();
	}
}

/**
 * Extract the state vector portion from an encoded Yjs snapshot.
 */
export function snapshotStateVector(snapshot: YjsSnapshot): DecodedSV {
	return new Map(decodeSnapshotData(snapshot).sv);
}

/**
 * Whether an encoded Yjs snapshot covers one struct: the struct's client had
 * already advanced past its clock when the snapshot was captured. Answers
 * "was this item written before the baseline" for a single item, where the
 * whole-head helpers compare entire documents.
 */
export function snapshotCoversItem(
	snapshot: YjsSnapshot,
	id: { client: number; clock: number },
): boolean {
	return id.clock < (decodeSnapshotData(snapshot).sv.get(id.client) ?? 0);
}

/**
 * Check whether an encoded Yjs snapshot includes any tombstones.
 */
export function snapshotHasDeleteSet(snapshot: YjsSnapshot): boolean {
	for (const ranges of decodeSnapshotData(snapshot).ds.clients.values()) {
		if (ranges.length > 0) return true;
	}
	return false;
}

/**
 * Check if snapshot `superset` contains all structs and tombstones in `subset`.
 */
export function snapshotContains(superset: YjsSnapshot, subset: YjsSnapshot): boolean {
	const sup = decodeSnapshotData(superset);
	const sub = decodeSnapshotData(subset);
	return svContains(sup.sv, sub.sv) && deleteSetContains(sup.ds.clients, sub.ds.clients);
}

function snapshotBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a === b) return true;
	if (a.byteLength !== b.byteLength) return false;
	for (let index = 0; index < a.byteLength; index++) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

/**
 * Check if two snapshots are exactly equal. Canonically encoded snapshots
 * (Y.encodeSnapshot output) take the byte-equality fast path without
 * semantic decoding.
 */
export function snapshotsEqual(a: YjsSnapshot, b: YjsSnapshot): boolean {
	if (snapshotBytesEqual(a.snapshot, b.snapshot)) return true;
	return Y.equalSnapshots(
		Y.decodeSnapshot(a.snapshot),
		Y.decodeSnapshot(b.snapshot),
	);
}

/**
 * Check whether UPDATE is already covered by SNAPSHOT.
 */
export function snapshotContainsUpdate(snapshot: YjsSnapshot, update: Uint8Array): boolean {
	return Y.snapshotContainsUpdate(Y.decodeSnapshot(snapshot.snapshot), update);
}

/**
 * Check if snapshot `ahead` strictly dominates `behind`.
 */
export function snapshotIsAhead(ahead: YjsSnapshot, behind: YjsSnapshot): boolean {
	return snapshotContains(ahead, behind) && !snapshotsEqual(ahead, behind);
}

/**
 * Check if two live docs are exactly equal in Yjs terms (SV + delete set).
 */
export function yjsDocsEqual(a: Y.Doc, b: Y.Doc): boolean {
	return Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b));
}

/**
 * Check if `ahead` strictly dominates `behind` in Yjs terms.
 */
export function yjsDocIsAhead(ahead: Y.Doc, behind: Y.Doc): boolean {
	const decodedAhead = snapshotDataFromDoc(ahead);
	const decodedBehind = snapshotDataFromDoc(behind);
	return svContains(decodedAhead.sv, decodedBehind.sv)
		&& deleteSetContains(decodedAhead.ds.clients, decodedBehind.ds.clients)
		&& !Y.equalSnapshots(Y.snapshot(ahead), Y.snapshot(behind));
}

/**
 * Check whether UPDATE would change DOC.
 */
export function yjsUpdateIsNoop(doc: Y.Doc, update: Uint8Array): boolean {
	return Y.snapshotContainsUpdate(Y.snapshot(doc), update);
}

/**
 * Check whether UPDATE carries any delete-set entries.
 */
export function updateHasDeleteSet(update: Uint8Array): boolean {
	return decodeUpdateData(update).ds.clients.size > 0;
}

/** Sort ranges by clock and coalesce overlapping/adjacent ones. */
function normalizeDeleteRanges(ranges: DeleteRange[]): DeleteRange[] {
	const sorted = [...ranges].sort((a, b) => a.clock - b.clock);
	const merged: DeleteRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.clock <= last.clock + last.len) {
			const end = Math.max(last.clock + last.len, range.clock + range.len);
			last.len = end - last.clock;
		} else {
			merged.push({ clock: range.clock, len: range.len });
		}
	}
	return merged;
}

/**
 * Decode the delete set carried by an update into per-client sorted,
 * coalesced ranges. Together with a tracked state vector this fully
 * describes a baseline for containment checks — without retaining or
 * re-decoding the update bytes that produced it.
 */
export function decodeUpdateDeleteSet(update: Uint8Array): DecodedDeleteSet {
	const raw = decodeUpdateData(update).ds.clients as Map<
		number,
		DeleteRange[]
	>;
	const out: DecodedDeleteSet = new Map();
	for (const [client, ranges] of raw) {
		if (ranges.length === 0) continue;
		out.set(
			client,
			normalizeDeleteRanges(
				ranges.map((r) => ({ clock: r.clock, len: r.len })),
			),
		);
	}
	return out;
}

/**
 * Merge two decoded delete sets into a new normalized one (per-client
 * range union). Neither input is mutated.
 */
export function mergeDecodedDeleteSets(
	a: DecodedDeleteSet,
	b: DecodedDeleteSet,
): DecodedDeleteSet {
	const out: DecodedDeleteSet = new Map();
	const clients = new Set([...a.keys(), ...b.keys()]);
	for (const client of clients) {
		const combined = [...(a.get(client) ?? []), ...(b.get(client) ?? [])].map(
			(r) => ({ clock: r.clock, len: r.len }),
		);
		if (combined.length > 0) {
			out.set(client, normalizeDeleteRanges(combined));
		}
	}
	return out;
}

// ---- Point-in-time restoration ----

/**
 * Rebuild a document exactly as it stood at SNAPSHOT from a doc whose
 * history contains it. The source doc is copied into a gc-disabled doc
 * because Yjs refuses to restore from a doc that may collect deleted
 * content. The restored head is then verified against SNAPSHOT: a
 * tombstone whose content was already garbage-collected surfaces as a
 * head mismatch, so an inexact restoration returns null rather than
 * wrong content. The caller owns the returned doc and must destroy it.
 */
/**
 * A seed update for a fresh replica of `doc`, bounded by a server head.
 * Accepted only when the head proves the seed cannot introduce local-only
 * CRDT state: a head containing local state seeds everything; local state
 * containing the head seeds the verified restoration at the head; anything
 * else seeds nothing and the provider handshake carries the difference.
 */
export function seedUpdateBoundedByHead(
	doc: Y.Doc,
	head: YjsSnapshot,
): Uint8Array | null {
	let local: YjsSnapshot;
	try {
		local = snapshotFromDoc(doc);
	} catch {
		return null;
	}

	try {
		if (snapshotContains(head, local)) {
			return Y.encodeStateAsUpdate(doc);
		}
		if (!snapshotContains(local, head)) {
			return null;
		}
	} catch {
		return null;
	}

	const restoredDoc = restoreDocAtSnapshot(doc, head);
	if (!restoredDoc) return null;
	try {
		return Y.encodeStateAsUpdate(restoredDoc);
	} finally {
		restoredDoc.destroy();
	}
}

/**
 * Rebuild a doc at an earlier snapshot of `doc`, verifying the rebuilt head
 * matches; null when the snapshot is not contained or cannot be restored
 * exactly.
 */
export function restoreDocAtSnapshot(
	doc: Y.Doc,
	snapshot: YjsSnapshot,
): Y.Doc | null {
	let decoded: Y.Snapshot;
	try {
		decoded = Y.decodeSnapshot(snapshot.snapshot);
		if (!snapshotContains(snapshotFromDoc(doc), snapshot)) return null;
	} catch {
		return null;
	}

	const originDoc = new Y.Doc({ gc: false });
	let restoredDoc: Y.Doc | null = null;
	try {
		Y.applyUpdate(originDoc, Y.encodeStateAsUpdate(doc));
		restoredDoc = Y.createDocFromSnapshot(originDoc, decoded);
		if (!snapshotsEqual(snapshotFromDoc(restoredDoc), snapshot)) {
			restoredDoc.destroy();
			return null;
		}
		return restoredDoc;
	} catch {
		restoredDoc?.destroy();
		return null;
	} finally {
		originDoc.destroy();
	}
}

/**
 * The text of a Y.Text root exactly as it stood at SNAPSHOT, rebuilt from
 * a doc whose history contains it. Returns null when the doc does not
 * contain the snapshot or when collected history makes the rebuilt text
 * unverifiable.
 */
export function restoreTextAtSnapshot(
	doc: Y.Doc,
	snapshot: YjsSnapshot,
	field: string,
): string | null {
	const restoredDoc = restoreDocAtSnapshot(doc, snapshot);
	if (!restoredDoc) return null;
	try {
		return restoredDoc.getText(field).toString();
	} finally {
		restoredDoc.destroy();
	}
}

// ---- Snapshot head construction and comparison ----

function encodeDecodedSnapshot(sv: DecodedSV, ds: DecodedDeleteSet): Uint8Array {
	const clients = new Map<number, DeleteRange[]>();
	for (const [client, ranges] of ds) {
		clients.set(
			client,
			ranges.map((r) => ({ clock: r.clock, len: r.len })),
		);
	}
	return Y.encodeSnapshot(
		new Y.Snapshot({ clients }, new Map(sv)),
	);
}

/**
 * The snapshot metadata carried by an update: the insert clocks it covers
 * plus its delete set. Lets a doc-less consumer track a remote head from
 * update bytes alone.
 */
export function snapshotMetaFromUpdate(update: Uint8Array): YjsSnapshot {
	const sv = decodeSV(Y.encodeStateVectorFromUpdate(update));
	const ds = decodeUpdateDeleteSet(update);
	return { snapshot: encodeDecodedSnapshot(sv, ds) };
}

/**
 * Union of two snapshot heads: max insert clock per client, merged delete
 * sets. Neither input is mutated.
 */
export function mergeSnapshotHeads(a: YjsSnapshot, b: YjsSnapshot): YjsSnapshot {
	const decodedA = decodeSnapshotData(a);
	const decodedB = decodeSnapshotData(b);
	const sv: DecodedSV = new Map(decodedA.sv);
	for (const [client, clock] of decodedB.sv) {
		sv.set(client, Math.max(sv.get(client) ?? 0, clock));
	}
	const ds = mergeDecodedDeleteSets(decodedA.ds.clients, decodedB.ds.clients);
	return { snapshot: encodeDecodedSnapshot(sv, ds) };
}

/**
 * Check whether snapshot A records any operation — insert clock or tombstone
 * — that snapshot B lacks. This is the delete-set-aware "has changed since"
 * comparison for heads that share history: delete-only progress is visible
 * here even though it moves no insert clock.
 */
export function snapshotHasOpsMissingFrom(a: YjsSnapshot, b: YjsSnapshot): boolean {
	const decodedA = decodeSnapshotData(a);
	const decodedB = decodeSnapshotData(b);
	return (
		svIsAhead(decodedA.sv, decodedB.sv) ||
		!deleteSetContains(decodedB.ds.clients, decodedA.ds.clients)
	);
}

/**
 * Check whether a snapshot records no operations at all.
 */
export function snapshotIsEmpty(snapshot: YjsSnapshot): boolean {
	const decoded = decodeSnapshotData(snapshot);
	return decoded.sv.size === 0 && decoded.ds.clients.size === 0;
}

let cachedEmptySnapshot: Uint8Array | null = null;

/**
 * The encoded snapshot of a document with no operations.
 */
export function emptySnapshot(): Uint8Array {
	if (!cachedEmptySnapshot) {
		const doc = new Y.Doc();
		try {
			cachedEmptySnapshot = Y.encodeSnapshot(Y.snapshot(doc));
		} finally {
			doc.destroy();
		}
	}
	return cachedEmptySnapshot;
}
