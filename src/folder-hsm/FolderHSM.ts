/**
 * FolderHSM
 *
 * One engine instance per shared folder: one folder machine, one event
 * queue, one entry table. The folder machine (FOLDER_MACHINE) is
 * interpreted by the shared merge-hsm interpreter; per-file decisions
 * live in the ENTRY_MACHINE's keyed row table, ticked synchronously from
 * the folder machine's actions inside the single event queue.
 *
 * Effects are executed by the host (SharedFolder): trash via Obsidian's
 * trash, uploads/downloads via the existing BackgroundSync paths, map
 * mutations via SyncStore. The host reports durable acceptance with
 * WORK_STARTED and completions only for work actually done.
 *
 * Safety structure:
 * - the emit chokepoint refuses (throws) any effect whose capability the
 *   current folder posture does not grant, any destructive dispatch at
 *   blind confidence, and any publishing/index write under read-only
 *   authorization;
 * - entry candidates declare the capabilities their effects require; the
 *   cross-product of entry candidate and folder posture is checked at
 *   emit (the two-level check);
 * - every undeclared (state x event) cell resolves through the node's
 *   `otherwise` policy — absorb, refuse, or reclassify — never silence.
 */

import { processEvent } from "../merge-hsm/machine-interpreter";
import type { ActiveInvoke } from "../merge-hsm/types";
import { curryLog } from "../debug";
import { FOLDER_MACHINE } from "./machine-definition";
import { ENTRY_MACHINE } from "./entry-machine";
import type {
	ConfidenceTier,
	Disposition,
	EntryCandidate,
	EntryEvent,
	EntryEventHandler,
	EntryRefusal,
	EntryRow,
	EntryStatePath,
	EntryTarget,
	FileOrigin,
	FolderCapabilityName,
	FolderContext,
	FolderEffect,
	FolderEvent,
	FolderHSMConfig,
	FolderInvariantViolation,
	FolderSerializableSnapshot,
	FolderStatePath,
	FolderSyncSnapshot,
	LocalFileKind,
	MapEntrySummary,
	MembershipEntry,
} from "./types";

/** Capability each effect type requires from the current posture. */
const EFFECT_CAPABILITY: Record<
	Exclude<FolderEffect["type"], "ENQUEUE_UPLOAD" | "PERSIST_STATE">,
	FolderCapabilityName
> = {
	ENQUEUE_DOWNLOAD: "canDownload",
	TRASH_LOCAL: "canTrash",
	RENAME_LOCAL: "canRenameLocal",
	MAP_SET: "canMutateMap",
	MAP_DELETE: "canMutateMap",
	RETRACT_UPLOAD: "canEmitEffects",
	PARK: "canPark",
	SURFACE_STATUS: "canEmitEffects",
};

/** Effects that destroy local content or publish to the group. */
const CONFIRMED_ONLY_EFFECTS = new Set<FolderEffect["type"]>([
	"TRASH_LOCAL",
	"RENAME_LOCAL",
	"ENQUEUE_UPLOAD",
]);

/** Effects that originate writes (refused under read-only authorization). */
const WRITE_EFFECTS = new Set<FolderEffect["type"]>([
	"ENQUEUE_UPLOAD",
	"MAP_SET",
	"MAP_DELETE",
]);

/** Entry states whose CLASSIFY cell a classification pass visits. */
const CLASSIFY_STATES: ReadonlySet<EntryStatePath> = new Set([
	"unclassified",
	"upload.held",
	"upload.inFlight",
	"download.pending",
	"download.inFlight",
]);

const PARK_REASON_TOMBSTONE =
	"file found at a path the group previously deleted";
const PARK_REASON_READ_ONLY = "publication requires write access";
const DROP_REASON = "outbound deletion dropped: its target changed";
const CONFLICT_REASON =
	"remote content asserted at a refused path holding local content";

const DISPOSITION_BY_STATE: Record<EntryStatePath, Disposition> = {
	unclassified: "pendingUpload", // provisional; see snapshotDisposition
	synced: "synced",
	"upload.held": "pendingUpload",
	"upload.inFlight": "pendingUpload",
	"download.pending": "pendingDownload",
	"download.inFlight": "pendingDownload",
	trashing: "pendingTrash",
	renaming: "pendingRename",
	"delete.pending": "pendingMapDelete",
	"delete.held": "pendingMapDelete",
	parked: "parked",
	conflicted: "conflicted",
};

function freshContext(): FolderContext {
	return {
		persistenceLoaded: false,
		tier: "none",
		providerSynced: false,
		isOnline: false,
		authorization: "write",
		rows: new Map(),
		rowKeyByPath: new Map(),
		localFiles: new Map(),
		recordedDeleteIntents: new Set(),
		classificationDeferred: false,
		revision: 0,
	};
}

function isRefusal(handler: EntryEventHandler): handler is EntryRefusal {
	return (
		typeof handler === "object" &&
		!Array.isArray(handler) &&
		"refuse" in handler
	);
}

function normalizeEntryCandidates(
	handler: Exclude<EntryEventHandler, EntryRefusal>,
): EntryCandidate[] {
	if (typeof handler === "string") return [{ target: handler }];
	if (Array.isArray(handler)) return handler;
	return [handler];
}

export class FolderHSM {
	readonly context: FolderContext;
	private _statePath: FolderStatePath = "loading";
	private _activeInvoke: ActiveInvoke | null = null;
	private _processing = false;
	private _queue: FolderEvent[] = [];
	private _currentEventType = "";
	private _classifyQueue = new Set<string>();
	private _surfaceDirty = false;
	private _lastPersistedRevision = 0;
	private interpreterConfig: {
		guards: Record<string, (hsm: unknown, event: FolderEvent) => boolean>;
		actions: Record<string, (hsm: unknown, event: FolderEvent) => void>;
		invokeSources: Record<string, never>;
	};
	private entryGuards: Record<
		string,
		(row: EntryRow, event: EntryEvent) => boolean
	>;
	private entryActions: Record<
		string,
		(row: EntryRow, event: EntryEvent) => void
	>;
	private warn = curryLog("[FolderHSM]", "warn");

