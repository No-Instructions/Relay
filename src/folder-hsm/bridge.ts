/**
 * FolderDocBridge — the sole conduit between a shared folder's vault-facing
 * localDoc and provider-facing remoteDoc (specs/folder-hsm.md §The folder
 * doc split).
 *
 * Replication is semantic (per-key diff-and-apply), not verbatim update
 * forwarding, so selected keys can be held without blocking unrelated
 * traffic:
 *
 *  - inbound (remote→local): replicates freely, except keys the outbound
 *    delete policy currently holds — local intent outranks until resolved.
 *  - outbound (local→remote): sets replicate immediately; deletions route
 *    through the outbound delete policy (the delete collector). A bridge
 *    with no policy replicates deletions immediately.
 *
 * Replication preserves cross-map transaction atomicity: everything one
 * source transaction changed across the membership maps applies to the
 * other doc in a single transaction. A document entry committed to both
 * maps together must never be observable in one map without the other —
 * a transient meta-without-docs state wears the exact shape of an
 * old-client deletion and would tombstone the path (SyncStore.getMeta).
 *
 * The bridge owns doc convergence only. Disk safety stays with the
 * machine: bridge-applied inbound transactions land on the localDoc with
 * BRIDGE_IN_ORIGIN, are extracted as map deltas, and pass the machine's
 * evidence rules (P4) before any disk effect.
 */

import type * as Y from "yjs";
import { areObjectsEqual } from "../areObjectsEqual";

/** Origin of bridge-applied transactions on the localDoc (inbound). */
export const BRIDGE_IN_ORIGIN = "relay:folder-bridge-in";
/** Origin of bridge-applied transactions on the remoteDoc (outbound). */
export const BRIDGE_OUT_ORIGIN = "relay:folder-bridge-out";
/**
 * Origin of host-executed local map deletions on the localDoc. A string so
 * deletion capture persists it (specs/folder-hsm.md §Deletion capture and
 * undo); the machine's delta feed skips it like the host's own
 * transactions — these deletions are direct expressions of effects the
 * machine already accounted for.
 */
export const FOLDER_LOCAL_DELETE_ORIGIN = "relay:folder-local-delete";

/** The membership maps replicated between the folder docs. */
export const FOLDER_MAP_NAMES = ["filemeta_v0", "docs"] as const;
export type FolderMapName = (typeof FOLDER_MAP_NAMES)[number];

export interface OutboundDelete {
	mapName: FolderMapName;
	key: string;
	oldValue: unknown;
}

/** How attach-time divergence on one key resolves. */
export type DivergenceVerdict = "remote-wins" | "local-wins";

export interface FolderDocBridgeOptions {
	/**
	 * Outbound delete policy. Called synchronously with each batch of
	 * outbound deletions observed on the localDoc (one call per
	 * transaction). The policy later replicates via `replicateDeletes` or
	 * discards via captured-op reversal. Absent → deletions replicate
	 * immediately.
	 */
	onOutboundDeletes?: (deletes: OutboundDelete[]) => void;
	/**
	 * Outbound sets, notified after replication. The delete policy drops
	 * held deletions for re-asserted keys so a later `send` cannot delete a
	 * key the user has since re-created.
	 */
	onOutboundSets?: (sets: Array<{ mapName: FolderMapName; key: string }>) => void;
	/**
	 * Keys the policy currently holds. Inbound replication and attach
	 * reconciliation skip held keys — the divergence is the gate.
	 */
	isHeld?: (mapName: FolderMapName, key: string) => boolean;
	/**
	 * Reconciliation classified the folder as a publication (wholly-empty
	 * remote maps against non-empty local membership) and staged the
	 * membership outbound. Fired once per reconcile, after the staging
	 * transaction commits. The host re-uploads document content to the new
	 * relay's per-document rooms — membership alone leaves every doc an
	 * empty shell for joining peers.
	 */
	onPublication?: () => void;
	/**
	 * Attach-time divergence classifier (host-supplied, consults machine
	 * dispositions / pendingUpload / local records). Default: remote-wins.
	 */
	classifyDivergence?: (
		mapName: FolderMapName,
		key: string,
		localValue: unknown,
		remoteValue: unknown,
	) => DivergenceVerdict;
	/**
	 * localDoc transaction origins that are replay, not local intent —
	 * persistence loading stored state must not replicate outbound (the
	 * remote side converges through its own persistence and reconcile()).
	 */
	skipOutboundOrigin?: (origin: unknown) => boolean;
	/**
	 * remoteDoc transaction origins that are replay, not provider traffic —
	 * the remoteDoc's persistence snapshot can be stale (the localDoc's
	 * database also advances while the split is inactive), so replaying it
	 * must not overwrite the localDoc; reconcile() at provider sync is the
	 * convergence path.
	 */
	skipInboundOrigin?: (origin: unknown) => boolean;
}

