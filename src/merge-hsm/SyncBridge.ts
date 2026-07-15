/**
 * SyncBridge - Manages CRDT op flow between localDoc and remoteDoc.
 *
 * Owns the inbound/outbound queues, the SyncGate, and the flush/sync
 * chokepoints. MergeHSM delegates all cross-doc traffic through this class.
 *
 * The bridge calls back into the host (MergeHSM) only for:
 * - Y.Doc references (localDoc/remoteDoc)
 * - Effect emission (SYNC_TO_REMOTE, DISPATCH_CM6)
 * - Machine-edit state (pending edits, OpCapture)
 * - Fork state (gates outbound sync)
 * - State change notification (for localOnly counter display)
 */

import * as Y from "yjs";
import type { SyncGate, MergeEffect, PositionedChange } from "./types";
import type { OpCapture } from "./undo";
import { snapshotFromDoc, snapshotsEqual, yjsDocsEqual } from "./state-vectors";
import { curryLog } from "../debug";
import type { PendingMachineEdit } from "./machine-edits";

const bridgeError = curryLog("[SyncBridge]", "error");

// =============================================================================
// Host Interface
// =============================================================================

/**
 * Callback interface that SyncBridge uses to access HSM-owned state.
 * MergeHSM implements this interface and passes itself to the bridge.
 */
export interface SyncBridgeHost {
	/** Current localDoc (null when unloaded/hibernated) */
	getLocalDoc(): Y.Doc | null;
	/** Current remoteDoc (null when hibernated) */
	getRemoteDoc(): Y.Doc | null;
	/** Whether a fork is active (gates outbound sync) */
	hasFork(): boolean;
	/** Emit an effect to subscribers */
	emitEffect(effect: MergeEffect): void;
	/** Emit state change notification (for pending counter display) */
	emitStateChange(): void;
	/** Get the OpCapture instance from persistence */
	getOpCapture(): OpCapture | null;
	/** Pending machine edits awaiting remote match */
	getPendingMachineEdits(): ReadonlyArray<PendingMachineEdit>;
	/** OpCapture entries owned by exactly one pending machine edit. */
	getMachineEditOps(entry: PendingMachineEdit): ReturnType<OpCapture["since"]>;
	/** Find a pending machine edit matched by remoteText */
	matchMachineEdit(remoteText: string): PendingMachineEdit | null;
	/** Whether a captured callback has not supplied its structural diff yet. */
	hasPreparingMachineEdit?(): boolean;
	/** Remember an origin update that arrived before the local CM6 echo. */
	markMachineEditRemoteMatched?(entry: PendingMachineEdit): void;
	/** Remove a matched machine edit registration */
	removeMachineEdit(entry: PendingMachineEdit): void;
	/** Compute positioned diff changes between two strings */
	computeDiffChanges(from: string, to: string): PositionedChange[];
	/** Apply positioned changes to the local doc's contents Y.Text */
	applyChangesToLocalDoc(changes: PositionedChange[]): void;
	/** GUID for logging */
	readonly guid: string;
	/** Current path for logging */
	readonly path: string;
	/** Whether the local observer is suppressed (during rewind) */
	isSuppressLocalObserver(): boolean;
	/** Set suppress local observer flag */
	setSuppressLocalObserver(value: boolean): void;
}

// =============================================================================
// Outbound Queue Entry
// =============================================================================

export interface OutboundEntry {
	update: Uint8Array;
	machineEditMark: number | null;
	/** Exact captured-lane owner; marks alone can collide before either lane emits ops. */
	machineEditId: number | null;
}

// =============================================================================
// SyncBridge Class
// =============================================================================

export class SyncBridge {
	/** Controls CRDT op flow between localDoc and remoteDoc */
	private _syncGate: SyncGate = {
		providerSynced: false,
		localOnly: false,
		pendingInbound: 0,
		pendingOutbound: 0,
	};

	/** Outbound update queue (local -> remote) */
	private _outboundQueue: OutboundEntry[] = [];

	/** Inbound update queue (remote -> local) */
	private _inboundQueue: Uint8Array[] = [];

	/** Listener on localDoc 'update' events */
	private _localDocUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;

	/** Listener on remoteDoc 'update' events */
	private _remoteDocUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;

	/** Current machine edit mark for tagging outbound queue entries */
	private _currentMachineEditMark: number | null = null;
	private _currentMachineEditId: number | null = null;