	constructor(private config: FolderHSMConfig) {
		this.context = freshContext();
		this.interpreterConfig = {
			guards: {
				persistenceLoaded: () => this.context.persistenceLoaded,
				hydrated: () =>
					this.context.persistenceLoaded && this.context.tier !== "none",
				reconnectPending: () => !this.context.providerSynced,
				tierWasBlind: (_hsm, event) =>
					this.context.tier === "blind" &&
					event.type === "PROVIDER_SYNCED" &&
					(event.tier ?? "confirmed") === "confirmed",
				classificationDeferred: () => this.context.classificationDeferred,
				authorizationExpanded: (_hsm, event) =>
					event.type === "AUTHORIZATION_CHANGED" &&
					event.scope === "write" &&
					this.context.authorization !== "write",
			},
			actions: {
				resetContext: () => this.resetContext(),
				markPersistenceLoaded: () => {
					this.context.persistenceLoaded = true;
					this.bump();
				},
				recordTier: (_hsm, event) => {
					if (event.type !== "PROVIDER_SYNCED") return;
					this.recordTier(event.tier ?? "confirmed");
				},
				recordAuthorization: (_hsm, event) => {
					if (event.type !== "AUTHORIZATION_CHANGED") return;
					if (this.context.authorization !== event.scope) {
						this.context.authorization = event.scope;
						this.bump();
					}
				},
				revisitGatedRows: () => this.revisitGatedRows(),
				setOnline: () => {
					this.context.isOnline = true;
				},
				setOffline: () => {
					this.context.isOnline = false;
					// The session's sync claim dies with the transport; the
					// next completed exchange re-enters classification.
					this.context.providerSynced = false;
				},
				absorbMapDelta: () => {
					// The map itself is the durable record; classification
					// re-reads it. Nothing to decide before hydration.
				},
				absorbDiscoveredFile: (_hsm, event) => {
					if (event.type !== "FILE_DISCOVERED") return;
					this.rememberLocalFile(event.path, event.origin, event.kind);
				},
				absorbInteractiveCreate: (_hsm, event) => {
					if (event.type !== "FILE_CREATED") return;
					this.rememberLocalFile(event.path, "interactive", event.kind);
					this.context.recordedDeleteIntents.delete(event.path);
				},
				absorbLocalDelete: (_hsm, event) => {
					if (event.type !== "FILE_DELETED") return;
					this.context.localFiles.delete(event.path);
					this.context.recordedDeleteIntents.add(event.path);
					this.bump();
				},
				absorbLocalRename: (_hsm, event) => {
					if (event.type !== "FILE_RENAMED") return;
					this.rekeyLocalFile(event.from, event.to);
				},
				classifyUnclassifiedRows: () => this.runClassification(),
				routeDeltaToRows: (_hsm, event) => {
					if (event.type !== "MAP_DELTA") return;
					this.routeDelta(event);
				},
				routeFileDiscovered: (_hsm, event) => {
					if (event.type !== "FILE_DISCOVERED") return;
					this.routeFileDiscovered(event.path, event.origin, event.kind);
				},
				routeFileCreated: (_hsm, event) => {
					if (event.type !== "FILE_CREATED") return;
					this.routeFileCreated(event.path, event.kind);
				},
				routeFileModified: (_hsm, event) => {
					if (event.type !== "FILE_MODIFIED") return;
					const row = this.rowAtPath(event.path);
					if (row) this.tickRow(row, event);
				},
				routeFileDeleted: (_hsm, event) => {
					if (event.type !== "FILE_DELETED") return;
					this.routeFileDeleted(event.path);
				},
				routeFileRenamed: (_hsm, event) => {
					if (event.type !== "FILE_RENAMED") return;
					this.routeFileRenamed(event.from, event.to);
				},
				routeAckToRow: (_hsm, event) => {
					if (event.type !== "WORK_STARTED") return;
					const row = this.rowAtPath(event.path);
					if (row) this.tickRow(row, event);
				},
				routeCompletionToRow: (_hsm, event) => {
					if (
						event.type !== "UPLOAD_COMPLETE" &&
						event.type !== "UPLOAD_FAILED" &&
						event.type !== "DOWNLOAD_COMPLETE" &&
						event.type !== "DOWNLOAD_FAILED" &&
						event.type !== "TRASH_COMPLETE"
					)
						return;
					if (event.type === "TRASH_COMPLETE") {
						// Trash completion is the report that the file left
						// the disk; cascade echoes are suppressed host-side,
						// so the local-tree evidence updates here.
						this.context.localFiles.delete(event.path);
						this.bump();
					}
					const row = this.rowAtPath(event.path);
					if (row) this.tickRow(row, event);
				},
				routePolicyOutcomeToRows: (_hsm, event) => {
					if (
						event.type !== "DELETE_HELD" &&
						event.type !== "DELETE_REPLICATED" &&
						event.type !== "DELETE_RESTORED"
					)
						return;
					for (const path of event.paths) {
						const row = this.rowAtPath(path);
						if (row) this.tickRow(row, event);
					}
				},
				routeUserActionToRow: (_hsm, event) => {
					if (
						event.type !== "UNPARK_REQUESTED" &&
						event.type !== "RESOLVE_CONFLICT"
					)
						return;
					const row = this.rowAtPath(event.path);
					if (row) this.tickRow(row, event);
				},
			},
			invokeSources: {},
		};
		this.entryGuards = this.buildEntryGuards();
		this.entryActions = this.buildEntryActions();
	}

	// =========================================================================
	// MachineHSM surface (consumed by the merge-hsm interpreter)
	// =========================================================================

	get statePath(): FolderStatePath {
		return this._statePath;
	}

	setStatePath(target: FolderStatePath): void {
		const from = this._statePath;
		this._statePath = target;
		if (from !== target) {
			this.config.onTransition?.(from, target, this._currentEventType);
		}
	}

	getActiveInvoke(): ActiveInvoke | null {
		return this._activeInvoke;
	}

	setActiveInvoke(invoke: ActiveInvoke | null): void {
		this._activeInvoke = invoke;
	}

	send(event: FolderEvent): void {
		if (this._processing) {
			this._queue.push(event);
			return;
		}
		this._processing = true;
		try {
			this.dispatch(event);
			while (this._queue.length > 0) {
				this.dispatch(this._queue.shift()!);
			}
		} finally {
			this._processing = false;
		}
		this.flushPersist();
	}

	private dispatch(event: FolderEvent): void {
		this._currentEventType = event.type;
		// The interpreter is generic at runtime; its types are bound to
		// MergeHSM's unions, so the boundary casts here are deliberate.
		processEvent(
			this as never,
			event as never,
			FOLDER_MACHINE as never,
			this.interpreterConfig as never,
		);
		this.drainScheduledClassifies();
		this.flushSurfaceStatus();
	}

	// =========================================================================
	// Projections
	// =========================================================================

	/**
	 * Whether the engine currently knows `path` as a local file. The
	 * host's origin discriminator uses this to keep re-observations of
	 * already scanned paths from laundering into interactive intent.
	 */
	hasLocalFile(path: string): boolean {
		return this.context.localFiles.has(path);
	}

	/** The entry-machine state of the row at `path`, if any. */
	getRowState(path: string): EntryStatePath | undefined {
		return this.rowAtPath(path)?.state;
	}

	/**
	 * Whether the host's upload plumbing may publish `path` on its own
	 * retry paths. Only rows the machine holds in an upload state (or no
	 * row at all — legacy work predating the machine) are publishable; a
	 * parked, conflicted, or condemned row's hold must never flush.
	 */
	holdIsPublishable(path: string): boolean {
		const row = this.rowAtPath(path);
		if (!row) return true;
		return row.state === "upload.held" || row.state === "upload.inFlight";
	}

	getSnapshot(): FolderSyncSnapshot {
		const entries: MembershipEntry[] = [];
		const parked: Array<{ path: string; reason: string }> = [];
		const conflicted: Array<{ path: string; reason: string }> = [];
		for (const row of this.context.rows.values()) {
			entries.push({
				guid: row.guid,
				path: row.path,
				disposition: this.snapshotDisposition(row),
			});
			if (row.state === "parked") {
				parked.push({ path: row.path, reason: row.reason ?? "" });
			} else if (row.state === "conflicted") {
				conflicted.push({ path: row.path, reason: row.reason ?? "" });
			}
		}
		return {
			statePath: this._statePath,
			hydrated:
				this.context.persistenceLoaded && this.context.tier !== "none",
			isOnline: this.context.isOnline,
			tier: this.context.tier,
			entries,
			parked,
			conflicted,
		};
	}