function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a === "object" && typeof b === "object" && a && b) {
		return areObjectsEqual(a, b);
	}
	return false;
}

export class FolderDocBridge {
	private readonly maps: Array<{
		name: FolderMapName;
		local: Y.Map<unknown>;
		remote: Y.Map<unknown>;
	}>;
	private readonly outboundObservers: Array<{
		map: Y.Map<unknown>;
		fn: (event: Y.YMapEvent<unknown>) => void;
	}> = [];
	private readonly inboundObservers: Array<{
		map: Y.Map<unknown>;
		fn: (event: Y.YMapEvent<unknown>) => void;
	}> = [];
	// Per-map observers only collect; the flush handlers apply everything
	// one source transaction changed in ONE destination transaction. This
	// preserves cross-map atomicity: a document entry committed to both
	// membership maps together is never observable in one without the
	// other on the far side.
	private outboundSets: Array<{ mapName: FolderMapName; key: string }> = [];
	private outboundDeletes: OutboundDelete[] = [];
	private inboundChanges: Array<{
		mapName: FolderMapName;
		key: string;
		action: "delete" | "set";
	}> = [];
	private readonly flushOutboundFn: () => void;
	private readonly flushInboundFn: () => void;
	private destroyed = false;

	constructor(
		private readonly localDoc: Y.Doc,
		private readonly remoteDoc: Y.Doc,
		private readonly opts: FolderDocBridgeOptions = {},
	) {
		this.maps = FOLDER_MAP_NAMES.map((name) => ({
			name,
			local: localDoc.getMap<unknown>(name),
			remote: remoteDoc.getMap<unknown>(name),
		}));

		for (const entry of this.maps) {
			const outbound = (event: Y.YMapEvent<unknown>) => {
				if (event.transaction.origin === BRIDGE_IN_ORIGIN) return;
				if (this.opts.skipOutboundOrigin?.(event.transaction.origin)) return;
				event.changes.keys.forEach((change, key) => {
					if (change.action === "delete") {
						this.outboundDeletes.push({
							mapName: entry.name,
							key,
							oldValue: change.oldValue,
						});
					} else {
						this.outboundSets.push({ mapName: entry.name, key });
					}
				});
			};
			entry.local.observe(outbound);
			this.outboundObservers.push({ map: entry.local, fn: outbound });

			const inbound = (event: Y.YMapEvent<unknown>) => {
				if (event.transaction.origin === BRIDGE_OUT_ORIGIN) return;
				if (this.opts.skipInboundOrigin?.(event.transaction.origin)) return;
				event.changes.keys.forEach((change, key) => {
					if (this.isHeld(entry.name, key)) return;
					this.inboundChanges.push({
						mapName: entry.name,
						key,
						action: change.action === "delete" ? "delete" : "set",
					});
				});
			};
			entry.remote.observe(inbound);
			this.inboundObservers.push({ map: entry.remote, fn: inbound });
		}

		// Map observers run before afterTransaction, so each flush sees the
		// complete cross-map change set of the transaction that just ended.
		this.flushOutboundFn = () => this.flushOutbound();
		this.flushInboundFn = () => this.flushInbound();
		localDoc.on("afterTransaction", this.flushOutboundFn);
		remoteDoc.on("afterTransaction", this.flushInboundFn);
	}

