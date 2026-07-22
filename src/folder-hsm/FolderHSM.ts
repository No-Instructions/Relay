/**
 * FolderHSM
 *
 * One machine per shared folder, driving event-based membership
 * reconciliation. Membership entries live in
 * the machine's context as a guid-keyed table of dispositions — not as
 * machines. The declarative FOLDER_MACHINE definition is interpreted by
 * the merge-hsm interpreter; guards, actions, and effect emission are
 * bound per instance here.
 *
 * Effects are executed by the host (SharedFolder): trash via Obsidian's
 * trash, uploads/downloads via the existing BackgroundSync paths, map
 * mutations via SyncStore.
 */

import { processEvent } from "../merge-hsm/machine-interpreter";
import type { ActiveInvoke } from "../merge-hsm/types";
import { curryLog } from "../debug";
import { FOLDER_MACHINE } from "./machine-definition";
import type {
	Disposition,
	FileOrigin,
	LocalFileKind,
	FolderContext,
	FolderEffect,
	FolderEvent,
	FolderHSMConfig,
	FolderStatePath,
	FolderSyncSnapshot,
	MapDeltaAdd,
	MapEntrySummary,
	MembershipEntry,
} from "./types";

/** Capability each effect type requires from the current state's node. */
const EFFECT_CAPABILITY: Record<
	Exclude<FolderEffect["type"], "ENQUEUE_UPLOAD">,
	"canDownload" | "canTrash" | "canRenameLocal" | "canMutateMap" | "canPark" | "canEmitEffects"
> = {
	ENQUEUE_DOWNLOAD: "canDownload",
	TRASH_LOCAL: "canTrash",
	RENAME_LOCAL: "canRenameLocal",
	MAP_SET: "canMutateMap",
	MAP_DELETE: "canMutateMap",
	PARK: "canPark",
	SURFACE_STATUS: "canEmitEffects",
};

const PARK_REASON = "bootstrap-discovered file at a tombstoned path";

function freshContext(): FolderContext {
	return {
		persistenceLoaded: false,
		providerSynced: false,
		isOnline: false,
		entries: new Map(),
		entryKeyByPath: new Map(),
		localFiles: new Map(),
		locallyDeleted: new Set(),
		parked: new Map(),
		ladderDeferred: false,
		latchHydrated: false,
	};
}

export class FolderHSM {
	readonly context: FolderContext;
	private _statePath: FolderStatePath = "loading";
	private _activeInvoke: ActiveInvoke | null = null;
	private _processing = false;
	private _queue: FolderEvent[] = [];
	private _currentEventType = "";
	private interpreterConfig: {
		guards: Record<string, (hsm: unknown, event: FolderEvent) => boolean>;
		actions: Record<string, (hsm: unknown, event: FolderEvent) => void>;
		invokeSources: Record<string, never>;
	};
	private warn = curryLog("[FolderHSM]", "warn");