	getSerializableSnapshot(): FolderSerializableSnapshot {
		return {
			statePath: this._statePath,
			revision: this.context.revision,
			context: {
				persistenceLoaded: this.context.persistenceLoaded,
				tier: this.context.tier,
				providerSynced: this.context.providerSynced,
				isOnline: this.context.isOnline,
				authorization: this.context.authorization,
				classificationDeferred: this.context.classificationDeferred,
				localFiles: Array.from(this.context.localFiles.entries()).map(
					([path, info]) => ({ path, ...info }),
				),
				recordedDeleteIntents: Array.from(
					this.context.recordedDeleteIntents,
				),
			},
			rows: Array.from(this.context.rows.values()).map((row) => ({
				...row,
				observedIdentity: row.observedIdentity
					? { ...row.observedIdentity }
					: undefined,
			})),
		};
	}

	/**
	 * Ask for a PERSIST_STATE emission (the host's durable write path for
	 * the approved fork-class subset). Coalesced with the revision
	 * stream; a request from a posture that grants no effects flushes on
	 * the next effect-granting posture.
	 */
	requestPersist(): void {
		this.bump();
		if (!this._processing) this.flushPersist();
	}

	private snapshotDisposition(row: EntryRow): Disposition {
		if (row.state === "unclassified") {
			// Undecided rows project by their dominant evidence so status
			// surfaces stay readable: mapped paths read as downloads,
			// unmapped local files as uploads.
			return this.getMapEntry(row.path)
				? this.context.localFiles.has(row.path)
					? "synced"
					: "pendingDownload"
				: "pendingUpload";
		}
		return DISPOSITION_BY_STATE[row.state];
	}

	// =========================================================================
	// Effect emission — the capability-checked chokepoint
	// =========================================================================

	private stateCapabilities() {
		return FOLDER_MACHINE[this._statePath]?.capabilities ?? {};
	}

	/** Whether the current posture grants `capability` (the dispatch gate). */
	private may(capability: FolderCapabilityName): boolean {
		const capabilities = this.stateCapabilities();
		return Boolean(capabilities.canEmitEffects && capabilities[capability]);
	}

	private emit(effect: FolderEffect): void {
		if (effect.type !== "PERSIST_STATE") {
			const capabilities = this.stateCapabilities();
			if (!capabilities.canEmitEffects) {
				throw new Error(
					`FolderHSM invariant violation: ${effect.type} emitted from ${this._statePath}, which grants no effects`,
				);
			}
			const required =
				effect.type === "ENQUEUE_UPLOAD"
					? effect.origin === "interactive"
						? "canUploadInteractive"
						: "canUploadBootstrap"
					: EFFECT_CAPABILITY[effect.type];
			if (!capabilities[required]) {
				throw new Error(
					`FolderHSM invariant violation: ${effect.type} requires ${required} which ${this._statePath} does not grant`,
				);
			}
			if (
				CONFIRMED_ONLY_EFFECTS.has(effect.type) &&
				this.context.tier !== "confirmed"
			) {
				throw new Error(
					`FolderHSM invariant violation: ${effect.type} dispatched at ${this.context.tier} confidence`,
				);
			}
			if (
				WRITE_EFFECTS.has(effect.type) &&
				this.context.authorization !== "write"
			) {
				throw new Error(
					`FolderHSM invariant violation: ${effect.type} dispatched under read-only authorization`,
				);
			}
		}
		this.config.onEffect(effect);
	}

	private flushPersist(): void {
		if (this.context.revision === this._lastPersistedRevision) return;
		if (!this.stateCapabilities().canEmitEffects) return;
		this._lastPersistedRevision = this.context.revision;
		this.emit({
			type: "PERSIST_STATE",
			snapshot: this.getSerializableSnapshot(),
		});
	}

	private flushSurfaceStatus(): void {
		if (!this._surfaceDirty) return;
		if (!this.stateCapabilities().canEmitEffects) return;
		this._surfaceDirty = false;
		this.emit({ type: "SURFACE_STATUS" });
	}

	private bump(): void {
		this.context.revision++;
	}

	// =========================================================================
	// Context bookkeeping
	// =========================================================================

	private resetContext(): void {
		const fresh = freshContext();
		Object.assign(this.context, fresh);
		this._classifyQueue.clear();
		this._surfaceDirty = false;
	}

	private rememberLocalFile(
		path: string,
		origin: FileOrigin,
		kind?: LocalFileKind,
	): void {
		const existing = this.context.localFiles.get(path);
		// Interactive provenance is stickier than bootstrap: a live create
		// followed by a scan replay must not launder intent away.
		const nextOrigin =
			existing?.origin === "interactive" ? "interactive" : origin;
		const nextKind = kind ?? existing?.kind ?? "file";
		if (
			existing &&
			existing.origin === nextOrigin &&
			existing.kind === nextKind
		) {
			return; // no change — keep sweeps quiet
		}
		this.context.localFiles.set(path, { origin: nextOrigin, kind: nextKind });
		this.bump();
	}

	private rekeyLocalFile(from: string, to: string): void {
		const info = this.context.localFiles.get(from);
		this.context.localFiles.delete(from);
		this.context.localFiles.set(
			to,
			info ?? { origin: "interactive", kind: "file" },
		);
		this.context.recordedDeleteIntents.delete(to);
		this.bump();
	}

	private hasLocalChildren(path: string): boolean {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		for (const candidate of this.context.localFiles.keys()) {
			if (candidate !== path && candidate.startsWith(prefix)) return true;
		}
		return false;
	}

	private getMapEntry(path: string): MapEntrySummary | undefined {
		if (this.config.getMapEntry) return this.config.getMapEntry(path);
		return this.config.listMapEntries().find((entry) => entry.path === path);
	}

	private recordTier(claim: "blind" | "confirmed"): void {
		if (claim === "blind") {
			// A persisted marker can declare sync but never confirm it: it
			// upgrades nothing once a live exchange has completed.
			if (this.context.tier === "none") {
				this.context.tier = "blind";
				this.bump();
			}
		} else if (this.context.tier !== "confirmed") {
			this.context.tier = "confirmed";
			this.bump();
		}
		this.context.providerSynced = true;
	}

	// =========================================================================
	// The entry table
	// =========================================================================

	private rowKeyFor(guid: string | null, path: string): string {
		return guid ?? `path:${path}`;
	}

	private rowAtPath(path: string): EntryRow | undefined {
		const key = this.context.rowKeyByPath.get(path);
		return key !== undefined ? this.context.rows.get(key) : undefined;
	}

	private rowByGuid(guid: string): EntryRow | undefined {
		return this.context.rows.get(guid);
	}

	private createRow(
		path: string,
		origin: FileOrigin,
		kind: LocalFileKind,
		guid: string | null = null,
	): EntryRow {
		// Displace any existing row for this path (a provisional guid-less
		// row being re-keyed after a mint, or a stale mapping).
		const previousKey = this.context.rowKeyByPath.get(path);
		if (previousKey !== undefined) {
			this.context.rows.delete(previousKey);
			this.context.rowKeyByPath.delete(path);
		}
		const row: EntryRow = {
			key: this.rowKeyFor(guid, path),
			path,
			state: "unclassified",
			guid,
			origin,
			kind,
			decidedTier: this.context.tier,
			dispatched: false,
			contentAgreement: "unknown",
		};
		this.context.rows.set(row.key, row);
		this.context.rowKeyByPath.set(path, row.key);
		this.bump();
		return row;
	}