	/**
	 * Machine-edit marks whose deferred ops have been published to the server
	 * (via flushPendingMachineEditOutbound) while their rewind guard is still
	 * armed. A published insert is held by peers, so its echo-match must NOT
	 * cancel()+republish-delete it (that tombstones the run another peer adopted
	 * as its survivor). These marks take the publish-aware reconcile path in
	 * flushInbound instead.
	 */
	private _publishedMachineEditMarks: Set<number> = new Set();

	constructor(private readonly host: SyncBridgeHost) {}

	// =========================================================================
	// SyncGate Accessors
	// =========================================================================

	get syncGate(): SyncGate {
		return this._syncGate;
	}

	get pendingInbound(): number {
		return this._syncGate.pendingInbound;
	}

	get pendingOutbound(): number {
		return this._syncGate.pendingOutbound;
	}

	get isLocalOnly(): boolean {
		return this._syncGate.localOnly;
	}

	set providerSynced(value: boolean) {
		this._syncGate.providerSynced = value;
	}

	get providerSynced(): boolean {
		return this._syncGate.providerSynced;
	}

	setLocalOnly(value: boolean): void {
		if (this._syncGate.localOnly === value) return;
		this._syncGate.localOnly = value;

		if (!value && !this.host.hasFork() && this.host.getLocalDoc() && this.host.getRemoteDoc()) {
			this.flush();
			this._syncGate.pendingInbound = 0;
			this._syncGate.pendingOutbound = 0;
		}
	}

	resetPendingCounters(): void {
		this._syncGate.pendingInbound = 0;
		this._syncGate.pendingOutbound = 0;
	}

	// =========================================================================
	// Queue Management
	// =========================================================================

	get currentMachineEditMark(): number | null {
		return this._currentMachineEditMark;
	}

	set currentMachineEditMark(value: number | null) {
		this._currentMachineEditMark = value;
	}

	get currentMachineEditId(): number | null {
		return this._currentMachineEditId;
	}

	set currentMachineEditId(value: number | null) {
		this._currentMachineEditId = value;
	}

	get outboundQueue(): OutboundEntry[] {
		return this._outboundQueue;
	}

	get hasLocalDocUpdateHandler(): boolean {
		return this._localDocUpdateHandler !== null;
	}

	get hasRemoteDocUpdateHandler(): boolean {
		return this._remoteDocUpdateHandler !== null;
	}

	clearOutboundQueue(): void {
		this._outboundQueue = [];
	}

	clearInboundQueue(): void {
		this._inboundQueue = [];
	}

	/** Remove only the outbound updates owned by one pending machine edit. */
	discardOutboundForMachineEdit(entry: PendingMachineEdit): void {
		this._outboundQueue = this._outboundQueue.filter(
			(outbound) => !this.isOutboundForMachineEdit(outbound, entry),
		);
	}

	private isOutboundForMachineEdit(
		outbound: OutboundEntry,
		entry: PendingMachineEdit,
	): boolean {
		return entry.kind === "captured"
			? outbound.machineEditId === entry.id
			: outbound.machineEditId === null &&
				outbound.machineEditMark === entry.captureMark;
	}

	/**
	 * Install Y.Doc 'update' listeners that buffer individual transaction
	 * updates into outbound/inbound queues. The outbound queue tags entries
	 * with a machine-edit mark so flushOutbound() can defer them while their
	 * registrations are pending.
	 */
	setupUpdateQueues(): void {
		const localDoc = this.host.getLocalDoc();
		const remoteDoc = this.host.getRemoteDoc();

		if (localDoc && !this._localDocUpdateHandler) {
			this._localDocUpdateHandler = (update: Uint8Array, origin: unknown) => {
				if (origin === remoteDoc) return;              // inbound echo
				if (this.host.isSuppressLocalObserver()) return; // rewind ops
				this._outboundQueue.push({
					update,
					machineEditMark: this._currentMachineEditMark,
					machineEditId: this._currentMachineEditId,
				});
			};
			localDoc.on('update', this._localDocUpdateHandler);
		}

		if (remoteDoc && !this._remoteDocUpdateHandler) {
			this._remoteDocUpdateHandler = (update: Uint8Array, origin: unknown) => {
				if (origin === this.host) return;              // outbound echo
				this._inboundQueue.push(update);
			};
			remoteDoc.on('update', this._remoteDocUpdateHandler);
		}
	}