	constructor(private config: FolderHSMConfig) {
		this.context = freshContext();
		this.interpreterConfig = {
			guards: {
				persistenceLoaded: () => this.context.persistenceLoaded,
				hydrated: () =>
					this.context.persistenceLoaded && this.context.providerSynced,
				reconnectPending: () => !this.context.providerSynced,
				ladderDeferred: () => this.context.ladderDeferred,
				latchHydrated: () => this.context.latchHydrated,
			},
			actions: {
				resetContext: () => this.resetContext(),
				markPersistenceLoaded: () => {
					this.context.persistenceLoaded = true;
				},
				markProviderSynced: (_hsm, event) => {
					if (event.type === "PROVIDER_SYNCED" && event.latch) {
						// The persisted latch can declare hydration but never
						// confirm it: a pass classified under it runs ahead of
						// the session's first handshake and stays provisional.
						// A latch claim after a completed handshake changes
						// nothing.
						if (!this.context.providerSynced) {
							this.context.latchHydrated = true;
						}
					} else {
						this.context.latchHydrated = false;
					}
					this.context.providerSynced = true;
				},
				setOnline: () => {
					this.context.isOnline = true;
				},
				setOffline: () => {
					this.context.isOnline = false;
					this.context.providerSynced = false;
				},
				absorbMapDelta: () => {
					// The map itself is the durable record; reconciling re-reads
					// it via listMapEntries. Nothing to classify before hydration.
				},
				absorbDiscoveredFile: (_hsm, event) => {
					if (event.type !== "FILE_DISCOVERED") return;
					this.rememberLocalFile(event.path, event.origin, event.kind);
				},
				absorbInteractiveCreate: (_hsm, event) => {
					if (event.type !== "FILE_CREATED") return;
					this.rememberLocalFile(event.path, "interactive", event.kind);
					this.context.locallyDeleted.delete(event.path);
				},
				absorbLocalDelete: (_hsm, event) => {
					if (event.type !== "FILE_DELETED") return;
					this.context.localFiles.delete(event.path);
					this.context.locallyDeleted.add(event.path);
				},
				absorbLocalRename: (_hsm, event) => {
					if (event.type !== "FILE_RENAMED") return;
					this.rekeyLocalFile(event.from, event.to);
				},
				runProvenanceLadder: () => this.runProvenanceLadder(),
				applyMapDelta: (_hsm, event) => {
					if (event.type !== "MAP_DELTA") return;
					this.applyMapDelta(event);
				},
				trackDiscoveredFile: (_hsm, event) => {
					if (event.type !== "FILE_DISCOVERED") return;
					this.trackDiscoveredFile(event.path, event.origin, event.kind);
				},
				handleInteractiveCreate: (_hsm, event) => {
					if (event.type !== "FILE_CREATED") return;
					this.handleInteractiveCreate(event.path, event.kind);
				},
				handleLocalDelete: (_hsm, event) => {
					if (event.type !== "FILE_DELETED") return;
					this.handleLocalDelete(event.path);
				},
				handleLocalRename: (_hsm, event) => {
					if (event.type !== "FILE_RENAMED") return;
					this.handleLocalRename(event.from, event.to);
				},
				settleUpload: (_hsm, event) => {
					if (event.type !== "UPLOAD_COMPLETE") return;
					this.upsertEntry(event.guid, event.path, "synced");
					this.rememberLocalFile(event.path, "bootstrap");
				},
				settleDownload: (_hsm, event) => {
					if (event.type !== "DOWNLOAD_COMPLETE") return;
					this.upsertEntry(event.guid, event.path, "synced");
					this.rememberLocalFile(event.path, "bootstrap");
				},
				settleDownloadFailure: (_hsm, event) => {
					if (event.type !== "DOWNLOAD_FAILED") return;
					this.settleDownloadFailure(event.path, event.guid);
				},
				settleTrash: (_hsm, event) => {
					if (event.type !== "TRASH_COMPLETE") return;
					this.removeEntryAtPath(event.path);
					this.context.localFiles.delete(event.path);
				},
			},
			invokeSources: {},
		};
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
	}

	// =========================================================================
	// Projections
	// =========================================================================

	/**
	 * Whether the engine currently knows `path` as a local file. The host's
	 * origin discriminator uses this to keep re-observations of already
	 * scanned paths from laundering into interactive intent.
	 */
	hasLocalFile(path: string): boolean {
		return this.context.localFiles.has(path);
	}

	getSnapshot(): FolderSyncSnapshot {
		return {
			statePath: this._statePath,
			hydrated:
				this.context.persistenceLoaded && this.context.providerSynced,
			isOnline: this.context.isOnline,
			entries: Array.from(this.context.entries.values()).map((entry) => ({
				...entry,
			})),
			parked: Array.from(this.context.parked.entries()).map(
				([path, reason]) => ({ path, reason }),
			),
		};
	}

	// =========================================================================
	// Effect emission — capability-checked against the machine definition
	// =========================================================================

	private stateCapabilities() {
		return FOLDER_MACHINE[this._statePath]?.capabilities ?? {};
	}

	private emit(effect: FolderEffect): void {
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
		this.config.onEffect(effect);
	}

	// =========================================================================
	// Per-item predicates (guards applied per membership entry)
	// =========================================================================

	private hasLocalRecord(path: string): boolean {
		return this.config.getLocalRecordGuid(path) !== undefined;
	}