	/** Create an unclassified row for a path from the context's evidence. */
	private seedRow(path: string, guid: string | null = null): EntryRow {
		const info = this.context.localFiles.get(path);
		return this.createRow(
			path,
			info?.origin ?? "bootstrap",
			info?.kind ?? "file",
			guid,
		);
	}

	private rekeyRowPath(row: EntryRow, to: string): void {
		if (this.context.rowKeyByPath.get(row.path) === row.key) {
			this.context.rowKeyByPath.delete(row.path);
		}
		row.path = to;
		this.context.rowKeyByPath.set(to, row.key);
		this.bump();
	}

	private rekeyRowGuid(row: EntryRow, guid: string): void {
		this.context.rows.delete(row.key);
		row.guid = guid;
		row.key = this.rowKeyFor(guid, row.path);
		this.context.rows.set(row.key, row);
		this.context.rowKeyByPath.set(row.path, row.key);
		this.bump();
	}

	private retireRow(row: EntryRow): void {
		this.context.rows.delete(row.key);
		if (this.context.rowKeyByPath.get(row.path) === row.key) {
			this.context.rowKeyByPath.delete(row.path);
		}
		this._classifyQueue.delete(row.key);
		// A record must never outlive the file it described.
		this.config.records.retireRecord(row.path);
		if (this.config.records.getRecordGuid(row.path) !== undefined) {
			const violation: FolderInvariantViolation = {
				id: "record-dies-with-row",
				severity: "error",
				message: `a local record survived the retirement of ${row.path}`,
				statePath: this._statePath,
				path: row.path,
			};
			if (this.config.onInvariantViolation) {
				this.config.onInvariantViolation(violation);
			} else {
				this.warn(violation.message);
			}
		}
		this.bump();
		// Declared convergence window: if the map re-asserted the path
		// while this row was condemned, the re-add classifies afresh.
		if (
			!this.context.localFiles.has(row.path) &&
			this.getMapEntry(row.path) !== undefined
		) {
			const seeded = this.seedRow(
				row.path,
				this.getMapEntry(row.path)?.guid ?? null,
			);
			this.scheduleClassifyRow(seeded);
		}
	}

	// =========================================================================
	// The row tick (the entry-machine executor)
	// =========================================================================

	private tickRow(row: EntryRow, event: EntryEvent): void {
		const node = ENTRY_MACHINE[row.state];
		const handler = node.on[event.type];
		if (handler === undefined) {
			this.applyOtherwise(row, event);
			return;
		}
		if (isRefusal(handler)) {
			this.refuse(row, event);
			return;
		}
		const candidates = normalizeEntryCandidates(handler);
		for (const candidate of candidates) {
			if (candidate.guard) {
				const guard = this.entryGuards[candidate.guard];
				if (!guard) {
					this.warn(`unknown entry guard: ${candidate.guard}`);
					continue;
				}
				if (!guard(row, event)) continue;
			}
			this.executeEntryTransition(row, candidate, event);
			return;
		}
		// Declared cell, no passing guard: consumed without transition —
		// but never silently for an explicit user action. A resolution or
		// unpark whose evidence guards refuse (blind tier above all) is
		// reported like a refusal so the drop is visible.
		if (
			event.type === "RESOLVE_CONFLICT" ||
			event.type === "UNPARK_REQUESTED"
		) {
			this.refuse(row, event);
		}
	}

	private executeEntryTransition(
		row: EntryRow,
		candidate: EntryCandidate,
		event: EntryEvent,
	): void {
		for (const name of candidate.actions ?? []) {
			const action = this.entryActions[name];
			if (!action) {
				this.warn(`unknown entry action: ${name}`);
				continue;
			}
			action(row, event);
		}
		const target: EntryTarget = candidate.target;
		if (target === "retired") {
			this.retireRow(row);
			return;
		}
		if (target === row.state) {
			return; // internal transition: no re-entry
		}
		row.state = target;
		row.decidedTier = this.context.tier;
		row.dispatched = false;
		this.bump();
		for (const name of ENTRY_MACHINE[target].entry ?? []) {
			const action = this.entryActions[name];
			if (!action) {
				this.warn(`unknown entry action: ${name}`);
				continue;
			}
			action(row, event);
		}
	}

	private applyOtherwise(row: EntryRow, event: EntryEvent): void {
		const policy = ENTRY_MACHINE[row.state].otherwise;
		if (policy === "refuse") {
			this.refuse(row, event);
			return;
		}
		if (policy === "reclassify") {
			row.state = "unclassified";
			row.decidedTier = this.context.tier;
			row.dispatched = false;
			this.bump();
			this.scheduleClassifyRow(row);
			return;
		}
		// absorb: record the event as evidence — no state change, no effect.
		this.absorbIntoRow(row, event);
	}

	private absorbIntoRow(row: EntryRow, event: EntryEvent): void {
		switch (event.type) {
			case "FILE_MODIFIED":
				if (row.contentAgreement !== "stale") {
					row.contentAgreement = "stale";
					this.bump();
				}
				return;
			case "FILE_DISCOVERED":
				if (event.kind && event.kind !== row.kind) {
					row.kind = event.kind;
					this.bump();
				}
				return;
			default:
				return;
		}
	}

	private refuse(row: EntryRow, event: EntryEvent): void {
		const violation: FolderInvariantViolation = {
			id: "entry-event-refused",
			severity: "warning",
			message: `${event.type} refused in ${row.state} for ${row.path}: no outstanding work matches it`,
			statePath: this._statePath,
			entryState: row.state,
			path: row.path,
		};
		if (this.config.onInvariantViolation) {
			this.config.onInvariantViolation(violation);
		} else {
			this.warn(violation.message);
		}
	}

	private scheduleClassifyRow(row: EntryRow): void {
		this._classifyQueue.add(row.key);
	}

	private drainScheduledClassifies(): void {
		if (this._classifyQueue.size === 0) return;
		if (this._statePath !== "tracking" && this._statePath !== "reconciling") {
			return; // reconciling's entry pass visits them anyway
		}
		// The trust gate binds scheduled visits too: no verdict reads an
		// untrustworthy map. The queue drops — a deferred pass re-visits
		// every undecided row when the drain re-arms it.
		if (this.config.hasPendingSyncState?.()) {
			if (!this.context.classificationDeferred) {
				this.context.classificationDeferred = true;
				this.bump();
			}
			this._classifyQueue.clear();
			return;
		}
		// A tick may schedule further visits; loop until quiet, bounded.
		for (let i = 0; i < 10 && this._classifyQueue.size > 0; i++) {
			const keys = Array.from(this._classifyQueue);
			this._classifyQueue.clear();
			for (const key of keys) {
				const row = this.context.rows.get(key);
				if (!row) continue;
				this.classifyVisit(row);
			}
		}
		if (this._classifyQueue.size > 0) {
			this.warn("scheduled classification did not settle; deferring");
		}
	}

