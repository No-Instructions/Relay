const SHORT_HASH_LENGTH = 8;

export const STUCK_OUTBOUND_THRESHOLD_MS = 5_000;
export const EDITOR_LOCAL_DRIFT_THRESHOLD_MS = 500;

export interface SyncDebugGateSnapshot {
	providerConnected: boolean;
	providerSynced: boolean;
	localOnly: boolean;
	pendingInbound: number;
	pendingOutbound: number;
}

export interface SyncDebugSnapshotInput {
	now: number;
	statePath?: string | null;
	syncGate?: SyncDebugGateSnapshot | null;
	pendingOutboundSince?: number | null;
	websocketLastMessageAt?: number | null;
	diskHsm?: { hash?: string | null; mtime?: number | null } | null;
	diskStat?: { mtime?: number | null } | null;
	lca?: { hash?: string | null; contentLength?: number | null } | null;
	fork?: { created?: number | null } | null;
	error?: { message: string; retryable?: boolean | null } | null;
	lastEvent?: { type: string; at: number } | null;
	editorLocalMismatch?: boolean | null;
	editorLocalMismatchSince?: number | null;
}

export interface SyncDebugSnapshot {
	statePath: string;
	syncGate: (SyncDebugGateSnapshot & { pendingOutboundAgeMs: number | null }) | null;
	transport: {
		connected: boolean | null;
		lastMessageAgeMs: number | null;
	};
	diskHsm: {
		hash: string | null;
		fullHash: string | null;
		mtime: number | null;
		matchesLca: boolean | null;
	} | null;
	diskStat: { mtime: number | null } | null;
	lca: {
		hash: string | null;
		fullHash: string | null;
		contentLength: number | null;
	} | null;
	fork: { present: boolean; ageMs: number | null };
	error: { message: string; retryable: boolean | null } | null;
	lastEvent: { type: string; ageMs: number | null } | null;
	drift: {
		diskHsmLca: boolean;
		diskHsmStat: boolean;
		editorLocal: boolean;
		providerOutboundStuck: boolean;
	};
}

/**
 * Read the HSM's sync gate without inventing a provider-connected gate field.
 * Transport connectivity belongs to the provider-backed document.
 */
export function readSyncDebugGate(
	providerConnected: boolean,
	hsm: unknown,
): SyncDebugGateSnapshot | null {
	try {
		const source = hsm as {
			_syncGate?: unknown;
			_bridge?: { syncGate?: unknown; _syncGate?: unknown };
		};
		const raw = (source?._syncGate ??
			source?._bridge?.syncGate ??
			source?._bridge?._syncGate) as
			| {
					providerSynced?: unknown;
					localOnly?: unknown;
					pendingInbound?: unknown;
					pendingOutbound?: unknown;
			}
			| undefined;
		if (!raw) return null;

		return {
			providerConnected,
			providerSynced: raw.providerSynced === true,
			localOnly: raw.localOnly === true,
			pendingInbound: finiteCount(raw.pendingInbound),
			pendingOutbound: finiteCount(raw.pendingOutbound),
		};
	} catch {
		return null;
	}
}