	/**
	 * Remove update listeners and clear queues (editor deactivation).
	 */
	teardownUpdateQueues(): void {
		const localDoc = this.host.getLocalDoc();
		const remoteDoc = this.host.getRemoteDoc();

		if (localDoc && this._localDocUpdateHandler) {
			localDoc.off('update', this._localDocUpdateHandler);
			this._localDocUpdateHandler = null;
		}
		if (remoteDoc && this._remoteDocUpdateHandler) {
			remoteDoc.off('update', this._remoteDocUpdateHandler);
			this._remoteDocUpdateHandler = null;
		}
		this._outboundQueue = [];
		this._inboundQueue = [];
		this._publishedMachineEditMarks.clear();
	}

	/**
	 * Re-wire the inbound handler to the current remoteDoc.
	 * Called when remoteDoc is replaced (e.g., provider reconnect) so the
	 * inbound queue captures updates from the new doc instead of the old one.
	 */
	rewireRemoteDoc(): void {
		// Detach from any previous remoteDoc (we don't have a reference to it,
		// but nulling the handler prevents double-install in setupUpdateQueues)
		if (this._remoteDocUpdateHandler) {
			// The old handler is orphaned on the old doc — Y.Doc.destroy()
			// or GC will clean it up. We can't detach it here because we
			// don't have a reference to the old doc.
			this._remoteDocUpdateHandler = null;
		}
		// Clear stale inbound entries from the old doc
		this._inboundQueue = [];

		// Re-install on the new remoteDoc
		const remoteDoc = this.host.getRemoteDoc();
		if (remoteDoc) {
			this._remoteDocUpdateHandler = (update: Uint8Array, origin: unknown) => {
				if (origin === this.host) return;              // outbound echo
				this._inboundQueue.push(update);
			};
			remoteDoc.on('update', this._remoteDocUpdateHandler);
		}
	}

	/**
	 * Capture and null handler references for async cleanup (destroyLocalDoc).
	 * Returns the captured handlers so the caller can detach them from
	 * potentially-replaced doc instances.
	 */
	detachHandlers(): {
		localUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null;
		remoteUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null;
	} {
		const localUpdateHandler = this._localDocUpdateHandler;
		const remoteUpdateHandler = this._remoteDocUpdateHandler;
		this._localDocUpdateHandler = null;
		this._remoteDocUpdateHandler = null;
		this._outboundQueue = [];
		this._inboundQueue = [];
		this._publishedMachineEditMarks.clear();
		return { localUpdateHandler, remoteUpdateHandler };
	}

	// =========================================================================
	// Sync Chokepoints
	// =========================================================================

	/**
	 * Apply an outbound update (from localDoc) to remoteDoc.
	 * This is the ONLY method that should apply local ops to remoteDoc.
	 */
	syncToRemote(update: Uint8Array): void {
		const remoteDoc = this.host.getRemoteDoc();
		if (!remoteDoc) {
			bridgeError("syncToRemote called but remoteDoc is null");
			return;
		}
		Y.applyUpdate(remoteDoc, update, this.host);
		this.host.emitEffect({ type: "SYNC_TO_REMOTE", update });
	}

	/** Publish the complete local state and mark every captured op as visible. */
	syncFullStateToRemote(): void {
		const localDoc = this.host.getLocalDoc();
		if (!localDoc || !this.host.getRemoteDoc()) return;
		this.syncToRemote(Y.encodeStateAsUpdate(localDoc));
		this.host.getOpCapture()?.notifySynced();
	}

	/**
	 * Apply an inbound update (from remoteDoc) to localDoc.
	 * This is the ONLY method that should apply remote ops to localDoc.
	 */
	syncToLocal(update: Uint8Array): void {
		const localDoc = this.host.getLocalDoc();
		const remoteDoc = this.host.getRemoteDoc();
		if (!localDoc) return;
		Y.applyUpdate(localDoc, update, remoteDoc);
	}

	/**
	 * Drain both inbound and outbound queues, then assert convergence.
	 * Callers that need bidirectional sync should use this instead of
	 * calling flushInbound + flushOutbound separately.
	 */
	flush(): void {
		this.flushInbound();
		this.flushOutbound();
		this.assertStateVectorConvergence();
	}

