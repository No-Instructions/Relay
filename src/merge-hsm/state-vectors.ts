/**
 * State vector comparison utilities.
 *
 * Y.js state vectors are Map<clientId, clock> encoded as Uint8Array.
 * These functions compare decoded state vectors to determine the
 * relationship between two CRDT states.
 */

import * as Y from "yjs";

/** Decoded state vector: Map<clientId, clock> */
export type DecodedSV = Map<number, number>;

/**
 * Decode a Uint8Array state vector into a Map<clientId, clock>.
 */
export function decodeSV(sv: Uint8Array): DecodedSV {
	return Y.decodeStateVector(sv);
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
	const decoded = Y.decodeUpdate(update);
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

	const decoded = Y.decodeUpdate(update);
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