/** Pure, defensive shaping for the values shown by the editor overlay. */
export function shapeSyncDebugSnapshot(
	input: SyncDebugSnapshotInput,
): SyncDebugSnapshot {
	const now = finiteNumber(input.now) ?? 0;
	const diskHsmHash = nonEmptyString(input.diskHsm?.hash);
	const diskHsmMtime = finiteNumber(input.diskHsm?.mtime);
	const diskStatMtime = finiteNumber(input.diskStat?.mtime);
	const lcaHash = nonEmptyString(input.lca?.hash);
	const pendingOutboundAgeMs = age(now, input.pendingOutboundSince);
	const editorLocalMismatchAgeMs = age(now, input.editorLocalMismatchSince);
	const websocketLastMessageAt = finiteNumber(input.websocketLastMessageAt);
	const forkCreated = finiteNumber(input.fork?.created);
	const lastEventAt = finiteNumber(input.lastEvent?.at);

	return {
		statePath: nonEmptyString(input.statePath) ?? "unknown",
		syncGate: input.syncGate
			? {
					...input.syncGate,
					pendingInbound: finiteCount(input.syncGate.pendingInbound),
					pendingOutbound: finiteCount(input.syncGate.pendingOutbound),
					pendingOutboundAgeMs,
			}
			: null,
		transport: {
			connected: input.syncGate?.providerConnected ?? null,
			lastMessageAgeMs:
				websocketLastMessageAt !== null && websocketLastMessageAt > 0
					? age(now, websocketLastMessageAt)
					: null,
		},
		diskHsm: input.diskHsm
			? {
					hash: shortHash(diskHsmHash),
					fullHash: diskHsmHash,
					mtime: diskHsmMtime,
					matchesLca:
						diskHsmHash !== null && lcaHash !== null
							? diskHsmHash === lcaHash
							: null,
			}
			: null,
		diskStat:
			input.diskStat !== null && input.diskStat !== undefined
				? { mtime: diskStatMtime }
				: null,
		lca: input.lca
			? {
					hash: shortHash(lcaHash),
					fullHash: lcaHash,
					contentLength: finiteNumber(input.lca.contentLength),
			}
			: null,
		fork: {
			present: input.fork !== null && input.fork !== undefined,
			ageMs: forkCreated !== null ? age(now, forkCreated) : null,
		},
		error: input.error
			? {
					message: String(input.error.message),
					retryable:
						typeof input.error.retryable === "boolean"
							? input.error.retryable
							: null,
			}
			: null,
		lastEvent: input.lastEvent
			? {
					type: nonEmptyString(input.lastEvent.type) ?? "unknown",
					ageMs: lastEventAt !== null ? age(now, lastEventAt) : null,
			}
			: null,
		drift: {
			diskHsmLca:
				diskHsmHash !== null && lcaHash !== null && diskHsmHash !== lcaHash,
			diskHsmStat: diskBeliefDiffersFromStat(
				input.diskHsm,
				diskHsmMtime,
				input.diskStat,
				diskStatMtime,
			),
			editorLocal:
				input.editorLocalMismatch === true &&
				editorLocalMismatchAgeMs !== null &&
				editorLocalMismatchAgeMs >= EDITOR_LOCAL_DRIFT_THRESHOLD_MS,
			providerOutboundStuck:
				input.syncGate?.providerSynced === true &&
				finiteCount(input.syncGate.pendingOutbound) > 0 &&
				pendingOutboundAgeMs !== null &&
				pendingOutboundAgeMs > STUCK_OUTBOUND_THRESHOLD_MS,
		},
	};
}

function diskBeliefDiffersFromStat(
	diskHsm: SyncDebugSnapshotInput["diskHsm"],
	diskHsmMtime: number | null,
	diskStat: SyncDebugSnapshotInput["diskStat"],
	diskStatMtime: number | null,
): boolean {
	if (diskStat === null || diskStat === undefined) return false;

	const hsmBelievesFileExists = diskHsm !== null && diskHsm !== undefined;
	const statSaysFileExists = diskStatMtime !== null;
	if (hsmBelievesFileExists !== statSaysFileExists) return true;

	return (
		hsmBelievesFileExists &&
		diskHsmMtime !== null &&
		diskStatMtime !== null &&
		diskHsmMtime !== diskStatMtime
	);
}

function age(now: number, timestamp: number | null | undefined): number | null {
	const value = finiteNumber(timestamp);
	return value === null ? null : Math.max(0, now - value);
}

function finiteCount(value: unknown): number {
	const count = finiteNumber(value);
	return count === null ? 0 : Math.max(0, count);
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function shortHash(hash: string | null): string | null {
	return hash?.slice(0, SHORT_HASH_LENGTH) ?? null;
}