	/** One classification visit for one row, with the row-hygiene pre-checks. */
	private classifyVisit(row: EntryRow): void {
		if (row.state === "unclassified") {
			const hasFile = this.context.localFiles.has(row.path);
			const hasEntry = this.getMapEntry(row.path) !== undefined;
			const hasIntent = this.context.recordedDeleteIntents.has(row.path);
			if (!hasFile && !hasEntry && !hasIntent) {
				// Nothing on either side and no recorded intent: the row has
				// no subject left to decide about.
				this.retireRow(row);
				return;
			}
		}
		this.tickRow(row, { type: "CLASSIFY" });
	}

	// =========================================================================
	// Classification (the reconciling pass)
	// =========================================================================

	private runClassification(): void {
		// Local-tree evidence rows exist regardless of the trust gate: a
		// deferred file waits visibly as an unclassified row, not silently.
		for (const path of this.context.localFiles.keys()) {
			if (!this.rowAtPath(path)) this.seedRow(path);
		}

		// The trust gate: never classify against a map with pending sync
		// state — an undelivered deletion reads as a never-present key and
		// would send a deleted path down the publication rung. The host
		// reports the drain with SYNC_DRAINED and the pass re-runs.
		if (this.config.hasPendingSyncState?.()) {
			if (!this.context.classificationDeferred) {
				this.context.classificationDeferred = true;
				this.bump();
			}
			this.warn(
				"classification deferred: folder doc holds pending sync state",
			);
			return;
		}
		if (this.context.classificationDeferred) {
			this.context.classificationDeferred = false;
			this.bump();
		}

		// Decisions made at blind confidence are provisional: the session's
		// first confirmed pass returns them to unclassified and revisits.
		// Acknowledged in-flight work is adopted, never demoted. A row
		// carrying a deferred removal is not a provisional decision — its
		// completion path is the evidence re-derivation below, which a
		// demotion here would hide from.
		if (this.context.tier === "confirmed") {
			for (const row of Array.from(this.context.rows.values())) {
				if (
					row.decidedTier === "blind" &&
					row.state !== "unclassified" &&
					row.state !== "upload.inFlight" &&
					row.state !== "download.inFlight" &&
					row.removalEvidence === undefined
				) {
					row.state = "unclassified";
					row.decidedTier = this.context.tier;
					row.dispatched = false;
					this.bump();
				}
			}
		}

		// Seed rows for map entries this replica has never held rows for.
		// An identity already carried by some row is skipped: one authority
		// per file — its row's own transitions (a rename decision above
		// all) settle where the identity lives.
		const mapEntries = this.config.listMapEntries();
		const mapByGuid = new Map(mapEntries.map((entry) => [entry.guid, entry]));
		for (const entry of mapEntries) {
			if (this.rowAtPath(entry.path)) continue;
			// Rows carrying a non-null guid are always guid-keyed (every
			// guid assignment goes through rekeyRowGuid), so this O(1)
			// lookup is the whole identity check.
			if (this.rowByGuid(entry.guid)) continue;
			this.seedRow(entry.path, entry.guid);
		}

		// Re-derive verdicts for settled rows whose evidence moved while
		// the machine could not act: a synced row whose identity the map
		// no longer holds anywhere was remotely deleted (a real decision —
		// absence alone never deletes; the identity is the association);
		// one whose identity lives at another path moved. Rows carrying a
		// deferred removal complete here too, whatever their state — the
		// event is re-derived from the current map, so an identity
		// re-committed in the meantime voids the evidence instead of
		// replaying it. Evidence completion runs only at confirmed
		// confidence; retained evidence survives a blind pass untouched.
		for (const row of Array.from(this.context.rows.values())) {
			const evidenced =
				row.removalEvidence !== undefined &&
				this.context.tier === "confirmed";
			if (!evidenced && row.state !== "synced") continue;
			const guid = row.guid ?? row.removalEvidence?.guid ?? null;
			if (guid === null) continue;
			if (evidenced) {
				row.removalEvidence = undefined;
				this.bump();
			}
			const inMap = mapByGuid.get(guid);
			if (!inMap) {
				this.tickRow(row, {
					type: "MAP_REMOVED",
					path: row.path,
					guid,
				});
			} else if (inMap.path !== row.path) {
				this.tickRow(row, {
					type: "MAP_MOVED",
					guid,
					from: row.path,
					to: inMap.path,
				});
			}
		}

		// The visit: every row whose node declares a CLASSIFY cell.
		for (const row of Array.from(this.context.rows.values())) {
			// Retired or displaced mid-pass (a rename decision can adopt a
			// seeded row's key): only live row objects are visited.
			if (this.context.rows.get(row.key) !== row) continue;
			if (!CLASSIFY_STATES.has(row.state)) continue;
			this.classifyVisit(row);
		}
		this.drainScheduledClassifies();
	}

	/** Re-run gated dispatches after an authorization (or tier) edge. */
	private revisitGatedRows(): void {
		for (const row of Array.from(this.context.rows.values())) {
			if (row.dispatched) continue;
			if (row.state === "upload.held") {
				this.dispatchUpload(row);
			} else if (row.state === "delete.pending") {
				this.dispatchIndexDelete(row);
			}
		}
	}

	// =========================================================================
	// Folder-event routing into the table
	// =========================================================================

	private routeDelta(
		event: Extract<FolderEvent, { type: "MAP_DELTA" }>,
	): void {
		// Moves first: a same-transaction delete+add sharing one guid is a
		// path update on one identity — structurally incapable of being
		// misread as delete-then-create.
		for (const move of event.moves ?? []) {
			const row = this.rowByGuid(move.guid);
			if (row) {
				this.tickRow(row, { type: "MAP_MOVED", ...move });
			} else {
				const seeded = this.seedRow(move.from, move.guid);
				this.scheduleClassifyRow(seeded);
			}
		}
		for (const del of event.deletes ?? []) {
			const guid = del.oldValue?.id;
			const row =
				this.rowAtPath(del.path) ??
				(guid !== undefined ? this.rowByGuid(guid) : undefined);
			if (row) {
				this.tickRow(row, { type: "MAP_REMOVED", path: del.path, guid });
			} else if (this.context.localFiles.has(del.path)) {
				// A removal for a path the table has never decided about:
				// seed the row and route the removal through it, so the
				// event's identity is retained (or acted on at confirmed
				// confidence) instead of decaying into a bare tombstone the
				// ladder would park on.
				const seeded = this.seedRow(del.path, guid ?? null);
				this.tickRow(seeded, {
					type: "MAP_REMOVED",
					path: del.path,
					guid,
				});
				this.scheduleClassifyRow(seeded);
			}
		}
		const routeAssertion = (
			add: (typeof event.adds)[number],
			type: "MAP_ADDED" | "MAP_UPDATED",
		) => {
			const existing = this.rowAtPath(add.path);
			if (existing) {
				this.tickRow(existing, {
					type,
					path: add.path,
					guid: add.guid,
					fileType: add.type,
				});
			} else {
				const seeded = this.seedRow(add.path, add.guid);
				if (add.type === "folder") seeded.kind = "folder";
				this.scheduleClassifyRow(seeded);
			}
		};
		for (const add of event.adds ?? []) routeAssertion(add, "MAP_ADDED");
		for (const update of event.updates ?? [])
			routeAssertion(update, "MAP_UPDATED");
	}