	/**
	 * Flush outbound queue: send buffered local updates to remoteDoc.
	 *
	 * When the update listener is active, partitions the queue: entries tagged
	 * with a pending machine-edit mark are deferred (the remote hasn't matched
	 * yet), everything else is merged and applied. notifySynced() is only called
	 * when nothing is deferred -- machine-edit ops must stay cancellable.
	 *
	 * Falls back to a full state diff when the listener isn't installed yet
	 * (loading/idle phases).
	 *
	 * Does NOT assert state-vector convergence -- callers that need a
	 * bidirectional sync with convergence verification should use flush().
	 * One-directional callers (applyCM6ToLocalDoc, flushPendingToRemote,
	 * conflict resolution) intentionally skip the assertion because the
	 * inbound direction may not have been drained yet.
	 */
	flushOutbound(): void {
		const localDoc = this.host.getLocalDoc();
		const remoteDoc = this.host.getRemoteDoc();
		if (!localDoc || !remoteDoc) return;

		if (this.host.hasFork()) {
			this._syncGate.pendingOutbound++;
			return;
		}

		if (this._syncGate.localOnly) {
			this._syncGate.pendingOutbound++;
			this.host.emitStateChange();
			return;
		}

		// Queue path (active editing -- listener installed)
		if (this._localDocUpdateHandler) {
			const pendingCapturedIds = new Set(
				this.host
					.getPendingMachineEdits()
					.flatMap((entry) => entry.kind === "captured" ? [entry.id] : []),
			);
			const pendingLegacyMarks = new Set(
				this.host
					.getPendingMachineEdits()
					.flatMap((entry) => entry.kind === "captured" ? [] : [entry.captureMark]),
			);
			const toSend: Uint8Array[] = [];
			const toDefer: OutboundEntry[] = [];

			for (const entry of this._outboundQueue) {
				const isPendingMachineEdit = entry.machineEditId !== null
					? pendingCapturedIds.has(entry.machineEditId)
					: entry.machineEditMark !== null &&
						pendingLegacyMarks.has(entry.machineEditMark);
				if (isPendingMachineEdit) {
					toDefer.push(entry);
				} else {
					toSend.push(entry.update);
				}
			}
			this._outboundQueue = toDefer;

			if (toSend.length > 0) {
				const merged = Y.mergeUpdates(toSend);
				this.syncToRemote(merged);
				// Only mark synced when nothing is deferred -- machine-edit
				// entries must stay cancellable until matched/expired.
				if (toDefer.length === 0) {
					this.host.getOpCapture()?.notifySynced();
				}
			} else if (toDefer.length === 0) {
				// Queue was empty and nothing deferred: check for a state diff
				// that predates handler installation (e.g. IDB content loaded before
				// the queue listener was attached).
				const localText = localDoc.getText("contents").toString();
				const remoteText = remoteDoc.getText("contents").toString();
				if (localText !== remoteText) {
					const catchUp = Y.encodeStateAsUpdate(
						localDoc,
						Y.encodeStateVector(remoteDoc),
					);
					this.syncToRemote(catchUp);
					this.host.getOpCapture()?.notifySynced();
				}
			}

			// Safety net: sync any localDoc state not yet in remoteDoc.
			// After queue drain this should be a no-op (unless machine-edit
			// entries are deferred). If it fires, an update was applied to
			// localDoc without being queued for outbound sync.
			if (toDefer.length === 0) {
				const svBefore = Y.encodeStateVector(remoteDoc);
				const catchUp = Y.encodeStateAsUpdate(localDoc, svBefore);
				if (catchUp.length > 2) { // Empty YJS update is 2 bytes
					const remoteText = remoteDoc.getText("contents").toString();
					const localText = localDoc.getText("contents").toString();
					this.host.emitEffect({
						type: "DIAGNOSTIC",
						code: "OUTBOUND_INTEGRITY",
						message: `flushOutbound safety net fired — update bypassed queue`,
						detail: {
							updateBytes: catchUp.length,
							queueLength: toSend.length,
							changes: this.host.computeDiffChanges(remoteText, localText),
						},
					});
					this.syncToRemote(catchUp);
				}
			}
			return;
		}

		// Fallback: full state diff (loading, idle -- before listener installed)
		const hasDeferredCapturedEdit = this.host
			.getPendingMachineEdits()
			.some(
				(entry) =>
					entry.kind === "captured" &&
					entry.authority !== "local-origin",
			);
		if (hasDeferredCapturedEdit) {
			this._syncGate.pendingOutbound++;
			return;
		}
		const update = Y.encodeStateAsUpdate(
			localDoc,
			Y.encodeStateVector(remoteDoc),
		);
		if (update.length > 0) {
			this.syncToRemote(update);
			this.host.getOpCapture()?.notifySynced();
		}
	}