	private isHeld(mapName: FolderMapName, key: string): boolean {
		return this.opts.isHeld?.(mapName, key) ?? false;
	}

	private mapEntry(mapName: FolderMapName) {
		return this.maps.find((m) => m.name === mapName)!;
	}

	private flushOutbound(): void {
		if (this.destroyed) {
			this.outboundSets.length = 0;
			this.outboundDeletes.length = 0;
			return;
		}
		if (this.outboundSets.length > 0) {
			const sets = this.outboundSets.splice(0);
			this.remoteDoc.transact(() => {
				for (const { mapName, key } of sets) {
					const entry = this.mapEntry(mapName);
					const value = entry.local.get(key);
					if (!valuesEqual(entry.remote.get(key), value)) {
						entry.remote.set(key, value);
					}
				}
			}, BRIDGE_OUT_ORIGIN);
			this.opts.onOutboundSets?.(sets);
		}
		if (this.outboundDeletes.length > 0) {
			const deletes = this.outboundDeletes.splice(0);
			if (this.opts.onOutboundDeletes) {
				this.opts.onOutboundDeletes(deletes);
			} else {
				this.replicateDeletes(deletes);
			}
		}
	}

	private flushInbound(): void {
		if (this.destroyed) {
			this.inboundChanges.length = 0;
			return;
		}
		if (this.inboundChanges.length === 0) return;
		const changes = this.inboundChanges.splice(0);
		this.localDoc.transact(() => {
			for (const { mapName, key, action } of changes) {
				const entry = this.mapEntry(mapName);
				if (action === "delete") {
					if (entry.local.has(key)) entry.local.delete(key);
				} else {
					const value = entry.remote.get(key);
					if (!valuesEqual(entry.local.get(key), value)) {
						entry.local.set(key, value);
					}
				}
			}
		}, BRIDGE_IN_ORIGIN);
	}

	/**
	 * Replicate held (or policy-free) deletions to the remoteDoc. Called by
	 * the delete collector on `replicate` evaluation or gate `send`.
	 */
	replicateDeletes(deletes: Array<{ mapName: FolderMapName; key: string }>): void {
		if (this.destroyed || deletes.length === 0) return;
		const byMap = new Map<FolderMapName, string[]>();
		for (const d of deletes) {
			let keys = byMap.get(d.mapName);
			if (!keys) byMap.set(d.mapName, (keys = []));
			keys.push(d.key);
		}
		this.remoteDoc.transact(() => {
			for (const [mapName, keys] of byMap) {
				const remote = this.maps.find((m) => m.name === mapName)!.remote;
				for (const key of keys) {
					if (remote.has(key)) remote.delete(key);
				}
			}
		}, BRIDGE_OUT_ORIGIN);
	}