	private guidMatchesLocalRecord(path: string, guid: string): boolean {
		const entryKey = this.context.entryKeyByPath.get(path);
		const entry = entryKey ? this.context.entries.get(entryKey) : undefined;
		if (
			entry &&
			entry.guid === guid &&
			entry.path === path &&
			entry.disposition === "synced"
		) {
			return true;
		}
		return this.config.getLocalRecordGuid(path) === guid;
	}

	private pathTombstoned(path: string): boolean {
		return this.config.pathTombstoned(path);
	}

	private originInteractive(path: string): boolean {
		return this.context.localFiles.get(path)?.origin === "interactive";
	}

	// =========================================================================
	// Context bookkeeping
	// =========================================================================

	private resetContext(): void {
		const fresh = freshContext();
		Object.assign(this.context, fresh);
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
	}

	private hasLocalChildren(path: string): boolean {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		for (const candidate of this.context.localFiles.keys()) {
			if (candidate !== path && candidate.startsWith(prefix)) return true;
		}
		return false;
	}

	private rekeyLocalFile(from: string, to: string): void {
		const info = this.context.localFiles.get(from);
		this.context.localFiles.delete(from);
		this.context.localFiles.set(
			to,
			info ?? { origin: "interactive", kind: "file" },
		);
		this.context.locallyDeleted.delete(to);
	}

	private entryKeyFor(guid: string | null, path: string): string {
		return guid ?? `path:${path}`;
	}

	private upsertEntry(
		guid: string | null,
		path: string,
		disposition: Disposition,
	): MembershipEntry {
		// Displace any existing entry for this path (a provisional guid-less
		// entry being re-keyed after a guid was minted, or a stale mapping).
		const previousKey = this.context.entryKeyByPath.get(path);
		if (previousKey !== undefined) {
			this.context.entries.delete(previousKey);
			this.context.entryKeyByPath.delete(path);
		}
		const entry: MembershipEntry = { guid, path, disposition };
		const key = this.entryKeyFor(guid, path);
		this.context.entries.set(key, entry);
		this.context.entryKeyByPath.set(path, key);
		return entry;
	}

	private entryByGuid(guid: string): MembershipEntry | undefined {
		return this.context.entries.get(guid);
	}

	private entryAtPath(path: string): MembershipEntry | undefined {
		const key = this.context.entryKeyByPath.get(path);
		return key !== undefined ? this.context.entries.get(key) : undefined;
	}

	private removeEntryAtPath(path: string): void {
		const key = this.context.entryKeyByPath.get(path);
		if (key === undefined) return;
		this.context.entries.delete(key);
		this.context.entryKeyByPath.delete(path);
	}

	private removeEntryByGuid(guid: string): void {
		const entry = this.context.entries.get(guid);
		if (!entry) return;
		this.context.entries.delete(guid);
		if (this.context.entryKeyByPath.get(entry.path) === guid) {
			this.context.entryKeyByPath.delete(entry.path);
		}
	}

	private movePath(entry: MembershipEntry, to: string, disposition: Disposition): void {
		const key = this.entryKeyFor(entry.guid, entry.path);
		this.context.entryKeyByPath.delete(entry.path);
		entry.path = to;
		entry.disposition = disposition;
		const newKey = this.entryKeyFor(entry.guid, to);
		if (newKey !== key) {
			this.context.entries.delete(key);
			this.context.entries.set(newKey, entry);
		}
		this.context.entryKeyByPath.set(to, newKey);
	}

	private getMapEntry(path: string): MapEntrySummary | undefined {
		if (this.config.getMapEntry) return this.config.getMapEntry(path);
		return this.config.listMapEntries().find((entry) => entry.path === path);
	}

	// =========================================================================
	// The bootstrap provenance ladder (reconciling's transition logic)
	// =========================================================================