	private routeFileDiscovered(
		path: string,
		origin: FileOrigin,
		kind?: LocalFileKind,
	): void {
		this.rememberLocalFile(path, origin, kind);
		const row = this.rowAtPath(path);
		if (row) {
			this.tickRow(row, { type: "FILE_DISCOVERED", path, origin, kind });
			// An undecided row is a standing question, and a discovery is
			// the host asking for the answer (the shared-handle fallback
			// depends on it). The visit still honors the trust and tier
			// gates; a row the gates hold stays visibly unclassified.
			if (row.state === "unclassified") this.scheduleClassifyRow(row);
			return;
		}
		const seeded = this.seedRow(path);
		this.scheduleClassifyRow(seeded);
	}

	private routeFileCreated(path: string, kind?: LocalFileKind): void {
		this.rememberLocalFile(path, "interactive", kind);
		this.context.recordedDeleteIntents.delete(path);
		let row = this.rowAtPath(path);
		if (!row) row = this.seedRow(path);
		this.tickRow(row, { type: "FILE_CREATED", path, kind });
	}

	private routeFileDeleted(path: string): void {
		this.context.localFiles.delete(path);
		this.bump();
		let row = this.rowAtPath(path);
		if (!row) row = this.seedRow(path);
		this.tickRow(row, { type: "FILE_DELETED", path });
	}

	private routeFileRenamed(from: string, to: string): void {
		this.rekeyLocalFile(from, to);
		const destination = this.rowAtPath(to);
		if (destination && destination.state === "renaming") {
			// The platform echo of our own rename: the row already sits at
			// the destination awaiting exactly this event.
			this.tickRow(destination, { type: "FILE_RENAMED_IN", from, to });
			return;
		}
		const source = this.rowAtPath(from);
		if (source) {
			this.tickRow(source, { type: "FILE_RENAMED_AWAY", from, to });
			return;
		}
		// Renamed into existence from the machine's perspective.
		this.routeFileCreated(to);
	}

	// =========================================================================
	// Entry guards — the evidence-requirements contract
	// =========================================================================

	private buildEntryGuards(): Record<
		string,
		(row: EntryRow, event: EntryEvent) => boolean
	> {
		const confirmed = () => this.context.tier === "confirmed";
		const heldAt = (path: string) =>
			this.config.holds.getHold(path) !== undefined;
		const eventGuid = (event: EntryEvent): string | undefined => {
			if ("guid" in event && typeof event.guid === "string")
				return event.guid;
			return undefined;
		};
		return {
			indexEntryAtPathWithLocalFile: (row) =>
				this.getMapEntry(row.path) !== undefined &&
				this.context.localFiles.has(row.path),
			holdAdoptable: (row) =>
				this.context.localFiles.has(row.path) &&
				heldAt(row.path) &&
				(row.origin === "interactive" ||
					!this.config.pathTombstoned(row.path)),
			originInteractive: (row) =>
				this.context.localFiles.has(row.path) &&
				row.origin === "interactive",
			recordAliveElsewhere: (row) => {
				if (!confirmed()) return false;
				if (!this.context.localFiles.has(row.path)) return false;
				const recordGuid = this.config.records.getRecordGuid(row.path);
				if (recordGuid === undefined) return false;
				const alive = this.config
					.listMapEntries()
					.find((entry) => entry.guid === recordGuid);
				return alive !== undefined && alive.path !== row.path;
			},
			staleCopyCondemned: (row) => {
				if (!confirmed()) return false;
				if (!this.context.localFiles.has(row.path)) return false;
				// Held-but-unpublished content is never condemned.
				if (heldAt(row.path)) return false;
				const recordGuid = this.config.records.getRecordGuid(row.path);
				if (recordGuid === undefined) return false;
				// Identity decides: a recorded identity that has left the
				// committed map condemns the file it describes, regardless
				// of edits since — the trash keeps the bytes recoverable.
				// Records retire with observed deletions, so a genuinely
				// new file at a reused path carries no record.
				return !this.config
					.listMapEntries()
					.some((entry) => entry.guid === recordGuid);
			},
			tombstonedEmptyDirectory: (row) =>
				confirmed() &&
				row.kind === "folder" &&
				this.context.localFiles.has(row.path) &&
				!heldAt(row.path) &&
				this.config.pathTombstoned(row.path) &&
				!this.hasLocalChildren(row.path),
			tombstoned: (row) =>
				this.context.localFiles.has(row.path) &&
				this.config.pathTombstoned(row.path),
			isLocalFile: (row) => this.context.localFiles.has(row.path),
			recordedDeleteIntent: (row) =>
				this.context.recordedDeleteIntents.has(row.path),
			indexEntryKnown: (row) => this.getMapEntry(row.path) !== undefined,
			identityMatches: (row, event) => {
				if (!confirmed()) return false;
				if (heldAt(row.path)) return false;
				const guid = eventGuid(event);
				if (guid === undefined) return false;
				return (
					guid === row.guid ||
					guid === this.config.records.getRecordGuid(row.path)
				);
			},
			// The pre-confirmation counterpart of identityMatches: the same
			// identity association, one tier early — the removal is retained
			// on the row instead of acted on. Held content stays exempt, and
			// an identity another row already carries is never adopted here
			// (one authority per identity).
			removalDeferredForConfirmation: (row, event) => {
				if (confirmed()) return false;
				if (!this.context.localFiles.has(row.path)) return false;
				if (heldAt(row.path)) return false;
				const guid = eventGuid(event);
				if (guid === undefined) return false;
				if (row.guid !== null) return row.guid === guid;
				return this.rowByGuid(guid) === undefined;
			},
			moveAwayDeferredForConfirmation: (row, event) => {
				if (confirmed()) return false;
				if (event.type !== "MAP_MOVED") return false;
				if (heldAt(row.path)) return false;
				return this.context.localFiles.has(event.from);
			},
			carriesRemovalEvidence: (row) =>
				row.removalEvidence !== undefined,
			committedIdentityAtPath: (row) =>
				this.getMapEntry(row.path) !== undefined,
			tombstonedBootstrapHold: (row) =>
				confirmed() &&
				this.config.pathTombstoned(row.path) &&
				row.origin === "bootstrap",
			observedIdentityStillCommitted: (row) => {
				if (!row.observedIdentity) return false;
				// The deletion took effect exactly when the committed map no
				// longer holds the path this intent removed.
				return this.getMapEntry(row.observedIdentity.path) === undefined;
			},
			mergeableKind: (row, event) => {
				const fileType =
					event.type === "MAP_ADDED" || event.type === "MAP_UPDATED"
						? event.fileType
						: undefined;
				return this.config.mergeableKind?.(fileType) ?? false;
			},
			sourceFilePresent: (row, event) =>
				this.context.tier === "confirmed" &&
				event.type === "MAP_MOVED" &&
				this.context.localFiles.has(event.from),
			destinationPresent: (row, event) =>
				event.type === "MAP_MOVED" &&
				this.context.localFiles.has(event.to),
			verdictKeepLocal: (row, event) =>
				event.type === "RESOLVE_CONFLICT" &&
				event.verdict === "keep-local",
			verdictKeepRemote: (row, event) =>
				this.context.tier === "confirmed" &&
				event.type === "RESOLVE_CONFLICT" &&
				event.verdict === "keep-remote" &&
				!this.context.localFiles.has(row.path),
			verdictKeepRemoteWithLocalFile: (row, event) =>
				this.context.tier === "confirmed" &&
				event.type === "RESOLVE_CONFLICT" &&
				event.verdict === "keep-remote" &&
				this.context.localFiles.has(row.path),
		};
	}

