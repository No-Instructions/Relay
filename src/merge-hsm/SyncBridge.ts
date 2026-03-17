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
import { MACHINE_EDIT_ORIGIN } from "./undo";
import { stateVectorsEqual } from "./state-vectors";

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
	getPendingMachineEdits(): ReadonlyArray<{
		fn: (data: string) => string;
		expectedText: string;
		captureMark: number;
		registeredAt: number;
	}>;
	/** Find a pending machine edit matched by remoteText */
	matchMachineEdit(remoteText: string): {
		fn: (data: string) => string;
		expectedText: string;
		captureMark: number;
		registeredAt: number;
	} | null;
	/** Remove a matched machine edit registration */
	removeMachineEdit(entry: { captureMark: number }): void;
	/** Compute positioned diff changes between two strings */
	computeDiffChanges(from: string, to: string): PositionedChange[];
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

	/**
	 * Remove outbound entries matching a specific machine edit mark.
	 */
	discardOutboundByMark(captureMark: number): void {
		this._outboundQueue = this._outboundQueue.filter(
			e => e.machineEditMark !== captureMark,
		);
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
					machineEditMark: origin === MACHINE_EDIT_ORIGIN
						? this._currentMachineEditMark
						: null,
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
		if (!remoteDoc) return;
		Y.applyUpdate(remoteDoc, update, this.host);
		this.host.emitEffect({ type: "SYNC_TO_REMOTE", update });
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
			const pendingMarks = new Set(
				this.host.getPendingMachineEdits().map(e => e.captureMark),
			);
			const toSend: Uint8Array[] = [];
			const toDefer: OutboundEntry[] = [];

			for (const entry of this._outboundQueue) {
				if (entry.machineEditMark !== null
					&& pendingMarks.has(entry.machineEditMark)) {
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
			return;
		}

		// Fallback: full state diff (loading, idle -- before listener installed)
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

		const remoteText = remoteDoc.getText("contents").toString();

		// Check for machine edit match -- if the remote already has this
		// transform applied, rewind our local ops and apply remote instead
		const match = this.host.matchMachineEdit(remoteText);
		if (match) {
			const opCapture = this.host.getOpCapture();
			if (opCapture) {
				const machineOps = opCapture.sinceByOrigin(
					match.captureMark,
					MACHINE_EDIT_ORIGIN,
				);
				if (machineOps.length > 0) {
					const beforeText = localDoc.getText("contents").toString();

					// Suppress observer during rewind to avoid spurious DISPATCH_CM6
					this.host.setSuppressLocalObserver(true);
					try {
						// Cancel our machine edit ops: truly undo the CRDT ops
						// so the document state is as if they never happened.
						// Safe because we deferred sync -- no peer has seen these ops.
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
					this._outboundQueue = this._outboundQueue.filter(
						e => e.machineEditMark !== match.captureMark,
					);

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
					const outbound = Y.encodeStateAsUpdate(
						localDoc,
						Y.encodeStateVector(remoteDoc),
					);
					this._outboundQueue = [];
					if (outbound.length > 0) {
						this.syncToRemote(outbound);
					}
					this.assertStateVectorConvergence();
					return;
				}
			}

			// OpCapture unavailable or no ops captured yet (CM6 transaction hasn't
			// fired). Remove the registration.
			this.host.removeMachineEdit(match);
		}

		// Capture editor text before any modifications so we can compute the
		// net diff for DISPATCH_CM6 at the end.
		const beforeText = localDoc.getText("contents").toString();

		// Queue path (active editing -- listener installed): drain buffered updates.
		// After draining, fall through to the full state diff -- the current
		// in-flight update arrived at remoteDoc before the queue handler ran,
		// so it is in remoteDoc but not yet in _inboundQueue.
		if (this._remoteDocUpdateHandler && this._inboundQueue.length > 0) {
			if (beforeText === remoteText) {
				this._inboundQueue = [];
				return;
			}
			const merged = Y.mergeUpdates(this._inboundQueue);
			this._inboundQueue = [];
			this.syncToLocal(merged);
			// Fall through to full state diff to pick up any remaining gap.
		}

		// Full state diff: apply any remoteDoc state not yet in localDoc.
		const localText = localDoc.getText("contents").toString();
		if (localText !== remoteText) {
			const update = Y.encodeStateAsUpdate(
				remoteDoc,
				Y.encodeStateVector(localDoc),
			);
			this.syncToLocal(update);
		}

		// Dispatch the net change to the editor view.
		const afterText = localDoc.getText("contents").toString();
		if (afterText !== beforeText) {
			const changes = this.host.computeDiffChanges(beforeText, afterText);
			if (changes.length > 0) {
				this.host.emitEffect({ type: "DISPATCH_CM6", changes });
			}
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
	private assertStateVectorConvergence(): void {
		const localDoc = this.host.getLocalDoc();
		const remoteDoc = this.host.getRemoteDoc();
		if (!localDoc || !remoteDoc) return;

		// Machine edits intentionally defer outbound ops -- state vectors
		// will diverge until the deferred entries are matched or expire.
		if (this.host.getPendingMachineEdits().length > 0) return;
		if (this._outboundQueue.some(e => e.machineEditMark !== null)) return;

		// Fork gates outbound sync -- SV divergence is expected while it exists.
		if (this.host.hasFork()) return;

		const localSV = Y.encodeStateVector(localDoc);
		const remoteSV = Y.encodeStateVector(remoteDoc);
		if (stateVectorsEqual(localSV, remoteSV)) return;

		const localText = localDoc.getText("contents").toString();
		const remoteText = remoteDoc.getText("contents").toString();

		const msg =
			`[MergeHSM] state vector divergence after queue flush ` +
			`(guid=${this.host.guid}, path=${this.host.path}, ` +
			`localSVLen=${localSV.length}, remoteSVLen=${remoteSV.length}, ` +
			`localTextLen=${localText.length}, remoteTextLen=${remoteText.length}, ` +
			`textMatch=${localText === remoteText})`;

		console.error(msg);
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