	private runProvenanceLadder(): void {
		const ctx = this.context;
		// Never classify against a map with pending sync state: an
		// undelivered deletion reads as a never-present key, sends a
		// deleted path down the upload rung, and resurrects it for every
		// peer. Defer the whole pass; the host reports the drain with
		// SYNC_DRAINED and the ladder re-runs then. This must probe the
		// live doc — a persisted readiness latch can be stale.
		if (this.config.hasPendingSyncState?.()) {
			ctx.ladderDeferred = true;
			this.warn(
				"provenance ladder deferred: folder doc holds pending sync state",
			);
			return;
		}
		ctx.ladderDeferred = false;
		const mapEntries = this.config.listMapEntries();
		const mapByPath = new Map(mapEntries.map((entry) => [entry.path, entry]));
		const mapByGuid = new Map(mapEntries.map((entry) => [entry.guid, entry]));

		ctx.entries.clear();
		ctx.entryKeyByPath.clear();
		ctx.parked.clear();
		let parkedCount = 0;

		// Local files with no current map entry walk the ladder in order.
		for (const [path, info] of Array.from(ctx.localFiles)) {
			const mapEntry = mapByPath.get(path);
			if (mapEntry) {
				this.upsertEntry(mapEntry.guid, path, "synced");
				continue;
			}

			// Rung 1: ours, awaiting → upload. A hold outranks the ladder
			// only while it does not contradict a visible deletion: a
			// tombstoned path holding a bootstrap-origin hold means the hold
			// was minted by a pass that could not yet see the deletion — a
			// re-run must correct that decision, not replay it. The hold is
			// disregarded and the path falls through to the rungs below
			// (record, tombstone), which park or trash but never upload.
			// Interactive origin keeps its intent: the user (re)created the
			// path on purpose this session.
			const pendingGuid = this.config.getPendingUploadGuid(path);
			if (
				pendingGuid !== undefined &&
				(info.origin === "interactive" || !this.pathTombstoned(path))
			) {
				this.upsertEntry(pendingGuid, path, "pendingUpload");
				this.emit({ type: "ENQUEUE_UPLOAD", path, origin: info.origin });
				continue;
			}

			// Interactive creation expresses user intent to (re)share the
			// path — it always uploads, tombstone or stale record be damned
			// (parking applies only to bootstrap origin; a stale record belongs
			// to the previous file, not to content the user just created).
			if (info.origin === "interactive") {
				this.emit({ type: "ENQUEUE_UPLOAD", path, origin: "interactive" });
				this.upsertEntry(
					this.config.getPendingUploadGuid(path) ?? null,
					path,
					"pendingUpload",
				);
				continue;
			}

			// Rung 2: stale materialization of a previously synced file.
			const recordGuid = this.config.getLocalRecordGuid(path);
			if (recordGuid !== undefined) {
				const guidElsewhere = mapByGuid.get(recordGuid);
				if (guidElsewhere && guidElsewhere.path !== path) {
					// Pure path move: rename, do not trash.
					this.upsertEntry(recordGuid, guidElsewhere.path, "pendingRename");
					this.emit({
						type: "RENAME_LOCAL",
						from: path,
						to: guidElsewhere.path,
						guid: recordGuid,
					});
				} else {
					this.upsertEntry(recordGuid, path, "pendingTrash");
					this.emit({ type: "TRASH_LOCAL", path, guid: recordGuid });
				}
				continue;
			}

			// Rung 3: previously deleted path, no proof of new content → park.
			if (this.pathTombstoned(path)) {
				// Folder-entry rule: an empty local directory at a tombstoned
				// path holds no user content to protect — trash it so remote
				// directory deletions converge instead of leaving parked husks
				// (folders have no HSM/hash local record, so rung 2 can never
				// re-trash them). A directory with unclassified children keeps
				// its parking; the children walk the ladder on their own.
				if (info.kind === "folder" && !this.hasLocalChildren(path)) {
					this.upsertEntry(null, path, "pendingTrash");
					this.emit({ type: "TRASH_LOCAL", path, guid: null });
					continue;
				}
				ctx.parked.set(path, PARK_REASON);
				this.upsertEntry(null, path, "parked");
				this.emit({ type: "PARK", path, reason: PARK_REASON });
				parkedCount += 1;
				continue;
			}

			// Rung 4: genuinely new content → upload.
			this.emit({ type: "ENQUEUE_UPLOAD", path, origin: "bootstrap" });
			this.upsertEntry(
				this.config.getPendingUploadGuid(path) ?? null,
				path,
				"pendingUpload",
			);
		}

		// Map entries with no local file: download — unless a pre-hydration
		// interactive delete recorded the opposite intent.
		for (const mapEntry of mapEntries) {
			if (ctx.localFiles.has(mapEntry.path)) continue;
			if (ctx.entryKeyByPath.has(mapEntry.path)) continue; // rename target
			if (ctx.locallyDeleted.has(mapEntry.path)) {
				this.upsertEntry(mapEntry.guid, mapEntry.path, "pendingMapDelete");
				this.emit({
					type: "MAP_DELETE",
					path: mapEntry.path,
					guid: mapEntry.guid,
				});
				continue;
			}
			this.upsertEntry(mapEntry.guid, mapEntry.path, "pendingDownload");
			this.emit({
				type: "ENQUEUE_DOWNLOAD",
				path: mapEntry.path,
				guid: mapEntry.guid,
			});
		}
		ctx.locallyDeleted.clear();

		if (parkedCount > 0) {
			this.emit({ type: "SURFACE_STATUS" });
		}
	}