	// =========================================================================
	// Entry actions
	// =========================================================================

	private buildEntryActions(): Record<
		string,
		(row: EntryRow, event: EntryEvent) => void
	> {
		return {
			adoptHold: (row) => {
				const guid = this.config.holds.getHold(row.path);
				if (guid !== undefined && row.guid !== guid) {
					this.rekeyRowGuid(row, guid);
				}
			},
			mintHold: (row) => {
				// Reuse a persisted identity when one exists — retries after
				// restart must not mint fresh guids; the actual mint happens
				// in the host's execution of the upload effect.
				const guid = this.config.holds.getHold(row.path);
				if (guid !== undefined && row.guid !== guid) {
					this.rekeyRowGuid(row, guid);
				}
			},
			upgradeOriginInteractive: (row) => {
				if (row.origin !== "interactive") {
					row.origin = "interactive";
					this.bump();
				}
			},
			setOriginInteractive: (row) => {
				if (row.origin !== "interactive") {
					row.origin = "interactive";
					this.bump();
				}
				row.reason = undefined;
			},
			scheduleClassify: (row) => this.scheduleClassifyRow(row),
			recordDeleteIntent: (row) => {
				this.context.recordedDeleteIntents.add(row.path);
				this.bump();
			},
			retainRemovalEvidence: (row, event) => {
				const guid =
					"guid" in event && typeof event.guid === "string"
						? event.guid
						: undefined;
				if (guid === undefined) return;
				row.removalEvidence = { guid };
				// A guid-less row adopts the identity the removal names —
				// the same adoption the delta router performs when it seeds
				// a removal row. The guard already refused identities other
				// rows carry.
				if (row.guid === null && this.rowByGuid(guid) === undefined) {
					this.rekeyRowGuid(row, guid);
				}
				this.bump();
			},
			recordObservedIdentity: (row) => {
				const guid = row.guid ?? this.getMapEntry(row.path)?.guid;
				if (guid !== undefined) {
					row.observedIdentity = { guid, path: row.path };
					this.bump();
				}
			},
			dropIntent: (row) => {
				row.observedIdentity = undefined;
				this.context.recordedDeleteIntents.delete(row.path);
				this.bump();
			},
			surfaceDrop: (row) => {
				row.reason = DROP_REASON;
				this._surfaceDirty = true;
				this.bump();
			},
			recordReason: (row) => {
				row.reason =
					this.context.authorization === "read-only"
						? PARK_REASON_READ_ONLY
						: PARK_REASON_TOMBSTONE;
				this.bump();
			},
			recordEvidencePair: (row, event) => {
				row.reason = CONFLICT_REASON;
				if (event.type === "MAP_ADDED" || event.type === "MAP_UPDATED") {
					row.observedIdentity = { guid: event.guid, path: row.path };
				}
				this.bump();
			},
			recordContentEvidence: (row, event) => {
				row.contentAgreement = "agrees";
				const guid =
					"guid" in event && typeof event.guid === "string"
						? event.guid
						: null;
				if (guid && row.guid !== guid) this.rekeyRowGuid(row, guid);
				this.bump();
			},
			adoptCommittedIdentity: (row) => {
				const committed = this.getMapEntry(row.path);
				if (committed && row.guid !== committed.guid) {
					this.rekeyRowGuid(row, committed.guid);
				}
			},
			adoptAcknowledgedIdentity: (row, event) => {
				if (event.type !== "WORK_STARTED") return;
				if (row.guid !== event.guid) {
					this.rekeyRowGuid(row, event.guid);
				}
			},
			rekeyRow: (row, event) => {
				if (event.type === "MAP_MOVED") {
					this.rekeyRowPath(row, event.to);
					if (row.guid !== event.guid) this.rekeyRowGuid(row, event.guid);
				} else if (event.type === "FILE_RENAMED_AWAY") {
					this.config.records.moveRecord(event.from, event.to);
					this.rekeyRowPath(row, event.to);
				}
			},
			rekeyRowAndHold: (row, event) => {
				if (event.type !== "FILE_RENAMED_AWAY") return;
				this.config.holds.moveHold(event.from, event.to);
				this.config.records.moveRecord(event.from, event.to);
				this.rekeyRowPath(row, event.to);
			},
			dispatchUploadIfPermitted: (row) => this.dispatchUpload(row),
			redispatchIfUnacknowledged: (row) => {
				// Emission is not execution: decided work re-emits
				// at-least-once until the host acknowledges it.
				if (row.state === "upload.held") {
					this.dispatchUpload(row);
				} else if (row.state === "download.pending") {
					this.dispatchDownload(row);
				}
			},
			emitEnqueueDownload: (row, event) => {
				// A download materializes the identity the group committed at
				// the path. The committed map entry wins, then the event's
				// asserted identity; the row's own guid is only a fallback —
				// a row that reached parked or conflicted with an adopted,
				// never-committed mint must not dispatch that mint, or the
				// work can never execute and the row dead-ends re-emitting it.
				const eventGuid =
					"guid" in event && typeof event.guid === "string"
						? event.guid
						: undefined;
				const guid =
					this.getMapEntry(row.path)?.guid ??
					eventGuid ??
					row.guid ??
					undefined;
				if (guid === undefined) return;
				if (row.guid !== guid) this.rekeyRowGuid(row, guid);
				this.dispatchDownload(row);
			},
			emitTrashLocal: (row, event) => {
				const guid =
					("guid" in event && typeof event.guid === "string"
						? event.guid
						: undefined) ??
					row.guid ??
					this.config.records.getRecordGuid(row.path) ??
					null;
				this.emit({ type: "TRASH_LOCAL", path: row.path, guid });
				row.dispatched = true;
			},
			emitRenameLocal: (row, event) => {
				let from = row.path;
				let to: string | undefined;
				let guid = row.guid ?? undefined;
				if (event.type === "MAP_MOVED") {
					from = event.from;
					to = event.to;
					guid = event.guid;
				} else {
					// Classification: the recorded identity lives elsewhere
					// in the map; the local file follows it.
					const recordGuid = this.config.records.getRecordGuid(row.path);
					const alive = recordGuid
						? this.config
								.listMapEntries()
								.find((entry) => entry.guid === recordGuid)
						: undefined;
					if (!alive) return;
					to = alive.path;
					guid = recordGuid;
				}
				if (to === undefined || guid === undefined) return;
				this.emit({ type: "RENAME_LOCAL", from, to, guid });
				row.dispatched = true;
				// The row awaits the platform echo at the destination.
				if (row.guid !== guid) this.rekeyRowGuid(row, guid);
				this.rekeyRowPath(row, to);
			},
			emitIndexSet: (row, event) => {
				if (event.type !== "FILE_RENAMED_AWAY") return;
				if (this.context.authorization !== "write") {
					row.dispatched = false;
					return;
				}
				this.emit({
					type: "MAP_SET",
					path: event.to,
					oldPath: event.from,
					guid: row.guid ?? undefined,
				});
				row.dispatched = true;
			},
			emitIndexDelete: (row) => {
				if (!row.observedIdentity) {
					const guid = row.guid ?? this.getMapEntry(row.path)?.guid;
					if (guid !== undefined) {
						row.observedIdentity = { guid, path: row.path };
					}
				}
				this.dispatchIndexDelete(row);
			},
			emitPark: (row) => {
				this.emit({
					type: "PARK",
					path: row.path,
					reason: row.reason ?? PARK_REASON_TOMBSTONE,
				});
				this._surfaceDirty = true;
			},
			emitSurfaceStatus: () => {
				this._surfaceDirty = true;
			},
			emitRetractUpload: (row) => {
				// The hold releases with the row: the local file is gone, or
				// a committed identity superseded the unpublished mint. A row
				// that never carried an identity and holds nothing has
				// nothing to retract.
				const guid =
					row.guid ?? this.config.holds.getHold(row.path) ?? null;
				if (guid === null) return;
				this.emit({
					type: "RETRACT_UPLOAD",
					path: row.path,
					guid,
					releaseHold: true,
				});
			},
			emitCancelUploadWork: (row) => {
				// Cancel the queued work but PRESERVE the persisted hold: a
				// hold marks content the server does not have, and its
				// identity is never discarded without a completed
				// publication or an explicit user action.
				this.emit({
					type: "RETRACT_UPLOAD",
					path: row.path,
					guid: row.guid ?? this.config.holds.getHold(row.path) ?? null,
					releaseHold: false,
				});
			},
			retractSupersededMint: (row) => {
				// The row is converging to a committed identity at its path
				// (a remote assertion, or an explicit keep-remote verdict).
				// A never-committed mint the row still carries — a preserved
				// hold adopted while parked or conflicted — is superseded:
				// retract its queued work and release the hold, or the stale
				// identity keeps shadowing the committed one in every
				// path-keyed lookup. Emits nothing when the row carries no
				// superseded identity.
				const committed = this.getMapEntry(row.path)?.guid;
				const minted =
					this.config.holds.getHold(row.path) ?? row.guid ?? null;
				if (minted === null || minted === committed) return;
				this.emit({
					type: "RETRACT_UPLOAD",
					path: row.path,
					guid: minted,
					releaseHold: true,
				});
			},
			retractSupersededMintAndRebind: (row) => {
				// A committed identity is adopting this row while its own
				// mint is unpublished (held or in flight). The mint is
				// superseded — but the row lands directly in `synced`, with
				// no download queued, so a bare retraction would tear the
				// mint down and leave the path with no live document at all.
				// The retraction therefore names the committed identity as
				// the rebind target: the host rebuilds the path's document
				// on the committed history with the bytes on disk as the
				// merge base. When the committed identity IS the row's own
				// mint (our map write replicated back to us), nothing was
				// superseded and nothing retracts — a retraction here would
				// cancel the very upload the committed entry references.
				const committed = this.getMapEntry(row.path)?.guid;
				const minted =
					this.config.holds.getHold(row.path) ?? row.guid ?? null;
				if (minted === null || committed === undefined) return;
				if (minted === committed) return;
				this.emit({
					type: "RETRACT_UPLOAD",
					path: row.path,
					guid: minted,
					releaseHold: true,
					supersededBy: committed,
				});
			},
			cancelWork: (row) => {
				// The identity this download served was removed; the host
				// cancels via the retraction contract for downloads too.
				row.dispatched = false;
			},
		};
	}

