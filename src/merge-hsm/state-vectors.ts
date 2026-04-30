/**
 * Yjs snapshot helpers.
 *
 * A Yjs document snapshot is defined by both:
 * - state vector: insertion clocks per client
 * - delete set: tombstone ranges
 *
 * State-vector-only comparisons are useful for gap detection and transport
 * routing, but they are not sufficient to answer "are these documents equal?"
 * because delete-only changes can leave the state vector unchanged.
 */

import * as Y from "yjs";
import * as encoding from "lib0/encoding";

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
	return { snapshot: Y.encodeSnapshot(Y.snapshot(doc)) };
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
 * Encode a decoded state vector map into Yjs state-vector bytes.
 */
export function encodeSV(sv: DecodedSV): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, sv.size);
	for (const [clientId, clock] of sv) {
		encoding.writeVarUint(encoder, clientId);
		encoding.writeVarUint(encoder, clock);
	}
	return encoding.toUint8Array(encoder);
}

/**
 * Extract encoded state-vector bytes from an encoded Yjs snapshot.
 */
export function stateVectorFromSnapshot(snapshot: YjsSnapshot): Uint8Array {
	return encodeSV(snapshotStateVector(snapshot));
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

/**
 * Check if two snapshots are exactly equal.
 */
export function snapshotsEqual(a: YjsSnapshot, b: YjsSnapshot): boolean {
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

// ---- Convenience wrappers for encoded Uint8Array inputs ----

/**
 * Check if two encoded state vectors are identical.
 */
export function stateVectorsEqual(sv1: Uint8Array, sv2: Uint8Array): boolean {
	return svEqual(decodeSV(sv1), decodeSV(sv2));
}

/**
 * Check if encoded state vector `ahead` contains operations not in `behind`.
 */
export function stateVectorIsAhead(ahead: Uint8Array, behind: Uint8Array): boolean {
	return svIsAhead(decodeSV(ahead), decodeSV(behind));
}