	// =========================================================================
	// Steady state (tracking)
	// =========================================================================

	private applyMapDelta(event: Extract<FolderEvent, { type: "MAP_DELTA" }>): void {
		const ctx = this.context;

		// Moves first: a same-transaction delete+add with one guid is a path
		// update on an existing entry — structurally incapable of being
		// misread as delete-then-create.
		for (const move of event.moves ?? []) {
			const entry = this.entryByGuid(move.guid);
			if (ctx.localFiles.has(move.from)) {
				if (entry) {
					this.movePath(entry, move.to, "pendingRename");
				} else {
					this.upsertEntry(move.guid, move.to, "pendingRename");
				}
				this.emit({
					type: "RENAME_LOCAL",
					from: move.from,
					to: move.to,
					guid: move.guid,
				});
			} else if (ctx.localFiles.has(move.to)) {
				if (entry) this.movePath(entry, move.to, "synced");
				else this.upsertEntry(move.guid, move.to, "synced");
			} else {
				if (entry) this.movePath(entry, move.to, "pendingDownload");
				else this.upsertEntry(move.guid, move.to, "pendingDownload");
				this.emit({ type: "ENQUEUE_DOWNLOAD", path: move.to, guid: move.guid });
			}
		}

		// Unpaired deletes trash the local file iff the removal is positively
		// associated with it: the removed guid matches the locally
		// recorded guid for that path.
		for (const del of event.deletes ?? []) {
			const guid = del.oldValue?.id;
			const hasLocalFile = ctx.localFiles.has(del.path);
			if (!hasLocalFile) {
				if (guid !== undefined) this.removeEntryByGuid(guid);
				continue;
			}
			if (guid !== undefined && this.guidMatchesLocalRecord(del.path, guid)) {
				this.upsertEntry(guid, del.path, "pendingTrash");
				this.emit({ type: "TRASH_LOCAL", path: del.path, guid });
			} else {
				// Path now hosts different content (recreation) — never trash.
				if (guid !== undefined) this.removeEntryByGuid(guid);
			}
		}

		for (const add of [...(event.adds ?? []), ...(event.updates ?? [])]) {
			this.applyMapAdd(add);
		}
	}

	private applyMapAdd(add: MapDeltaAdd): void {
		if (this.context.localFiles.has(add.path)) {
			this.upsertEntry(add.guid, add.path, "synced");
			return;
		}
		// Re-emission for an entry already pendingDownload is deliberate:
		// emission does not prove execution — the host's enqueue can drop
		// against a mid-sync store — and a split-transaction join delivers
		// a later delta for exactly these keys. The downstream path dedups:
		// re-created files return early above, in-flight downloads are keyed
		// by path, and the queue dedups by guid.
		this.upsertEntry(add.guid, add.path, "pendingDownload");
		this.emit({ type: "ENQUEUE_DOWNLOAD", path: add.path, guid: add.guid });
	}