	/**
	 * Attach-time reconciliation: converge divergent keys between the docs.
	 * Held keys are skipped — their divergence is the gate. Call after both
	 * docs' persistence has loaded and on provider re-sync.
	 */
	reconcile(): void {
		if (this.destroyed) return;
		// Verdicts are gathered across BOTH maps before either doc is
		// touched, then applied one transaction per direction — attach-time
		// convergence honors the same cross-map atomicity as replication.
		const toLocal: Array<{
			mapName: FolderMapName;
			key: string;
			action: "delete" | "set";
		}> = [];
		const toRemote: Array<{
			mapName: FolderMapName;
			key: string;
			action: "delete" | "set";
		}> = [];
		let publicationStaged = false;
		for (const entry of this.maps) {
			// A wholly-empty remote map against non-empty local membership is
			// a publication — initial share, re-share to a different relay,
			// server reset — never a mass deletion. Every key stages
			// outbound; the classifier only arbitrates genuine per-key
			// divergence between two populated replicas.
			const publication = entry.remote.size === 0 && entry.local.size > 0;
			if (publication) publicationStaged = true;
			const keys = new Set<string>([
				...entry.local.keys(),
				...entry.remote.keys(),
			]);
			for (const key of keys) {
				if (this.isHeld(entry.name, key)) continue;
				const l = entry.local.get(key);
				const r = entry.remote.get(key);
				const lHas = entry.local.has(key);
				const rHas = entry.remote.has(key);
				if (lHas === rHas && valuesEqual(l, r)) continue;
				if (lHas && rHas && valuesEqual(l, r)) continue;
				const verdict = publication
					? "local-wins"
					: (this.opts.classifyDivergence?.(entry.name, key, l, r) ??
						"remote-wins");
				if (verdict === "local-wins") {
					toRemote.push({
						mapName: entry.name,
						key,
						action: lHas ? "set" : "delete",
					});
				} else {
					toLocal.push({
						mapName: entry.name,
						key,
						action: rHas ? "set" : "delete",
					});
				}
			}
		}
		if (toRemote.length > 0) {
			this.remoteDoc.transact(() => {
				for (const { mapName, key, action } of toRemote) {
					const entry = this.mapEntry(mapName);
					if (action === "set") {
						entry.remote.set(key, entry.local.get(key));
					} else if (entry.remote.has(key)) {
						entry.remote.delete(key);
					}
				}
			}, BRIDGE_OUT_ORIGIN);
			if (publicationStaged) {
				this.opts.onPublication?.();
			}
		}
		if (toLocal.length > 0) {
			this.localDoc.transact(() => {
				for (const { mapName, key, action } of toLocal) {
					const entry = this.mapEntry(mapName);
					if (action === "set") {
						entry.local.set(key, entry.remote.get(key));
					} else if (entry.local.has(key)) {
						entry.local.delete(key);
					}
				}
			}, BRIDGE_IN_ORIGIN);
		}
	}

	/**
	 * Re-apply the remoteDoc's current state for specific keys onto the
	 * localDoc (used when discarding held deletions whose captured ops are
	 * unavailable). Reversal via OpCapture is preferred; this is the
	 * fallback convergence path.
	 */
	refreshFromRemote(refs: Array<{ mapName: FolderMapName; key: string }>): void {
		if (this.destroyed || refs.length === 0) return;
		this.localDoc.transact(() => {
			for (const { mapName, key } of refs) {
				const entry = this.maps.find((m) => m.name === mapName)!;
				if (entry.remote.has(key)) {
					// Re-assert unconditionally, even when the local entry already
					// equals remote. Restore runs against the post-reload gated
					// state, where the split localDoc was rebuilt from remote (so
					// the map entry is already present) while the on-disk copy
					// stayed removed. A value-equality skip would emit no delta and
					// the machine would never re-materialize the file. The re-set
					// carries BRIDGE_IN_ORIGIN, which the outbound observer ignores,
					// so it drives inbound re-materialization without map churn.
					entry.local.set(key, entry.remote.get(key));
				} else if (entry.local.has(key)) {
					entry.local.delete(key);
				}
			}
		}, BRIDGE_IN_ORIGIN);
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const { map, fn } of this.outboundObservers) map.unobserve(fn);
		for (const { map, fn } of this.inboundObservers) map.unobserve(fn);
		this.outboundObservers.length = 0;
		this.inboundObservers.length = 0;
		this.localDoc.off("afterTransaction", this.flushOutboundFn);
		this.remoteDoc.off("afterTransaction", this.flushInboundFn);
		this.outboundSets.length = 0;
		this.outboundDeletes.length = 0;
		this.inboundChanges.length = 0;
	}
}
