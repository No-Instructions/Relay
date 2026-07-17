/**
 * CanvasDocBridge — the sole conduit between a canvas's vault-facing
 * localDoc and its provider-facing remoteDoc.
 *
 * Replication is verbatim update forwarding (unlike the folder bridge's
 * per-key semantic replication): canvas docs carry dynamically created
 * per-node Y.Text types alongside the node and edge maps, and there is no
 * outbound hold policy yet, so raw CRDT convergence is both sufficient
 * and exact. Yjs buffers updates whose causal prerequisites have not
 * arrived, so forwarding is order-safe in both directions.
 *
 * Persistence replay is excluded outbound: the localDoc's IDB replay is
 * not local intent, and the remoteDoc converges from the server through
 * the provider plus `reconcile()` at provider sync. The remoteDoc is
 * ephemeral — the server is its source of truth — so there is no inbound
 * replay to exclude, but the hook exists for symmetry and tests.
 *
 * The bridge owns doc convergence only. Disk safety stays with the
 * machine: bridge-applied inbound transactions land on the localDoc with
 * CANVAS_BRIDGE_IN_ORIGIN, which the host reports as LOCAL_DOC_CHANGED so
 * the machine re-evaluates before any disk effect.
 */

import * as Y from "yjs";

/** Origin of bridge-applied transactions on the localDoc (inbound). */
export const CANVAS_BRIDGE_IN_ORIGIN = "relay:canvas-bridge-in";
/** Origin of bridge-applied transactions on the remoteDoc (outbound). */
export const CANVAS_BRIDGE_OUT_ORIGIN = "relay:canvas-bridge-out";

export interface CanvasDocBridgeOptions {
	/**
	 * localDoc transaction origins that are replay, not local intent —
	 * persistence loading stored state must not replicate outbound; the
	 * remote side converges through the provider and reconcile().
	 */
	skipOutboundOrigin?: (origin: unknown) => boolean;
	/** remoteDoc transaction origins that must not replicate inbound. */
	skipInboundOrigin?: (origin: unknown) => boolean;
}

export class CanvasDocBridge {
	private destroyed = false;
	private _localOnly = false;
	private readonly outboundFn: (
		update: Uint8Array,
		origin: unknown,
	) => void;
	private readonly inboundFn: (update: Uint8Array, origin: unknown) => void;

	constructor(
		private readonly localDoc: Y.Doc,
		private readonly remoteDoc: Y.Doc,
		private readonly opts: CanvasDocBridgeOptions = {},
	) {
		this.outboundFn = (update, origin) => {
			if (this.destroyed || this._localOnly) return;
			if (origin === CANVAS_BRIDGE_IN_ORIGIN) return;
			if (this.opts.skipOutboundOrigin?.(origin)) return;
			Y.applyUpdate(this.remoteDoc, update, CANVAS_BRIDGE_OUT_ORIGIN);
		};
		this.inboundFn = (update, origin) => {
			if (this.destroyed || this._localOnly) return;
			if (origin === CANVAS_BRIDGE_OUT_ORIGIN) return;
			if (this.opts.skipInboundOrigin?.(origin)) return;
			Y.applyUpdate(this.localDoc, update, CANVAS_BRIDGE_IN_ORIGIN);
		};
		localDoc.on("update", this.outboundFn);
		remoteDoc.on("update", this.inboundFn);
	}

	get isLocalOnly(): boolean {
		return this._localOnly;
	}

	/**
	 * Local-only mode gates the bridge in both directions — the canvas
	 * edits and flushes normally, but nothing replicates. Clearing the
	 * mode reconciles: the state-vector diff converges everything that
	 * accumulated on either side, the same mechanism as offline catch-up.
	 */
	setLocalOnly(value: boolean): void {
		if (this._localOnly === value) return;
		this._localOnly = value;
		if (!value) {
			this.reconcile();
		}
	}

	/**
	 * State-vector-diff convergence in both directions. Call after the
	 * localDoc's persistence has loaded and on every provider sync — live
	 * forwarding covers everything that happens while both docs are wired,
	 * and reconcile covers everything that happened while they were not.
	 */
	reconcile(): void {
		if (this.destroyed || this._localOnly) return;
		const toLocal = Y.encodeStateAsUpdate(
			this.remoteDoc,
			Y.encodeStateVector(this.localDoc),
		);
		if (toLocal.length > 2) {
			Y.applyUpdate(this.localDoc, toLocal, CANVAS_BRIDGE_IN_ORIGIN);
		}
		const toRemote = Y.encodeStateAsUpdate(
			this.localDoc,
			Y.encodeStateVector(this.remoteDoc),
		);
		if (toRemote.length > 2) {
			Y.applyUpdate(this.remoteDoc, toRemote, CANVAS_BRIDGE_OUT_ORIGIN);
		}
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.localDoc.off("update", this.outboundFn);
		this.remoteDoc.off("update", this.inboundFn);
	}
}