	/**
	 * Publish deferred machine-edit ops without clearing their rewind guards.
	 * Release cleanup uses this so peers can echo matching CRDT ops while the
	 * local OpCapture context is still available to cancel duplicates.
	 */
	flushPendingMachineEditOutbound(): void {
		const localDoc = this.host.getLocalDoc();
		const remoteDoc = this.host.getRemoteDoc();
		if (!localDoc || !remoteDoc) return;
		if (this.host.hasFork() || this._syncGate.localOnly) return;
		if (!this._localDocUpdateHandler) return;

		const pendingMarks = new Set(
			this.host
				.getPendingMachineEdits()
				.filter((entry) => entry.kind !== "captured")
				.map((entry) => entry.captureMark),
		);
		if (pendingMarks.size === 0) return;

		const toSend: Uint8Array[] = [];
		const remaining: OutboundEntry[] = [];
		const publishedMarks: number[] = [];
		for (const entry of this._outboundQueue) {
			if (
				entry.machineEditId === null &&
				entry.machineEditMark !== null &&
				pendingMarks.has(entry.machineEditMark)
			) {
				toSend.push(entry.update);
				publishedMarks.push(entry.machineEditMark);
			} else {
				remaining.push(entry);
			}
		}
		this._outboundQueue = remaining;

		if (toSend.length > 0) {
			// Record that these marks' inserts are now server-visible with the
			// rewind guard still armed. Their echo-match reconciles instead of
			// cancelling (see flushInbound).
			for (const mark of publishedMarks) this._publishedMachineEditMarks.add(mark);
			this.syncToRemote(Y.mergeUpdates(toSend));
		}
	}

	/** Publish every remaining local delta and record all included captured ops. */
	private publishReconcileTail(localDoc: Y.Doc, remoteDoc: Y.Doc): void {
		const outbound = Y.encodeStateAsUpdate(
			localDoc,
			Y.encodeStateVector(remoteDoc),
		);
		this._outboundQueue = [];
		if (outbound.length > 2) {
			this.syncToRemote(outbound);
			this.host.getOpCapture()?.notifySynced();
		}
	}