	/**
	 * A download attempt failed, or the host dropped the enqueue before it
	 * reached the queue. The entry stays pendingDownload: retries are
	 * delta-driven (applyMapAdd re-emits on the next add or update of the
	 * key) and hydration-driven (a fresh hydrate re-emits for map entries
	 * without local files). No re-emission here — the host's enqueue guard
	 * reports failure synchronously, so an immediate retry would loop.
	 */
	private settleDownloadFailure(path: string, guid: string): void {
		const entry = this.entryByGuid(guid);
		if (!entry || entry.path !== path) return;
		if (entry.disposition !== "pendingDownload") return;
	}

	private trackDiscoveredFile(
		path: string,
		origin: FileOrigin,
		kind?: LocalFileKind,
	): void {
		this.rememberLocalFile(path, origin, kind);
		const mapEntry = this.getMapEntry(path);
		if (mapEntry) {
			const entry = this.entryAtPath(path);
			if (
				!entry ||
				entry.guid !== mapEntry.guid ||
				entry.disposition === "pendingDownload"
			) {
				// Discovery of a mapped path settles missing entries and
				// downloads whose completion event was missed.
				this.upsertEntry(mapEntry.guid, path, "synced");
			}
		}
		// Bootstrap-origin classification (uploads, rung-2 trash) is
		// reconciling's job: it reruns on the next connect. Recording
		// the observation here is the whole job of the sweep event source.
	}

	private handleInteractiveCreate(path: string, kind?: LocalFileKind): void {
		this.rememberLocalFile(path, "interactive", kind);
		// A live create supersedes any recorded delete intent and unparks.
		this.context.locallyDeleted.delete(path);
		if (this.context.parked.has(path)) {
			this.context.parked.delete(path);
			this.removeEntryAtPath(path);
		}
		const mapEntry = this.getMapEntry(path);
		if (mapEntry) {
			// Materialization of an already-shared path (e.g. a download).
			this.upsertEntry(mapEntry.guid, path, "synced");
			return;
		}
		const existing = this.entryAtPath(path);
		if (existing && existing.disposition === "pendingUpload") {
			return; // already queued
		}
		this.emit({ type: "ENQUEUE_UPLOAD", path, origin: "interactive" });
		this.upsertEntry(
			this.config.getPendingUploadGuid(path) ?? null,
			path,
			"pendingUpload",
		);
	}

	private handleLocalDelete(path: string): void {
		this.context.localFiles.delete(path);
		const entry = this.entryAtPath(path);
		if (entry?.disposition === "pendingTrash") {
			// Echo of our own TRASH_LOCAL; completion arrives as TRASH_COMPLETE.
			return;
		}
		if (entry?.disposition === "parked" || this.context.parked.has(path)) {
			// Parked paths have no map entry and no pending upload: deleting
			// the local file simply retires the parked state. Emitting a map
			// delete here would be an op that internally no-ops.
			this.context.parked.delete(path);
			this.removeEntryAtPath(path);
			return;
		}
		const mapEntry = this.getMapEntry(path);
		const guid = entry?.guid ?? mapEntry?.guid;
		if (entry || mapEntry) {
			this.emit({ type: "MAP_DELETE", path, guid: guid ?? undefined });
			this.removeEntryAtPath(path);
		} else {
			// Unknown to the map and to the table: remember the intent so a
			// later reconcile does not resurrect the path.
			this.context.locallyDeleted.add(path);
		}
	}

	private handleLocalRename(from: string, to: string): void {
		this.rekeyLocalFile(from, to);

		// Echo of a RENAME_LOCAL we asked for: the entry already sits at the
		// destination path awaiting exactly this event.
		const destination = this.entryAtPath(to);
		if (destination && destination.disposition === "pendingRename") {
			destination.disposition = "synced";
			return;
		}

		const entry = this.entryAtPath(from);
		if (entry) {
			const guid = entry.guid;
			this.movePath(entry, to, entry.disposition);
			this.emit({
				type: "MAP_SET",
				path: to,
				oldPath: from,
				guid: guid ?? undefined,
			});
			return;
		}

		// Renamed into existence from the machine's perspective.
		this.handleInteractiveCreate(to);
	}
}
