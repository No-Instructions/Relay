/**
 * Native-tombstone query over Yjs Y.Map internals.
 *
 * Yjs keeps deleted map keys in the type's internal `_map` with
 * `deleted === true`; the deleted *value* is garbage-collected under
 * `gc: true`, but the path-keyed deleted flag rides every update,
 * including full-state hydration into a fresh doc.
 *
 * This helper is the single sanctioned access point to that internal,
 * so a Yjs upgrade that changes `_map` semantics fails loudly in one
 * tested place.
 */

import type * as Y from "yjs";
import { isDeletedMeta } from "../SyncTypes";

interface InternalMapItem {
	deleted: boolean;
}

/**
 * True when `path` was present in the map at some point and its most
 * recent entry is a deletion. Returns false for never-present paths,
 * currently-present paths, and paths that were deleted but re-added.
 *
 * Durable deletion markers are consulted first: a live entry asserting
 * deletion is ordinary state and rides every handshake, whereas the
 * native tombstone below is delete-set arithmetic — a delete-set entry
 * that arrives without its struct is silently unactionable on a peer
 * that never held the key, and the key then reads "never present".
 */
export function pathWasDeleted<T>(
	map: Y.Map<T>,
	path: string,
): boolean {
	if (isDeletedMeta(map.get(path))) {
		return true;
	}
	const internalMap = (map as unknown as { _map?: Map<string, InternalMapItem> })
		._map;
	if (!(internalMap instanceof Map)) {
		throw new Error(
			"pathWasDeleted: Y.Map no longer exposes a `_map` Map — a Yjs upgrade changed internals; re-derive the tombstone query",
		);
	}
	const item = internalMap.get(path);
	if (item === undefined) {
		return false; // never present
	}
	if (typeof item.deleted !== "boolean") {
		throw new Error(
			"pathWasDeleted: Y.Map internal item no longer exposes a boolean `deleted` flag — a Yjs upgrade changed internals; re-derive the tombstone query",
		);
	}
	return item.deleted;
}