	/**
	 * Flush inbound queue: apply buffered remote updates to localDoc.
	 *
	 * Handles machine-edit matching first: if the remote already has a pending
	 * machine edit applied, cancel our local ops, discard matched outbound
	 * entries, and apply the remote version. Otherwise drains the inbound queue
	 * (merging updates) or falls back to a full state diff.
	 */
	flushInbound(): void {
		const localDoc = this.host.getLocalDoc();
		const remoteDoc = this.host.getRemoteDoc();
		if (!localDoc || !remoteDoc) return;

		if (this.host.hasFork()) {
			this._syncGate.pendingInbound++;
			return;
		}

		if (this._syncGate.localOnly) {
			this._syncGate.pendingInbound++;
			this.host.emitStateChange();
			return;
		}

		// The callback invocation is the only source of structural identity.
		// Hold the short preparation window rather than guessing from text.
		if (this.host.hasPreparingMachineEdit?.()) {
			this._syncGate.pendingInbound++;
			return;
		}

		const remoteText = remoteDoc.getText("contents").toString();

		// Check for machine edit match -- if the remote already has this
		// transform applied, rewind our local ops and apply remote instead
		const match = this.host.matchMachineEdit(remoteText);
		if (match) {
			const opCapture = this.host.getOpCapture();
			const machineOps = opCapture
				? this.host.getMachineEditOps(match)
				: [];

			// A full-state or catch-up publish can expose a captured candidate
			// before its echo arrives. Synced entries cannot be cancel()'d; adopt
			// the already-published remote state and release their tracking.
			if (
				match.kind === "captured" &&
				opCapture &&
				machineOps.length > 0 &&
				!opCapture.canCancel(machineOps)
			) {
				const beforeText = localDoc.getText("contents").toString();
				this.host.setSuppressLocalObserver(true);
				try {
					const adopt = Y.encodeStateAsUpdate(
						remoteDoc,
						Y.encodeStateVector(localDoc),
					);
					this.syncToLocal(adopt);
				} finally {
					this.host.setSuppressLocalObserver(false);
				}

				this._inboundQueue = [];
				opCapture.drop(machineOps);

				const afterText = localDoc.getText("contents").toString();
				if (beforeText !== afterText) {
					const changes = this.host.computeDiffChanges(beforeText, afterText);
					if (changes.length > 0) {
						this.host.emitEffect({ type: "DISPATCH_CM6", changes });
					}
				}

				this.host.removeMachineEdit(match);
				this.publishReconcileTail(localDoc, remoteDoc);
				this.assertStateVectorConvergence();
				return;
			}

			// Publish-aware reconcile. Once flushPendingMachineEditOutbound has
			// published this insert, a peer holds it: cancel()+republish-delete
			// would tombstone the run that peer adopted as its survivor, and the
			// symmetric case tombstones BOTH runs (the empty-middle divergence).
			// Instead, adopt the remote and converge to a single repair by
			// deleting the surplus duplicate down to expectedText. Every peer
			// computes the identical reduction over the identical shared CRDT, so
			// all peers delete the same loser run(s) and keep one survivor.
			if (
				match.kind !== "captured" &&
				this._publishedMachineEditMarks.has(match.captureMark)
			) {
				const beforeText = localDoc.getText("contents").toString();

				this.host.setSuppressLocalObserver(true);
				try {
					// Adopt the remote state (brings in the peer's insert).
					const adopt = Y.encodeStateAsUpdate(
						remoteDoc,
						Y.encodeStateVector(localDoc),
					);
					this.syncToLocal(adopt);

					// Reduce to the single-repair expected text: a normal,
					// published-safe delete of the surplus duplicate run.
					const dupText = localDoc.getText("contents").toString();
					if (dupText !== match.expectedText) {
						const reduction = this.host.computeDiffChanges(
							dupText,
							match.expectedText,
						);
						if (reduction.length > 0) {
							this.host.applyChangesToLocalDoc(reduction);
						}
					}
				} finally {
					this.host.setSuppressLocalObserver(false);
				}

				this._inboundQueue = [];

				const afterText = localDoc.getText("contents").toString();
				if (beforeText !== afterText) {
					const changes = this.host.computeDiffChanges(beforeText, afterText);
					if (changes.length > 0) {
						this.host.emitEffect({ type: "DISPATCH_CM6", changes });
					}
				}

				// Remove the registration so this mark can never re-match. The
				// published ops stay in OpCapture (never cancel()'d) and are
				// released when the editor queues tear down; no other path
				// references this mark.
				this.host.removeMachineEdit(match);
				this._publishedMachineEditMarks.delete(match.captureMark);

				this.publishReconcileTail(localDoc, remoteDoc);
				this.assertStateVectorConvergence();
				return;
			}

			if (opCapture) {
				if (machineOps.length > 0 && opCapture.canCancel(machineOps)) {
					const beforeText = localDoc.getText("contents").toString();

					// Suppress observer during rewind to avoid spurious DISPATCH_CM6
					this.host.setSuppressLocalObserver(true);
					try {
						// Cancel our machine edit ops: truly undo the CRDT ops
						// so the document state is as if they never happened.
						// Safe because the deferred insert was never published --
						// no peer has seen these ops (published edits reconcile
						// via the branch above).
						opCapture.cancel(machineOps);

						// Apply remote CRDT update -- fills in the same edits cleanly
						const update = Y.encodeStateAsUpdate(
							remoteDoc,
							Y.encodeStateVector(localDoc),
						);
						this.syncToLocal(update);
					} finally {
						this.host.setSuppressLocalObserver(false);
					}

					// Clear inbound queue -- remote state fully applied
					this._inboundQueue = [];

					// Discard matched entry's deferred outbound updates
					this.discardOutboundForMachineEdit(match);

					// Compute net diff and dispatch to editor (usually empty)
					const afterText = localDoc.getText("contents").toString();
					if (beforeText !== afterText) {
						const changes = this.host.computeDiffChanges(beforeText, afterText);
						if (changes.length > 0) {
							this.host.emitEffect({ type: "DISPATCH_CM6", changes });
						}
					}

					// Remove the matched registration
					this.host.removeMachineEdit(match);

					// Drain remaining user edits + cancel-op metadata in
					// one shot. Full-state diff covers both the SV entries
					// from the cancel and any queued user edits.
					this.publishReconcileTail(localDoc, remoteDoc);
					this.assertStateVectorConvergence();
					return;
				}
			}

			// A structural origin update can beat the local CM6 echo. Adopt it but
			// retain the registration so the later positional editor transaction is
			// recognized and suppressed without a second CRDT operation.
			if (match.kind === "captured") {
				if (this.host.markMachineEditRemoteMatched) {
					this.host.markMachineEditRemoteMatched(match);
				} else {
					this.host.removeMachineEdit(match);
				}
			} else {
				this.host.removeMachineEdit(match);
			}
		}

		// Drain buffered inbound updates.
		if (this._inboundQueue.length > 0) {
			const merged = Y.mergeUpdates(this._inboundQueue);
			this._inboundQueue = [];
			this.syncToLocal(merged);
		}

		// Safety net: apply any remoteDoc state not yet in localDoc.
		// After queue drain this should be a no-op. If it isn't, an update
		// slipped past the queue — log an error so we can track it down.
		const snapshotBefore = snapshotFromDoc(localDoc);
		const localTextBefore = localDoc.getText("contents").toString();
		const svBefore = Y.encodeStateVector(localDoc);
		const update = Y.encodeStateAsUpdate(remoteDoc, svBefore);
		this.syncToLocal(update);
		if (!snapshotsEqual(snapshotBefore, snapshotFromDoc(localDoc))) {
			const localTextAfter = localDoc.getText("contents").toString();
			this.host.emitEffect({
				type: "DIAGNOSTIC",
				code: "INBOUND_INTEGRITY",
				message: "flushInbound safety net fired — update bypassed queue",
				detail: {
					updateBytes: update.length,
					changes: this.host.computeDiffChanges(localTextBefore, localTextAfter),
				},
			});
		}
	}