	// =========================================================================
	// Gated dispatch helpers
	// =========================================================================

	/**
	 * The dispatch gate for publication: emits only under confirmed
	 * confidence, write authorization, and a posture granting the
	 * origin's upload capability. Otherwise the intent queues silently in
	 * the row and dispatch fires on the tier/authorization edge.
	 */
	private dispatchUpload(row: EntryRow): void {
		if (this.context.tier !== "confirmed") return;
		if (this.context.authorization !== "write") return;
		const capability: FolderCapabilityName =
			row.origin === "interactive"
				? "canUploadInteractive"
				: "canUploadBootstrap";
		if (!this.may(capability)) return;
		this.emit({ type: "ENQUEUE_UPLOAD", path: row.path, origin: row.origin });
		row.dispatched = true;
		this.bump();
	}

	private dispatchDownload(row: EntryRow): void {
		if (row.guid === null) return;
		if (!this.may("canDownload")) return;
		this.emit({ type: "ENQUEUE_DOWNLOAD", path: row.path, guid: row.guid });
		row.dispatched = true;
		this.bump();
	}

	private dispatchIndexDelete(row: EntryRow): void {
		if (this.context.authorization !== "write") return;
		if (!this.may("canMutateMap")) return;
		this.emit({
			type: "MAP_DELETE",
			path: row.path,
			guid: row.observedIdentity?.guid ?? row.guid ?? undefined,
		});
		row.dispatched = true;
		this.bump();
	}

	// =========================================================================
	// Invariants
	// =========================================================================

	/**
	 * Run the state-shaped invariant checks over the current table. The
	 * emit-time invariants (capability grants, blind and read-only gates)
	 * are enforced by throwing in `emit`; these are the observational
	 * ones, run by tests and periodic checkers.
	 */
	checkInvariants(): FolderInvariantViolation[] {
		const violations: FolderInvariantViolation[] = [];
		const report = (
			id: string,
			severity: FolderInvariantViolation["severity"],
			message: string,
			row?: EntryRow,
		) => {
			violations.push({
				id,
				severity,
				message,
				statePath: this._statePath,
				entryState: row?.state,
				path: row?.path,
			});
		};
		for (const row of this.context.rows.values()) {
			if (row.state === "synced") {
				// A deferred removal is the declared exception: the map has
				// already dropped or moved the identity, and the row holds
				// its place until the confirmed pass completes the removal.
				const entry = this.getMapEntry(row.path);
				if (
					row.removalEvidence === undefined &&
					(!entry || (row.guid !== null && entry.guid !== row.guid))
				) {
					report(
						"synced-agrees",
						"error",
						`synced row ${row.path} does not match the committed map`,
						row,
					);
				}
			}
			if (row.state === "parked") {
				if (this.getMapEntry(row.path) !== undefined) {
					report(
						"parked-outside-index",
						"error",
						`parked row ${row.path} has a committed map entry`,
						row,
					);
				}
			}
			if (
				row.state === "upload.inFlight" ||
				row.state === "download.inFlight"
			) {
				if (row.guid === null) {
					report(
						"inflight-implies-ack",
						"warning",
						`in-flight row ${row.path} carries no acknowledged identity`,
						row,
					);
				}
			}
			if (row.state === "conflicted") {
				const hasLocal = this.context.localFiles.has(row.path);
				const hasRemote =
					row.observedIdentity !== undefined ||
					this.getMapEntry(row.path) !== undefined;
				if (!hasLocal || !hasRemote) {
					report(
						"conflict-has-two-evidences",
						"warning",
						`conflicted row ${row.path} lacks positive evidence on both sides`,
						row,
					);
				}
			}
		}
		for (const violation of violations) {
			this.config.onInvariantViolation?.(violation);
		}
		return violations;
	}
}
