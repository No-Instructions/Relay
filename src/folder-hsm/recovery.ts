/**
 * Sweep recovery — decide-first delta derivation.
 *
 * The reconciliation sweep (syncFileTree) is an event source for
 * missed-event recovery, not an imperative differ: it diffs the machine's
 * membership table against the committed map and replays the difference
 * into the machine as a synthesized MAP_DELTA. Every delete op in the
 * derived delta is a real decision — a `synced` entry whose guid the map
 * no longer holds anywhere (the ladder's rung 2 evidence). Guids that
 * merely changed paths pair into moves; guids the machine has never seen
 * become adds. Absence alone never deletes.
 */

import type {
	MapDeltaAdd,
	MapDeltaDelete,
	MapDeltaMove,
	MapEntrySummary,
	MembershipEntry,
} from "./types";

export interface RecoveryDelta {
	adds: MapDeltaAdd[];
	updates: MapDeltaAdd[];
	deletes: MapDeltaDelete[];
	moves: MapDeltaMove[];
}

export function deriveRecoveryDelta(
	entries: readonly MembershipEntry[],
	mapEntries: readonly MapEntrySummary[],
): RecoveryDelta {
	const mapByGuid = new Map(mapEntries.map((entry) => [entry.guid, entry]));
	const knownGuids = new Set(
		entries
			.map((entry) => entry.guid)
			.filter((guid): guid is string => guid !== null),
	);

	const deletes: MapDeltaDelete[] = [];
	const moves: MapDeltaMove[] = [];
	for (const entry of entries) {
		// Only files with proven membership (a synced disposition) can have
		// been remotely deleted; pending and parked entries carry no such
		// proof and must never produce delete ops.
		if (entry.disposition !== "synced" || entry.guid === null) continue;
		const inMap = mapByGuid.get(entry.guid);
		if (!inMap) {
			deletes.push({ path: entry.path, oldValue: { id: entry.guid } });
		} else if (inMap.path !== entry.path) {
			moves.push({ guid: entry.guid, from: entry.path, to: inMap.path });
		}
	}

	const adds = mapEntries.filter((entry) => !knownGuids.has(entry.guid));

	return { adds, updates: [], deletes, moves };
}

export function isEmptyRecoveryDelta(delta: RecoveryDelta): boolean {
	return (
		delta.adds.length === 0 &&
		delta.updates.length === 0 &&
		delta.deletes.length === 0 &&
		delta.moves.length === 0
	);
}