	/**
	 * Safety net: if localDoc and remoteDoc have divergent state vectors
	 * with no pending machine edits to account for the difference, perform
	 * a bidirectional full state diff to force convergence. This should
	 * never be needed -- if it fires, there is a bug that allowed ops to
	 * enter one doc without being queued for the other.
	 *
	 * Called after the queue-based flush completes (not during nested
	 * flushOutbound calls from flushInbound's machine-edit-match path).
	 */
	assertConvergence(): void {
		this.assertStateVectorConvergence();
	}

	private assertStateVectorConvergence(): void {
		const localDoc = this.host.getLocalDoc();
		const remoteDoc = this.host.getRemoteDoc();
		if (!localDoc || !remoteDoc) return;

		// Machine edits intentionally defer outbound ops -- state vectors
		// will diverge until the deferred entries are matched or expire.
		if (this.host.getPendingMachineEdits().length > 0) return;
		if (this._outboundQueue.some(e => e.machineEditMark !== null)) return;

		// Local-only mode gates all remote sync -- SV divergence is expected.
		if (this._syncGate.localOnly) return;

		// Fork gates outbound sync -- SV divergence is expected while it exists.
		if (this.host.hasFork()) return;

		if (yjsDocsEqual(localDoc, remoteDoc)) return;

		const localSV = Y.encodeStateVector(localDoc);
		const remoteSV = Y.encodeStateVector(remoteDoc);
		const localText = localDoc.getText("contents").toString();
		const remoteText = remoteDoc.getText("contents").toString();

		const msg =
			`[MergeHSM] state vector divergence after queue flush ` +
			`(guid=${this.host.guid}, path=${this.host.path}, ` +
			`localSVLen=${localSV.length}, remoteSVLen=${remoteSV.length}, ` +
			`localTextLen=${localText.length}, remoteTextLen=${remoteText.length}, ` +
			`textMatch=${localText === remoteText})`;

		bridgeError(msg);
		if (process.env.NODE_ENV === 'test') {
			throw new Error(msg);
		}

		// Bidirectional sync: apply each direction's missing ops
		const outbound = Y.encodeStateAsUpdate(localDoc, remoteSV);
		if (outbound.length > 0) {
			this.syncToRemote(outbound);
		}

		const inbound = Y.encodeStateAsUpdate(remoteDoc, localSV);
		if (inbound.length > 0) {
			this.syncToLocal(inbound);
		}
	}
}
