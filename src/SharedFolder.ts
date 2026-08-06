"use strict";
import { uuidv4 } from "lib0/random";
import {
	FileManager,
	type MetadataCache,
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	debounce,
	type Debouncer,
	getFrontMatterInfo,
	normalizePath,
	parseYaml,
	stringifyYaml,
} from "obsidian";
import {
	IndexeddbPersistence,
} from "./storage/y-indexeddb";
import { dirname, join, sep } from "path-browserify";
import { HasProvider, type ConnectionIntent } from "./HasProvider";
import type { EventMessage } from "./client/provider";
import { Document } from "./Document";
import { ObservableSet } from "./observable/ObservableSet";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";

import { SharedPromise, Dependency, withTimeoutWarning } from "./promiseUtils";
import { S3Folder, S3RN, S3RemoteFolder, S3RemoteDocument } from "./S3RN";
import type { RemoteSharedFolder } from "./Relay";
import { RelayManager } from "./RelayManager";
import type { Unsubscriber } from "svelte/store";
import {
	BackgroundSync,
	type SyncCompletionOutcome,
} from "./BackgroundSync";
import type { NamespacedSettings } from "./SettingsStorage";
import { RelayInstances, metrics } from "./debug";
import { LocalStorage } from "./LocalStorage";
import type { MergeHSM } from "./merge-hsm/MergeHSM";
import { SyncFolder, isSyncFolder } from "./SyncFolder";
import { isDocument } from "./Document";
import { SyncStore } from "./SyncStore";
import { FolderHSM } from "./folder-hsm/FolderHSM";
import { MembershipSnapshot } from "./folder-hsm/MembershipSnapshot";
import { ServerOps } from "./folder-hsm/ServerOps";
import {
	SyncType,
	makeCanvasMeta,
	makeDocumentMeta,
	makeFileMeta,
	makeFolderMeta,
	isFileMetas,
	isDocumentMeta,
	isCanvasMeta,
	type FileMeta,
	type FileMetas,
	type Meta,
	type SyncFileType,
} from "./SyncTypes";
import type { IFile } from "./IFile";
import { formatDuplicateGuidLog } from "./FileLogDetails";
import { createProtectionProxy } from "./pathProxy";
import { ContentAddressedStore } from "./CAS";
import { SyncSettingsManager, type SyncFlags } from "./SyncSettings";
import { ContentAddressedFileStore, SyncFile, isSyncFile } from "./SyncFile";
import { Canvas, isCanvas } from "./Canvas";
import { FeatureFlagManager, flags } from "./flagManager";
import { MergeManager } from "./merge-hsm/MergeManager";
import {
	E2ERecordingBridge,
	type HSMLogEntry,
} from "./merge-hsm/recording";
import { recordHSMEntry } from "./debug";
import { trackAsyncCleanup } from "./reloadUtils";
import { DestroyedError, isDestroyedError } from "./DestroyedError";
import {
	isServerUpdateSink,
	isSyncParticipant,
	type PlanContext,
	type PlanOccasion,
	type SyncParticipant,
} from "./background-sync/SyncParticipant";
import type { WorkRequest } from "./background-sync/WorkRequest";
import { readNoteText } from "./diskText";
import {
	HSMStore,
} from "./merge-hsm/persistence";
import type { PersistedCanvasState } from "./merge-hsm/types";
import { trackPromise } from "./trackPromise";
import {
	RemoteActivityIndex,
	REMOTE_ACTIVITY_RETENTION_MS,
	type RemoteActivityEntry,
	normalizeRemoteActivityTimestamp,
} from "./RemoteActivityIndex";
import { expandDesiredRemotePaths } from "./syncPathUtils";
import type { TimeProvider } from "./TimeProvider";
import * as Y from "yjs";

export interface SharedFolderSettings {
	guid: string;
	path: string;
	relay?: string;
	connect?: boolean;
	localOnly?: boolean;
	sync?: SyncFlags;
	remoteActivity?: RemoteActivityEntry[];
	/**
	 * The folder's local copy left the vault (root deletion classified as
	 * detach). The registration is kept — relinkable if the folder returns —
	 * and expires after the deletion retention window.
	 */
	suspended?: boolean;
	suspendedAt?: number;
}

interface Operation {
	op: "create" | "rename" | "delete" | "update" | "upgrade" | "noop";
	path: string;
	promise: Promise<void | IFile | undefined>;
}

interface Create extends Operation {
	op: "create";
	path: string;
	promise: Promise<IFile | undefined>;
}

interface Rename extends Operation {
	op: "rename";
	path: string;
	from: string;
	to: string;
	promise: Promise<void>;
}

interface Delete extends Operation {
	op: "delete";
	path: string;
	promise: Promise<void>;
}

interface Update extends Operation {
	op: "update";
	path: string;
	promise: Promise<void>;
}

interface Upgrade extends Operation {
	op: "upgrade";
	path: string;
	promise: Promise<void>;
}

interface Noop extends Operation {
	op: "noop";
	path: string;
	promise: Promise<void>;
}

type OperationType = Create | Rename | Delete | Update | Upgrade | Noop;

type PendingPublicationDecision = "noop" | "delete" | "rebind" | "publish";

interface PendingPublicationRun {
	decision: PendingPublicationDecision;
	pendingGuid: string;
	rerun: boolean;
	cancelled: boolean;
	supersedingMeta?: Meta;
	promise: Promise<void>;
}

// Empty downloads for a guid become terminal after this many attempts; the
// server pushes a document.updated event (and lists the guid in the
// subdoc index) once content exists, so polling past this is wasted work.
const MAX_EMPTY_SERVER_ATTEMPTS = 3;

// Vault-delete echo suppression tokens outlive the slowest observed
// reconcile dispatch (seconds) by a wide margin, and expire so a stale
// token cannot swallow a genuine user deletion later.
export const PENDING_DELETE_TTL_MS = 60 * 1000;

// Cadence of the pending-download re-arm sweep. Slow enough to stay quiet,
// fast enough that a joiner racing the sharer's content staging converges
// within a couple of ticks.
export const DOWNLOAD_SWEEP_INTERVAL_MS = 10_000;

// A genuinely-new file registers only after settling for this window. External
// atomic writes (write `<name>.tmp.<pid>.<hash>`, then rename onto `<name>`) and
// editor swap files surface as short-lived creates that a rename or delete
// removes within a few milliseconds; waiting lets them vanish before we mint a
// guid or enqueue an upload. Startup discovery and already-known files skip the
// wait — only novel interactive creates settle.
export const NEW_FILE_REGISTRATION_DEBOUNCE_MS = 500;
// Suspended registrations expire after this window so abandoned local state
// does not remain eligible for restoration indefinitely.
export const FOLDER_DELETION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Window over which per-file reader-edit-overwrite notices coalesce into one. */
export const READER_EDIT_OVERWRITE_COALESCE_MS = 300;
/** How long the coalesced reader-edit-overwrite notice stays on screen. */
export const READER_EDIT_OVERWRITE_NOTICE_MS = 12_000;
/** Suppress repeated Reader-rejection notices for a path while one is visible. */
export const READER_EDIT_OVERWRITE_COOLDOWN_MS =
	READER_EDIT_OVERWRITE_NOTICE_MS;
class Files extends ObservableSet<IFile> {
	// Startup performance optimization
	notifyListeners = debounce(() => super.notifyListeners(), 100);

	update() {
		this.notifyListeners();
		return;
	}

	destroy(): void {
		this.notifyListeners.cancel();
		this._set.clear();
		super.destroy();
	}

	add(item: IFile): ObservableSet<IFile> {
		const existing = this.find((file) => file.guid === item.guid);
		if (existing && existing !== item) {
			this.error(formatDuplicateGuidLog(existing, item));
			this._set.delete(existing);
		}
		const isNew = !this._set.has(item);
		this._set.add(item);
		if (isNew) {
			this.notifyListeners();
		}
		return this;
	}
}

export class SharedFolder extends HasProvider {
	path: string;
	files: Map<string, IFile>; // Maps guids to SharedDocs
	// Guids learned per TAbstractFile instance; entries die with the
	// instance, so a delete-and-recreate can never resolve stale.
	private tfileGuids = new WeakMap<TAbstractFile, string>();
	fset: Files;
	relayId?: string;
	_remote?: RemoteSharedFolder;
	// Last observed content-write permission; null until the role
	// subscription delivers its first snapshot.
	private _lastCanWriteContent: boolean | null = null;
	private _lastCanManageFiles: boolean | null = null;
	private _roleSnapshotReceived = false;
	/** Cached tri-state role-policy answer; undefined means invalidated. */
	private _canWriteContentAnswerCache: boolean | null | undefined = undefined;
	/** Cached folder-structure policy answer; undefined means invalidated. */
	private _canManageFilesAnswerCache: boolean | null | undefined = undefined;
	_shouldConnect: boolean;
	private _localOnly: boolean;
	destroyed: boolean = false;
	public vault: Vault;
	syncStore: SyncStore;
	private _server?: string;
	private fileManager: FileManager;
	private relayManager: RelayManager;
	private readyPromise: Dependency<SharedFolder> | null = null;
	private whenSyncedPromise: Dependency<void> | null = null;
	private persistenceSynced: boolean = false;
	private syncFileTreePromise: SharedPromise<void> | null = null;
	private syncRequestedDuringSync: boolean = false;
	private authoritative: boolean;
	private pendingUpload: LocalStorage<string>;
	private unsubscribes: Unsubscriber[] = [];
	private storageQuota?: number;
	/**
	 * One-shot suppression tokens for vault-delete echoes of our own trash
	 * effects, vpath → marked-at. Obsidian dispatches reconcile events
	 * seconds after the underlying rename resolves, so tokens are consumed
	 * by the event they suppress (consumePendingDelete) or expire by TTL —
	 * never cleared on completion of the filesystem operation.
	 */
	private pendingDeletes: Map<string, number> = new Map();
	/**
	 * Debounce timers for genuinely-new file registrations, vpath → timer id.
	 * A short-lived file (atomic-write temp file, editor swap file) that
	 * vanishes within the window is cancelled before it registers.
	 */
	private pendingCreates: Map<string, number> = new Map();
	/** Vault rename echoes produced while restoring a Reader-rejected move. */
	private readerRestoreRenameEchoes: Set<string> = new Set();
	private enabledSyncTypes: Set<SyncType> = new Set();

	private _persistence: IndexeddbPersistence;
	/** Paths of Reader edits a repair sweep overwrote, pending one coalesced notice. */
	private _readerEditOverwrites: string[] = [];
	private _readerEditOverwriteTimer: number | null = null;
	/** Paths already surfaced while their notice remains visible. */
	private _recentReaderEditOverwrites: Map<string, number> = new Map();
	proxy: SharedFolder;
	cas: ContentAddressedStore;
	syncSettingsManager: SyncSettingsManager;
	mergeManager: MergeManager;
	private recordingBridge: E2ERecordingBridge;
	private _pendingRemaps: Set<string> = new Set();
	/**
	 * Paths whose download stepped aside for an in-flight reconciliation. The
	 * reconciliation re-drives them when it finishes: without this the deferred
	 * work would only be picked up by the download sweep, which the default
	 * configuration does not run.
	 */
	private _downloadsDeferredByRemap: Set<string> = new Set();
	/**
	 * Reconciliations that stood aside for one already running on their path,
	 * keyed by path. The running one re-drives them when it finishes, for the
	 * same reason downloads get re-driven: nothing else re-detects the newer
	 * identity until the next sweep.
	 */
	private _remapsDeferredByRemap: Map<
		string,
		{ path: string; fromGuid: string; toGuid: string }
	> = new Map();
	/**
	 * Paths whose download stood down because the document is carrying work of
	 * its own, keyed by path. Standing down is only cheap when there is a way
	 * back, and this branch had none: no reconciliation is involved, so the
	 * reconciliation's resume cannot discharge it, and the periodic download
	 * sweep does not run on the default configuration. A file that silently
	 * never arrives is the same loss in the other direction.
	 *
	 * So each record carries a subscription to the document's own machine, and
	 * the download is re-driven the moment that machine's answer changes — on
	 * the state the refusal was actually made from, not on a timer.
	 */
	private _downloadsDeferredByState: Map<
		string,
		{ guid: string; hsm: MergeHSM; unsubscribe: () => void }
	> = new Map();
	private _pendingDownloads: Set<string> = new Set();
	private _pendingDownloadPromises: Map<string, Promise<Document | undefined>> =
		new Map();
	/**
	 * Empty-download attempts per GUID the server has registered but returned
	 * no content for. After MAX_EMPTY_SERVER_ATTEMPTS the guid is terminal:
	 * downloads and remaps stop until fresh server evidence arrives (a
	 * document.updated event or a subdoc-index entry for the guid), so
	 * recurring sweeps do not re-request known-empty documents.
	 */
	private _emptyOnServer: Map<string, number> = new Map();
	/** Boot posture and the connect/mint/publish permissions. */
	private folderMachine: FolderHSM;
	/** Membership as known at replay completion; null once the initial
	 * reconcile has decided every entry. */
	private bootSnapshot: MembershipSnapshot | null = null;
	/** Server-decided operations whose disk effect is still in flight. */
	private serverOps = new ServerOps();
	/** One parked publication re-entry per held path. */
	private _parkedPublications: Map<string, Promise<void>> = new Map();
	/** One publication decision executor per held path. */
	private _publicationRuns: Map<string, PendingPublicationRun> = new Map();
	/** Document enrollment is single-flight and remains complete per live doc. */
	private _pendingDocumentEnrollments: WeakMap<Document, Promise<void>> =
		new WeakMap();
	private readonly remoteActivityIndex = new RemoteActivityIndex();
	private readonly remoteActivitySubscribers = new Set<() => void>();
	private connectionAttempt: Promise<boolean> | null = null;
	private startupConnectRequested = false;
	/** UI consumers watching the current user's folder permissions flip. */
	private readonly folderPermissionSubscribers = new Set<() => void>();

	constructor(
		public appId: string,
		guid: string,
		path: string,
		loginManager: LoginManager,
		vault: Vault,
		private metadataCache: MetadataCache | undefined,
		fileManager: FileManager,
		tokenStore: LiveTokenStore,
		relayManager: RelayManager,
		private hashStore: ContentAddressedFileStore,
		public backgroundSync: BackgroundSync,
		private _settings: NamespacedSettings<SharedFolderSettings>,
		private _hsmStore: HSMStore,
		timeProvider: TimeProvider,
		relayId?: string,
		authoritative: boolean = false,
		remote?: RemoteSharedFolder,
	) {
		const folderRelayId = remote?.relay.guid ?? relayId;
		const s3rn = folderRelayId
			? new S3RemoteFolder(folderRelayId, guid)
			: new S3Folder(guid);

		super(guid, s3rn, tokenStore, loginManager);
		// Constructed before any subscription can route back into connect().
		this.folderMachine = new FolderHSM({ authoritative });
		this.unsubscribes.push(
			this.folderMachine.subscribe((state, previous) => {
				if (state === "reconciling" && previous !== "reconciling") {
					this.runInitialReconcile();
				}
			}),
		);
		this.timeProvider = timeProvider;
		this.path = path;
		this.setLoggers(`[SharedFile](${this.path})`);
		this.fileManager = fileManager;
		this.vault = vault;
		this.files = new Map();
		this.fset = new Files();
		this.pendingUpload = new LocalStorage<string>(
			`${appId}-system3-relay/folders/${this.guid}/pendingUploads`,
		);
		this.pendingUpload.forEach((guid, vpath) => {
			if (!this.existsSync(vpath)) {
				this.warn(
					"deleting pending upload record because file is missing",
					vpath,
					guid,
				);
				this.pendingUpload.delete(vpath);
			}
		});
		this.relayManager = relayManager;
		this.relayId = folderRelayId;
		this._remote = remote;
		this._server = remote?.relay.providerId;
		this._shouldConnect = this.settings.connect ?? true;
		this._localOnly = this.settings.localOnly ?? false;
		if (remote) {
			this.subscribeToRemoteRelay(remote);
		}
		this.remoteActivityIndex.hydrate(this.settings.remoteActivity ?? []);
		if (this.pruneRemoteActivity()) {
			this.persistRemoteActivity();
		}

		this.authoritative = authoritative;

		this.syncSettingsManager = this._settings.getChild<
			Record<keyof SyncFlags, boolean>,
			SyncSettingsManager
		>("sync", (settings, path) => new SyncSettingsManager(settings, path));

		this.syncStore = new SyncStore(
			this.folderDoc,
			this.path,
			this.pendingUpload,
			this.syncSettingsManager,
		);
		this.syncStore.on(async () => {
			await this.syncFileTree();
		});

		// The newly-enabled-types diff in syncFileTree compares against this
		// baseline. It must be populated before the first syncFileTree can
		// run: an empty baseline reads as "every type was just enabled" and
		// runs addLocalDocs while the folder is still disconnected, before
		// readiness gates that discovery.
		this.enabledSyncTypes = new Set(
			this.syncStore.typeRegistry.getEnabledFileSyncTypes(),
		);

		this.syncStore.onCompetingClaim = (path: string, meta: Meta) => {
			void Promise.resolve().then(() => {
				this.handleCompetingClaim(path, meta);
			});
		};
		// Remote membership changes cross onto disk asynchronously. Keep
		// removed paths and the guid-bearing source edge of moves in the op
		// set until disk adoption completes, so a scan or a debounced
		// vault-create landing in that window cannot re-mint, and the disk
		// echoes are consumed as the folder's own lag rather than user
		// intent.
		this.unsubscribes.push(
			this.syncStore.subscribeMapDelta((delta, origin) => {
				if (origin === this || origin === this._persistence) return;
				for (const removal of delta.deletes) {
					if (this.existsSync(removal.path)) {
						this.serverOps.recordDelete(removal.path);
					} else {
						// Nothing on disk to adopt: the removal is already
						// decided for this device.
						this.bootSnapshot?.discard(removal.path);
					}
				}
				for (const entry of delta.adds) {
					this.serverOps.clearDelete(entry.path);
				}
				for (const entry of delta.updates) {
					this.serverOps.clearDelete(entry.path);
				}
				for (const move of delta.moves) {
					this.serverOps.clearDelete(move.to);
					const moved = this.files.get(move.guid);
					if (
						this.existsSync(move.from) ||
						moved?.path === move.from
					) {
						this.serverOps.recordMove(move);
					} else {
						// Disk already agrees with the moved membership (or no
						// source exists to reconcile on this device). A prior
						// edge for this identity is no longer in flight either.
						this.serverOps.discardMove(move.guid);
						this.bootSnapshot?.discard(move.from);
					}
				}
			}),
		);

		this.unsubscribes.push(
			this.relayManager.remoteFolders.subscribe((folders) => {
				this.remote = folders.find((folder) => folder.guid == this.guid);
			}),
		);

		// Role changes arrive live over the PocketBase subscription. A change
		// to the current user's write permission drives the HSM immediately and
		// forces a token refresh so the provider transport catches up.
		this._lastCanWriteContent = null;
		const onRoleChange = () => this.handleRoleRecordsChanged();
		this.unsubscribes.push(
			this.relayManager.folderRoles.subscribe(onRoleChange),
		);
		this.unsubscribes.push(
			this.relayManager.relayRoles.subscribe(onRoleChange),
		);

		this.unsubscribes.push(
			this.relayManager.storageQuotas.subscribe(async (storageQuotas) => {
				const quota = storageQuotas.find((quota) => {
					return quota.id === this._remote?.relay.storageQuotaId;
				});
				if (quota === undefined) {
					return;
				}
				if (this.storageQuota !== quota.quota) {
					if (
						this.storageQuota !== undefined &&
						quota.quota !== undefined &&
						quota.quota > this.storageQuota
					) {
						this.debug(
							"storage quota increase",
							this.storageQuota,
							quota.quota,
						);
						await this.netSync();
					}
					this.debug("storage quota update", this.storageQuota, quota.quota);
					this.storageQuota = quota.quota;
				}
			}),
		);

		this.proxy = createProtectionProxy(
			this,
			() => this.destroyed,
			() => `SharedFolder(${this.path})`,
		);

		try {
			const folderDbName = `${this.appId}-relay-folder-${this.guid}`;
			const migrateFrom = flags().enableFolderIdbMigration ? this.guid : null;
			this._persistence = new IndexeddbPersistence(
				folderDbName,
				this.folderDoc,
				null,
				migrateFrom,
				this.timeProvider,
			);
		} catch (e) {
			this.warn("Unable to open persistence.", this.guid);
			console.error(e);
			throw e;
		}
		// If folder is authoritative (local-only, not awaiting server updates),
		// mark it as server synced so it's considered "ready" even after reload
		if (this.authoritative) {
			this._persistence.markServerSynced();
		}

		// Connecting is deferred to startupConnect(), below: the disk scan
		// decides which vault files are new by comparing them against the
		// membership map, and connecting here races the server's view of that
		// map against the local replay the comparison depends on.

		this.cas = new ContentAddressedStore(this);

		// Create MergeManager for this SharedFolder (per-folder instance)
		this.mergeManager = new MergeManager({
			folderGuid: this.guid,
			getVaultId: (guid: string) => `${this.appId}-relay-doc-${guid}`,
			getDocument: (guid: string) => {
				const file = this.files.get(guid);
				if (!file || !isDocument(file)) return undefined;
				return file;
			},
			timeProvider: this.timeProvider,
			createPersistence: (vaultId, doc, captureOpts) =>
				new IndexeddbPersistence(vaultId, doc, captureOpts, null, this.timeProvider),
			getDiskState: async (docPath: string) => {
				// docPath is SharedFolder-relative (e.g., "/note.md")
				const vaultPath = this.getPath(docPath);
				const tfile = this.vault.getAbstractFileByPath(vaultPath);
				if (!(tfile instanceof TFile)) return null;
				return await readNoteText(this.vault, tfile);
			},
			loadAllStates: async () => {
				try {
					const all = await this._hsmStore.getAllStateMeta();
					// The HSM store is app-wide. Scope cold-start to this
					// folder: records stamped with our folder guid, plus
					// records predating folder scoping whose doc guid the
					// folder's committed membership actually holds.
					const committed = new Set(
						this.syncStore.getCommittedSubdocGuids(),
					);
					// Canvas records pass through: initializeCaches routes them
					// to the managed-file caches, never the document caches.
					return all.filter(
						(meta) =>
							meta.folder === this.guid ||
							(meta.folder === undefined && committed.has(meta.guid)),
					);
				} catch {
					return [];
				}
			},
			loadState: async (guid: string) => {
				try {
					const record = await this._hsmStore.loadState(guid);
					// A canvas record under a document guid cannot happen (guids
					// are minted per file), but the type union narrows here.
					return record?.kind === "canvas" ? null : (record ?? null);
				} catch {
					return null;
				}
			},
			persistStateBarrier: async (guid, state) => {
				await this._hsmStore.saveState(guid, {
					...state,
					folder: this.guid,
				});
			},
			onEffect: async (guid, effect) => {
				if (effect.type === "PERSIST_STATE") {
					// Persisted fork/LCA state writes run in the background; track
					// failures so persistence errors are visible.
					//
					// Stamp the record with its owning folder here — the one
					// write point every document persist passes through, so
					// the association is folder-correct by construction and
					// survives rewrites the machines build without it. The
					// store is vault-wide and a record is folder-scoped
					// evidence only with the stamp. The stamp is written on
					// every session, folder engine on or off: it is an
					// additive field on a write that already happens, so
					// existing records backfill lazily as documents naturally
					// re-persist and the evidence stock is already grown by
					// the time the engine turns on.
					const p = this._hsmStore
						.saveState(guid, { ...effect.state, folder: this.guid })
						.catch((err) => {
							this.error(
								`[MergeManager] saveState failed for ${guid}:`,
								err,
							);
						});
					trackAsyncCleanup(p);
				} else if (effect.type === "SYNC_TO_REMOTE") {
					// When a file is closed, ProviderIntegration is destroyed so no one
					// listens for these effects. Handle them at the SharedFolder level.
					await this.handleIdleSyncToRemote(guid, effect.update);
				} else if (effect.type === "READER_EDIT_OVERWRITTEN") {
					this.recordReaderEditOverwrite(guid, effect.path);
				}
			},
			getPersistenceMetadata: (guid: string, path: string) => {
				const s3rn = this.relayId
					? new S3RemoteDocument(this.relayId, this.guid, guid)
					: null;
				return {
					path,
					relay: this.relayId || "",
					appId: this.appId,
					s3rn: s3rn ? S3RN.encode(s3rn) : "",
				};
			},
			yaml: { parse: parseYaml, stringify: stringifyYaml, getFrontMatterInfo },
		});

		// Create per-folder recording bridge and register with the debug API.
		this.recordingBridge = new E2ERecordingBridge({
			onEntry: flags().enableHSMRecording
				? (entry: HSMLogEntry) => recordHSMEntry(entry)
				: undefined,
			getFullPath: (guid: string) => {
				const file = this.files.get(guid);
				if (!file || !isDocument(file)) return undefined;
				return join(this.path, file.path);
			},
		});
		const debugAPI = (window as any).__relayDebug;
		if (debugAPI?.registerBridge) {
			const unregister = debugAPI.registerBridge(this.path, this.recordingBridge);
			this.unsubscribes.push(unregister);
		}
		this.mergeManager.setOnTransition((guid, path, info) => {
			this.recordingBridge.recordTransition(guid, path, info);
		});

		// Wire folder-level event subscriptions for idle mode remote updates
		this.setupEventSubscriptions();

		trackPromise(`folder:whenReady:${this.guid}`, this.whenReady())
			.then(async () => {
				if (this.destroyed) return;
				await this.mergeManager.initialize();
				if (this.destroyed) return;
				this.syncFileTree();
			})
			.catch((e) => this.error("folder ready failed", e));

		trackPromise(`folder:whenSynced:${this.guid}`, this.whenSynced())
			.then(async () => {
				if (this.destroyed) return;

				this.syncStore.start();
				// Pin the boot snapshot from the replayed membership, then
				// report the replay in the same step: the transition that
				// permits traffic is the event that pins the snapshot, so no
				// later edit can slip work between them.
				const hasPersistedMembership =
					this.hasLocalDB() || (await this.getServerSynced());
				if (this.destroyed) return;
				this.bootSnapshot = new MembershipSnapshot(
					this.syncStore.membershipPaths(),
				);
				this.folderMachine.send({
					type: "REPLAY_COMPLETE",
					hasPersistedMembership,
				});
				// The connect gate is open: parked callers proceed while the
				// scan below runs concurrently with the handshake.
				void this.startupConnect();

				// Load persisted HSM metadata before the scan can create
				// Documents. Document construction immediately creates HSMs,
				// and cold-start needs this cache to decide whether a doc can
				// remain hibernated without opening y-indexeddb.
				await this.mergeManager.initialize();
				if (this.destroyed) return;
				// A folder with no persisted membership has no snapshot to
				// read: it scans only once the server's first view has stood
				// in for one.
				if (!(await this.folderMachine.whenMayMint())) return;
				if (this.destroyed) return;
				this.addLocalDocs();
				this.folderMachine.send({ type: "DISK_SCANNED" });
				await this.syncFileTree();
				try {
					this._persistence.set("path", this.path);
					this._persistence.set("relay", this.relayId || "");
					this._persistence.set("appId", this.appId);
					this._persistence.set("s3rn", S3RN.encode(this.s3rn));
				} catch (e) {
					// pass
				}
			})
			.catch((e) => {
				this.error("folder persistence sync failed", e);
				// Startup did not complete a trustworthy disk comparison.
				// Release the gates rather than leaving the folder offline and
				// its publications parked for the session; nothing from an
				// incomplete replay can be protected.
				this.bootSnapshot ??= new MembershipSnapshot([]);
				this.folderMachine.send({
					type: "REPLAY_COMPLETE",
					hasPersistedMembership: false,
				});
				this.folderMachine.send({ type: "DISK_SCANNED" });
			})
			// Tail net: the normal path connects as soon as the snapshot is
			// pinned, while a failure above releases the gate in catch().
			// Either way a tree-sync failure cannot strand the folder offline.
			.finally(() => this.startupConnect());

		const isAuthoritative = this.authoritative;
		const canAwaitProviderSync =
			this.s3rn instanceof S3RemoteFolder &&
			this.shouldConnect &&
			this.loginManager.loggedIn &&
			this.remote !== undefined;
		(async () => {
			const serverSynced = await this.getServerSynced();
			if (!serverSynced) {
				if (isAuthoritative) {
					await this.markSynced();
				} else if (canAwaitProviderSync) {
					await trackPromise(`folderSync:${this.guid}`, this.onceProviderSynced());
					await this.markSynced();
				}
			} else if (!isAuthoritative && canAwaitProviderSync) {
				// Even when IDB already has serverSync, we still need the
				// provider to sync so _providerSynced is set. Without this,
				// the folder's `synced` getter stays false and downstream
				// flows (syncFileTree downloads) can fail.
				await trackPromise(`folderProviderSync:${this.guid}`, this.onceProviderSynced());
			}
		})().catch((e) => this.warn("folder provider sync failed", e));

		RelayInstances.set(this, this.path);
	}

	private setupEventSubscriptions() {
		if (!this._provider || !this.mergeManager) return;

		this._provider.subscribeToEvents(
			["document.updated"],
			(event: EventMessage) => {
				this.handleDocumentUpdateEvent(event);
			},
		);

		// On reconnect, query server head metadata for locally committed docs.
		// The folder index and live events discover remote paths; subdoc index
		// queries only refresh known subdocument heads.
		const provider = this._provider;
		provider.getSubdocQueryDocIds = () => {
			if (!this.relayId) return [];
			return this.syncStore
				.getCommittedSubdocGuids()
				.map((guid) => this.serverDocIdForGuid(guid));
		};
		provider.onSubdocIndex = (serverIndex) => {
			const remoteActivity: RemoteActivityEntry[] = [];
			const heads: { guid: string; snapshot: Uint8Array }[] = [];
			const now = this.currentTime();
			for (const [docId, entry] of Object.entries(serverIndex)) {
				const guid = this.guidFromServerDocId(docId) ?? docId;
				// An index entry is server evidence of content; re-allow
				// downloads for guids parked as empty.
				this.clearServerEmpty(guid);
				heads.push({ guid, snapshot: entry.snapshot });
				if (entry.lastSeen !== undefined) {
					const timestamp = normalizeRemoteActivityTimestamp(
						entry.lastSeen,
						now,
					);
					if (timestamp !== null) {
						remoteActivity.push({ guid, timestamp });
					}
				}
			}
			this.recordRemoteActivities(remoteActivity);
			this.syncFileTree()
				.then(async () => {
					// Membership before content: acting on a server head can
					// open sessions that push local-ahead ops, so delivery
					// waits for the session's first confirmed membership
					// settlement.
					if (!this.membershipSettled) {
						await this.whenMembershipSettled();
					}
					if (this.destroyed) return;
					this.mergeManager?.serverHeadsReceived(heads);
				})
				.catch((e) => {
					// Teardown reaches this sweep two ways. If the tree sync
					// is genuinely in flight it is rejected with the folder's
					// destroyed error — shutdown, not a sweep failure, and
					// read here the same way the folder-wide net sync reads
					// it. If it had already resumed, it fulfils instead and
					// the re-check above is what stops the work.
					if (isDestroyedError(e)) return;
					this.error("subdoc index sync sweep failed", e);
				});
		};
		this.unsubscribes.push(() => {
			provider.onSubdocIndex = null;
			provider.getSubdocQueryDocIds = null;
		});
	}

	private serverDocIdForGuid(guid: string): string {
		return `${this.relayId}-${guid}`;
	}

	private guidFromServerDocId(docId: string): string | null {
		const uuidPattern =
			"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
		const match = docId.match(
			new RegExp(`^${uuidPattern}-(${uuidPattern})$`, "i"),
		);
		return match?.[1] ?? null;
	}

	private handleDocumentUpdateEvent(event: EventMessage) {
		if (!this.mergeManager) return;

		const docId = event.doc_id;
		if (!docId) return;

		// Extract the guid from the doc_id
		// The doc_id format is "{relayId}-{guid}" where both are UUIDs
		const guid = this.guidFromServerDocId(docId);
		if (!guid) return;
		metrics.recordDocumentUpdateEvent("received", this.guid);

		if (!this.files.has(guid)) {
			// Remap first: when a competing local identity exists at this path,
			// executeRemap claims the path before its first await, so the
			// download retry below observes the claim and defers instead of
			// racing it for the same guid/path.
			this.retryDeferredRemapForGuid(guid);
			this.retryDeferredDownloadForGuid(guid);
			return;
		}

		const file = this.files.get(guid);
		if (!file) return;

		// A live update event is fresh evidence the server has content.
		this.clearServerEmpty(guid);
		if (!event.update) return;

		// Normalize update bytes (CBOR decoding may return Buffer or plain object)
		const update =
			event.update instanceof Uint8Array
				? event.update
				: new Uint8Array(event.update);

		// The file decides what the update means for it: the folder only
		// routes the stream.
		if (isServerUpdateSink(file)) {
			file.onServerUpdate(update);
		}
	}

	private findCommittedPathByGuid(guid: string): string | null {
		let match: string | null = null;
		this.syncStore.forEach((meta, path) => {
			if (!match && meta.id === guid) {
				match = path;
			}
		});
		return match;
	}

	/**
	 * Resolve the losing local identity after committed metadata has already
	 * moved a path to canonicalGuid. SyncStore.get(path) cannot answer this:
	 * it resolves the new committed identity (or a pending hold), not the
	 * identity still carried by a loaded file object.
	 */
	private findNonCanonicalIdentityAtPath(
		path: string,
		canonicalGuid: string,
	): { guid: string; file?: IFile } | null {
		for (const candidate of this.files.values()) {
			if (candidate.path === path && candidate.guid !== canonicalGuid) {
				return { guid: candidate.guid, file: candidate };
			}
		}

		const setCandidate = this.fset.find(
			(candidate) =>
				candidate.path === path && candidate.guid !== canonicalGuid,
		);
		if (setCandidate) {
			return { guid: setCandidate.guid, file: setCandidate };
		}

		const pendingGuid = this.pendingUpload.get(path);
		if (pendingGuid && pendingGuid !== canonicalGuid) {
			return { guid: pendingGuid };
		}
		return null;
	}

	private retryDeferredRemapForGuid(guid: string): void {
		// A live update event is fresh evidence the server has content now.
		this.clearServerEmpty(guid);
		const path = this.findCommittedPathByGuid(guid);
		if (!path || this._pendingRemaps.has(path)) return;

		const localIdentity = this.findNonCanonicalIdentityAtPath(path, guid);
		if (!localIdentity) return;
		const committedMeta = this.syncStore.getCommittedMeta(path);
		if (committedMeta?.id !== guid) return;
		if (this.pendingUpload.has(path)) {
			this.applyPendingUpload(path).promise.catch((e) => {
				this.warn(`[${path}] coordinated remap retry failed`, e);
			});
			return;
		}

		if (
			(!localIdentity.file || isDocument(localIdentity.file)) &&
			isDocumentMeta(committedMeta)
		) {
			// executeRemap owns the in-flight claim for the path (raised before its
			// first await, released in its finally).
			this.executeRemap({
				path,
				fromGuid: localIdentity.guid,
				toGuid: guid,
			}).catch((e) => {
				this.warn(`[${path}] remap retry from update event failed`, e);
			});
			return;
		}
		if (
			localIdentity.file &&
			isCanvas(localIdentity.file) &&
			isCanvasMeta(committedMeta)
		) {
			this._pendingRemaps.add(path);
			this.executeCanvasRemap({
				path,
				fromGuid: localIdentity.guid,
				toGuid: guid,
			}).catch((e) => {
				this.warn(`[${path}] canvas remap retry from update event failed`, e);
			}).finally(() => {
				this._pendingRemaps.delete(path);
			});
		}
	}

	/**
	 * A committed claim landed for a path whose own mint is still
	 * unpublished (hold present, upload queued or in flight). The
	 * markUploaded recheck will refuse the mint's publication, so every
	 * byte its transfer still moves is spent on a publication that cannot
	 * happen — content-addressed files are where that bill is largest.
	 * Cancel the mint's work and adopt the committed identity through the
	 * reconciliation path. Two backstops hold behind this: the resumed
	 * pipeline's markUploaded stands down on the cancelled completion
	 * outcome (whatever the slot holds by then), and the recheck refuses
	 * any publication over a claim still committed.
	 */
	private handleCompetingClaim(path: string, committedMeta: Meta): void {
		if (this.destroyed) return;
		// The handler runs a microtask after the observer, so the slot can
		// move again before it acts (a newer claim, a deletion). Act only
		// while the claim that fired the event is still the committed one
		// (the same freshness re-read retryDeferredRemapForGuid does);
		// whatever replaced it re-drives its own event.
		if (this.syncStore.getCommittedMeta(path)?.id !== committedMeta.id) {
			return;
		}
		const pendingGuid = this.syncStore.pendingUpload.get(path);
		if (!pendingGuid || pendingGuid === committedMeta.id) return;
		this.backgroundSync.cancelDocumentWork(pendingGuid);
		// The coordinated publication run owns the resolution: it re-reads
		// the committed slot and takes the rebind arm for the surviving
		// claim type (document remap, canvas remap, lost file claim).
		this.applyPendingUpload(path).promise.catch((e) => {
			this.warn(`[${path}] coordinated remap from claim failed`, e);
		});
	}

	/** True when empty downloads for the guid have exhausted their attempts. */
	serverEmptyTerminal(guid: string): boolean {
		return (this._emptyOnServer.get(guid) ?? 0) >= MAX_EMPTY_SERVER_ATTEMPTS;
	}

	/** Record an empty download for the guid. */
	recordServerEmpty(guid: string): void {
		this._emptyOnServer.set(guid, (this._emptyOnServer.get(guid) ?? 0) + 1);
	}

	/** Fresh server evidence for the guid — allow downloads again. */
	clearServerEmpty(guid: string): void {
		this._emptyOnServer.delete(guid);
	}

	private retryDeferredDownloadForGuid(guid: string): void {
		// A live update event is fresh evidence the server has content now.
		this.clearServerEmpty(guid);
		this.startDeferredDownloadForGuid(guid);
	}

	/**
	 * Start the deferred download for a guid without treating the call as
	 * fresh server evidence — the remap-side resume re-drives work that was
	 * already deferred and must not reset the empty-server backoff.
	 *
	 * `evenIfDocumentLoaded` lifts the "the document is already loaded, so
	 * there is nothing to download" stand-down for the one caller that knows
	 * better: a registered document whose file was never created.
	 *
	 * Returns whether a download was actually started: most of the reasons to
	 * stand down here are ordinary, but a caller that has just consumed the
	 * record of a deferred download cannot report what became of it without
	 * knowing.
	 */
	private startDeferredDownloadForGuid(
		guid: string,
		options: { evenIfDocumentLoaded?: boolean } = {},
	): boolean {
		const path = this.findCommittedPathByGuid(guid);
		if (!path || this._pendingDownloads.has(path)) return false;

		// A remap is already reconciling this identity — let it own the
		// resolution instead of racing a plain download against it for the
		// same guid/path. Recorded so the remap re-drives this download when
		// it releases the path.
		if (this._pendingRemaps.has(path)) {
			this._downloadsDeferredByRemap.add(path);
			this.log(
				`[${path}] download deferred: a remap is resolving this identity`,
			);
			return false;
		}

		const committedMeta = this.syncStore.getCommittedMeta(path);
		if (committedMeta?.id !== guid) {
			return false;
		}

		const localGuid = this.syncStore.get(path);
		if (!localGuid || localGuid !== guid) return false;
		if (this.files.has(guid) && !options.evenIfDocumentLoaded) return false;

		if (isCanvasMeta(committedMeta)) {
			void this.downloadCanvas(path).catch((e) => {
				this.warn(`[${path}] deferred canvas download retry failed`, e);
			});
			return true;
		}
		if (!isDocumentMeta(committedMeta)) {
			return false;
		}

		this._pendingDownloads.add(path);
		this.downloadDoc(path)
			.catch((e) => {
				this.warn(`[${path}] deferred download retry failed`, e);
			})
			.finally(() => {
				this._pendingDownloads.delete(path);
			});
		return true;
	}

	/**
	 * Handle SYNC_TO_REMOTE effect in idle mode.
	 *
	 * When a document is in idle mode (file closed), the HSM may still need
	 * to sync local disk changes to the remote server. This happens when:
	 * 1. External process modifies the file on disk
	 * 2. HSM detects the change via polling
	 * 3. HSM performs idle auto-merge (disk → local CRDT)
	 * 4. HSM emits SYNC_TO_REMOTE effect
	 *
	 * Without this handler, the effect is dropped because ProviderIntegration
	 * is destroyed when the file is closed.
	 */
	private async handleIdleSyncToRemote(
		guid: string,
		update: Uint8Array,
	): Promise<void> {
		// Membership before content: outbound execution waits for the
		// session's first confirmed membership settlement, so a file the
		// settlement will condemn cannot push its content first. The work
		// is held, not dropped — the effect is not re-emitted.
		if (!this.membershipSettled) {
			await this.whenMembershipSettled();
		}
		if (this.destroyed) return;
		const file = this.files.get(guid);
		if (!file || !isDocument(file)) {
			this.warn(
				`[handleIdleSyncToRemote] Document not found for guid: ${guid}`,
			);
			return;
		}

		// Skip if the editor has the file open — active mode syncs via ProviderIntegration.
		if (file.userLock) {
			this.debug?.(
				`[handleIdleSyncToRemote] Document ${guid} has user lock, skipping`,
			);
			return;
		}

		// Read-only access publishes nothing.
		if (!file.canWriteContent) {
			this.debug?.(
				`[handleIdleSyncToRemote] Document ${guid} has read-only access, skipping`,
			);
			return;
		}

		try {
			// Apply update to the document's remoteDoc (which is file.ydoc).
			// This intentionally triggers lazy creation (wake from hibernation).
			const remoteDoc = file.ensureRemoteDoc();
			Y.applyUpdate(remoteDoc, update, "local");

			// Also update the HSM's remoteDoc reference so it stays in sync
			if (file.hsm) {
				file.hsm.setRemoteDoc(remoteDoc);
			}

			// The per-document provider is not connected in idle mode, so we
			// must explicitly sync via backgroundSync to push the update to
			// the server.
			await this.backgroundSync.enqueueSync(file);
			this.log(`[handleIdleSyncToRemote] Synced idle mode update for ${guid}`);
		} catch (e) {
			this.warn(
				`[handleIdleSyncToRemote] Failed to sync update for ${guid}:`,
				e,
			);
		}
	}

	/**
	 * Poll for disk changes on all documents in this SharedFolder.
	 * Only sends DISK_CHANGED if the disk state actually differs from HSM's knowledge.
	 * Works for all documents regardless of hibernation state.
	 *
	 * @param guids - Optional set of GUIDs to poll. If not provided, polls all documents.
	 */
	async poll(guids?: string[]): Promise<void> {
		const targetGuids = guids ?? Array.from(this.files.keys());

		for (const guid of targetGuids) {
			const file = this.files.get(guid);
			if (isCanvas(file)) {
				// The canvas machine re-reads disk itself; a stat mismatch
				// against its last known disk meta is the whole signal. A
				// hibernated canvas cannot act on the event — disk change is
				// a wake trigger, and the wake's first evaluation reads the
				// changed file. getDiskMeta is the light accessor: the full
				// snapshot deep-copies the transition ring per call.
				const tfile = file.tfile;
				if (
					tfile &&
					file.hsm.getDiskMeta()?.mtime !== tfile.stat.mtime
				) {
					if (file.isMaterialized) {
						file.hsm.send({ type: "DISK_CHANGED" });
					} else {
						this.mergeManager?.wakeManagedFile(guid);
					}
				}
				continue;
			}
			if (!file || !isDocument(file)) continue;

			const hsm = file.hsm;
			if (!hsm) continue;

			const exists = this.existsSync(file.path);
			if (!exists) continue;

			const currentDisk = hsm.state.disk;

			// Check disk state only after the cheap stat comparison. Reading and
			// hashing every document on every poll is too expensive for large vaults.
			try {
				if (this.shouldReadDiskForPoll(currentDisk, file)) {
					if (file.isSaving) {
						await file.handleDiskChange();
					} else {
						const diskState = await file.readDiskContent();

						if (
							!currentDisk ||
							currentDisk.mtime !== diskState.mtime ||
							currentDisk.hash !== diskState.hash
						) {
							await file.handleDiskChange(diskState);
						}
					}
				}
			} catch (e) {
				// File might have been deleted - ignore
			}

			this.connectForkedIdleDocument(file);
		}
	}

	private connectForkedIdleDocuments(): void {
		for (const file of this.files.values()) {
			if (!isDocument(file)) continue;
			this.connectForkedIdleDocument(file);
		}
	}

	private connectForkedIdleDocument(file: Document): void {
		const hsm = file.hsm;
		if (!hsm) return;
		if (!this.shouldConnect) return;

		// A fork awaiting reconciliation in idle.localAhead re-arms on the
		// connectivity level, redelivery-first — see recoverForkedIdleDocument.
		const forkedIdle =
			hsm.state.fork !== null && hsm.matches("idle.localAhead");
		if (forkedIdle) {
			this.recoverForkedIdleDocument(file, hsm);
			return;
		}

		// A note wedged in idle.error with a retryable stored error re-arms when
		// the reconnect delivers the remote update; skip an integration that is
		// already connected and syncing.
		const retryableError =
			hsm.matches("idle.error") && hsm.state.errorRetryable === true;
		if (!retryableError) return;
		if (file.hasProviderIntegration() && file.intent === "connected") return;
		file.connectForForkReconcile().catch(() => {});
	}

	/**
	 * Re-drive a document holding an unreconciled fork in idle.localAhead toward
	 * reconciliation on the connectivity level rather than a single
	 * PROVIDER_SYNCED edge.
	 *
	 * Redelivery first: when the document's own provider has completed a sync on
	 * the current connection its remoteDoc reflects server truth, so a fork that
	 * never observed the PROVIDER_SYNCED edge is reconciled by redelivering that
	 * edge to its machine — a synthetic sync-completion that restarts
	 * fork-reconcile with no reconnect and no rebuild, and so cannot perturb a
	 * transfer in flight.
	 *
	 * A document with no live provider gets a fresh connect once the transport
	 * is stable. Forcing a connect while the transport still flaps drives the
	 * in-flight reconcile into a transport error and strands it in idle.error,
	 * the very failure this recovery exists to heal. A document that is
	 * connected but has not completed its subdoc sync is left alone: the
	 * handshake in flight produces the PROVIDER_SYNCED that restarts the
	 * reconcile, and destroying the integration would abort that handshake on
	 * every poll.
	 */
	private recoverForkedIdleDocument(file: Document, hsm: MergeHSM): void {
		// A machine holding no remote replica has nothing to reconcile against.
		// Redelivering the sync edge restarts a reconcile that cannot finish
		// and parks it again — silently, because the target carries no reenter.
		// Join the machine to the document's own replica first: it is the live
		// server copy, already synced, so this touches no transport. That is
		// also why it runs before the connectionStable gate — the heavy
		// connect path below stays behind it.
		if (!hsm.getRemoteDoc()) {
			this.mergeManager?.prepareForkReconcile(file.guid);
		}
		if (hsm.getRemoteDoc() && file.connected && file.synced) {
			hsm.send({ type: "PROVIDER_SYNCED" });
			return;
		}
		if (!this.connectionStable) return;
		if (!file.hasProviderIntegration() || !file.connected) {
			file.connectForForkReconcile().catch(() => {});
		}
	}

	private recoverForkedIdleDocuments(): void {
		if (!this.shouldConnect) return;
		for (const file of this.files.values()) {
			if (!isDocument(file)) continue;
			const hsm = file.hsm;
			if (!hsm) continue;
			if (hsm.state.fork === null || !hsm.matches("idle.localAhead")) {
				continue;
			}
			this.recoverForkedIdleDocument(file, hsm);
		}
	}

	private shouldReadDiskForPoll(
		currentDisk: { hash: string; mtime: number } | null,
		file: Document,
	): boolean {
		if (!currentDisk) return true;

		const cachedDisk = this.getCachedDiskState(file);
		if (cachedDisk) {
			return cachedDisk.hash !== currentDisk.hash;
		}

		const tfile = this.getTFile(file);
		if (!tfile) return false;

		return tfile.stat.mtime !== currentDisk.mtime;
	}

	private getCachedDiskState(
		file: Document,
	): { hash: string; mtime: number } | null {
		const tfile = this.getTFile(file);
		if (!tfile) return null;
		return this.getCachedDiskStateForTFile(tfile);
	}

	private getCachedDiskStateForTFile(tfile: TFile): { hash: string; mtime: number } | null {
		const fileCache = (this.metadataCache as any)?.fileCache;
		const cached =
			typeof fileCache?.get === "function"
				? fileCache.get(tfile.path)
				: fileCache?.[tfile.path];
		if (
			!cached ||
			typeof cached.hash !== "string" ||
			typeof cached.mtime !== "number"
		) {
			return null;
		}

		if (cached.mtime !== tfile.stat.mtime) return null;

		return { hash: cached.hash, mtime: cached.mtime };
	}

	private getStartupDiskMetadata(tfile: TFile): { mtime: number; hash?: string } {
		return this.getCachedDiskStateForTFile(tfile) ?? { mtime: tfile.stat.mtime };
	}

	getCurrentDiskMetadata(file: IFile): { mtime: number; hash?: string } | null {
		const tfile = this.getTFile(file);
		if (!tfile) return null;
		return this.getStartupDiskMetadata(tfile);
	}

	private addLocalDocs(types?: SyncType[]): void {
		// Reconciliation is not a second source of create intent. A vault create
		// that is still settling must be decided by its timer (or canceled by a
		// rename/delete), rather than registered early by a scan.
		let syncTFiles = this.getSyncFiles().filter((tfile) => {
			const vpath = this.getVirtualPath(tfile.path);
			return (
				!this.pendingCreates.has(vpath) &&
				(this.canManageFiles || this.syncStore.has(vpath))
			);
		});
		if (types) {
			syncTFiles = syncTFiles.filter((tfile) => {
				if (tfile instanceof TFolder) return false;
				const vpath = this.getVirtualPath(tfile.path);
				const fileType =
					this.syncStore.typeRegistry.getTypeForPath(vpath);
				return types.includes(fileType);
			});
		}
		const files: IFile[] = [];
		if (syncTFiles.length > 0) {
			this.placeHold(syncTFiles);
		}
		syncTFiles.forEach((tfile) => {
			const vpath = this.getVirtualPath(tfile.path);
			const guid = this.syncStore.get(vpath);
			const existing = guid ? this.files.get(guid) : undefined;
			if (existing) {
				files.push(existing);
				return;
			}
			const file = this.getFile(tfile);
			if (file) {
				files.push(file);
			}
		});
		if (files.length > 0) {
			this.fset.update();
		}
	}

	public get server(): string | undefined {
		return this._server;
	}

	public set server(value: string | undefined) {
		if (value === this._server) {
			return;
		}
		if (this._server !== undefined) {
			this.warn("server changed -- reinitializing all connections");
		}
		const shouldConnect = this.shouldConnect;
		this.reset();
		const reconnect: HasProvider[] = [];
		this.fset.forEach((file) => {
			if (file instanceof HasProvider) {
				if (file.connected) {
					reconnect.push(file);
				}
				file.reset();
			}
		});
		this.tokenStore.clear((token) => {
			return token.token?.folder === this.guid;
		});
		if (shouldConnect) {
			this.connect();
			reconnect.forEach((file) => {
				file.connect();
			});
		}
		this._server = value;
	}

	public get tfolder(): TFolder {
		const folder = this.vault.getAbstractFileByPath(this.path);
		if (!(folder instanceof TFolder)) {
			throw new Error("tfolder is not a folder");
		}
		return folder;
	}

	public isSyncableTFile(tfile: TAbstractFile): boolean {
		const inFolder = this.checkPath(tfile.path);
		const vpath = this.getVirtualPath(tfile.path);
		const isSupportedFileType = this.syncStore.canSync(vpath);

		// For folders, we only need to check if the sync store supports them
		// Extension preferences don't apply to folders
		if (tfile instanceof TFolder) {
			return inFolder && isSupportedFileType;
		}

		const isExtensionEnabled =
			this.syncSettingsManager.isExtensionEnabled(vpath);

		return (
			inFolder &&
			isSupportedFileType &&
			isExtensionEnabled &&
			!this.isStorageBlockedTFile(tfile)
		);
	}

	public isStorageBlockedTFile(tfile: TAbstractFile): boolean {
		if (!(tfile instanceof TFile)) return false;
		if (!this.checkPath(tfile.path)) return false;
		return this.isStorageBlockedVPath(this.getVirtualPath(tfile.path));
	}

	public isStorageBlockedVPath(vpath: string): boolean {
		const quota = this.remote?.relay.storageQuota?.quota ?? this.storageQuota;
		if (quota !== 0) return false;
		return this.syncSettingsManager.requiresStorage(vpath);
	}

	public skipStorageBlockedUpload(vpath: string): boolean {
		if (!this.isStorageBlockedVPath(vpath)) return false;
		this.log("skipping storage-blocked upload", vpath);
		return true;
	}

	private getSyncFiles(): TAbstractFile[] {
		const folder = this.vault.getAbstractFileByPath(this.path);
		if (!(folder instanceof TFolder)) {
			throw new Error(
				`Could not find shared folders on file system at ${this.path}`,
			);
		}
		const files: TAbstractFile[] = [];
		Vault.recurseChildren(folder, (file: TAbstractFile) => {
			if (file !== folder) {
				files.push(file);
			}
		});
		return files.filter((tfile) => {
			return this.isSyncableTFile(tfile);
		});
	}

	public get shouldConnect(): boolean {
		return this._shouldConnect;
	}

	public set shouldConnect(connect: boolean) {
		this._settings.update((current) => ({
			...current,
			connect,
		}));
		this._shouldConnect = connect;
	}

	public get localOnly(): boolean {
		return this._localOnly;
	}

	public set localOnly(value: boolean) {
		if (this._localOnly === value) return;
		this._localOnly = value;
		this._settings.update((current) => ({
			...current,
			localOnly: value,
		}));
		const guids = Array.from(this.files.keys());
		this.mergeManager?.setLocalOnly(guids, value);
		for (const file of this.files.values()) {
			if (isCanvas(file)) {
				file.setLocalOnly(value);
			}
		}
	}

	async netSync() {
		try {
			await this.whenReady();
			if (this.destroyed) return;
			await this.mergeManager.initialize();
			if (this.destroyed) return;
			this.addLocalDocs();
			await this.syncFileTree();
			// Membership before content: the folder-wide flush pushes local
			// ops, so it waits for the session's first confirmed membership
			// settlement. Discovery above is unaffected.
			if (!this.membershipSettled) {
				await this.whenMembershipSettled();
			}
			if (this.destroyed) return;
			this.backgroundSync.beginFolderPass(this);
			this.admitPlannedWork({ kind: "sweep" });
		} catch (error) {
			if (isDestroyedError(error)) return;
			throw error;
		}
	}

	/**
	 * Ask every file in the folder to plan its work for an occasion and
	 * return the concatenation. The folder names no file type and reads no
	 * machine: each participant answers from its own surface.
	 */
	planSyncWork(occasion: PlanOccasion): WorkRequest<SyncParticipant>[] {
		const context: PlanContext = {
			occasion,
			now: this.currentTime(),
			inFlight: (guid, scope) => this.backgroundSync.isClaimed(guid, scope),
		};
		const requests: WorkRequest<SyncParticipant>[] = [];
		for (const file of this.files.values()) {
			if (!isSyncParticipant(file)) continue;
			requests.push(...file.planSyncWork(context));
		}
		return requests;
	}

	/** Plan for an occasion and admit the result as one batch. */
	private admitPlannedWork(occasion: PlanOccasion): number {
		const requests = this.planSyncWork(occasion);
		if (requests.length > 0) this.backgroundSync.admitAll(requests);
		return requests.length;
	}

	async resync(): Promise<void> {
		if (!this.connected || this.localOnly) return;
		const finishResync = this.backgroundSync.beginFolderResync(this);
		try {
			await this.netSync();
		} finally {
			finishResync();
		}
	}

	/**
	 * A publication staged this folder's membership onto an empty relay.
	 * Every per-document room there is an empty shell until content
	 * re-uploads, so joining peers would download guids without bodies.
	 * Stage a local-authoritative upload for each registered doc; rooms
	 * that already hold content absorb the merge idempotently.
	 */
	private stagePublicationUploads(): void {
		// Reconciliation fires this synchronously after its staging
		// transaction; enqueue on a fresh microtask so upload bookkeeping
		// never re-enters observer or transaction context.
		void Promise.resolve().then(async () => {
			if (!this.membershipSettled) {
				await this.whenMembershipSettled();
			}
			if (this.destroyed) return;
			let staged = 0;
			this.files.forEach((doc) => {
				// Directories have no rooms; only files that take part in
				// background sync can be staged.
				if (!isSyncParticipant(doc)) return;
				// The outcome is dropped: this staging path never publishes
				// membership itself, so there is no publication decision to make here.
				const p = this.backgroundSync
					.enqueueUpload(doc)
					.then(
						() => undefined,
						(e) => {
							this.warn("publication staging failed", doc.path, e);
						},
					);
				trackAsyncCleanup(p);
				staged++;
			});
			this.log(`publication: staged ${staged} content uploads`);
		});
	}

	public get settings(): SharedFolderSettings {
		return this._settings.get();
	}

	public getRecentRemoteActivity(limit = 30): RemoteActivityEntry[] {
		return this.remoteActivityIndex.entries(limit);
	}

	public getRemoteActivity(guid: string): RemoteActivityEntry | undefined {
		return this.remoteActivityIndex.get(guid);
	}

	public subscribeToRemoteActivity(callback: () => void): () => void {
		if (this.destroyed) {
			return () => {};
		}
		this.remoteActivitySubscribers.add(callback);
		return () => {
			this.remoteActivitySubscribers.delete(callback);
		};
	}

	private recordRemoteActivities(entries: readonly RemoteActivityEntry[]): void {
		if (this.destroyed || entries.length === 0) return;

		let changed = false;
		for (const entry of entries) {
			changed = this.remoteActivityIndex.upsert(entry) || changed;
		}
		changed = this.pruneRemoteActivity() || changed;
		if (!changed) return;

		this.persistRemoteActivity();
		this.notifyRemoteActivitySubscribers();
	}

	private pruneRemoteActivity(): boolean {
		return this.remoteActivityIndex.pruneOlderThan(
			this.currentTime() - REMOTE_ACTIVITY_RETENTION_MS,
		);
	}

	private persistRemoteActivity(): void {
		const persist = this._settings
			.update((current) => ({
				...current,
				remoteActivity: this.remoteActivityIndex.serialize(),
			}))
			.catch((error) => {
				this.warn("unable to persist remote activity", error);
			});
		trackAsyncCleanup(persist);
		trackPromise(`folder:remoteActivityPersist:${this.guid}`, persist);
	}

	private notifyRemoteActivitySubscribers(): void {
		for (const subscriber of [...this.remoteActivitySubscribers]) {
			subscriber();
		}
	}

	private currentTime(): number {
		return this.timeProvider?.now() ?? Date.now();
	}

	async sync() {
		await this.syncFileTree();
	}

	async connect(): Promise<boolean> {
		// Every caller — restored views included — waits for the machine,
		// which grants traffic once the local replay has been read and the
		// boot snapshot pinned. The gate resolves false at teardown so no
		// caller is left pending.
		const permitted = await this.folderMachine.whenMayConnect();
		if (!permitted || this.destroyed) return false;
		if (this.connectionAttempt) return this.connectionAttempt;
		const attempt = this.connectProvider();
		this.connectionAttempt = attempt;
		try {
			return await attempt;
		} finally {
			if (this.connectionAttempt === attempt) {
				this.connectionAttempt = null;
			}
		}
	}

	private async connectProvider(): Promise<boolean> {
		if (this.s3rn instanceof S3RemoteFolder) {
			if (this.connected) {
				return true;
			}
			if (this.shouldConnect) {
				const result = await super.connect();
				if (result && this.mergeManager) {
					// The machines retain their server heads across the
					// reconnect: the next subdoc-index delivery routes through
					// them, so a push missed while resubscribing converges on
					// that delivery instead of vanishing with a cleared table.
					// The provider preserves eventCallbacks across reconnects
					// and re-sends the server subscribe frame itself, so the
					// callbacks registered by the constructor's
					// setupEventSubscriptions() call stay live.
					this.admitReconnectWork("connect");
					this.connectForkedIdleDocuments();
				}
				return result;
			}
		}
		return false;
	}

	/**
	 * The provider session came back: let every file plan the recovery work
	 * it needs (a document without a merge base recovers it here).
	 */
	private admitReconnectWork(reason: string): void {
		if (this.destroyed || this.localOnly || !this.connected) return;
		const queued = this.admitPlannedWork({ kind: "reconnect" });
		if (queued > 0) {
			this.debug(`[reconnect] admitted ${queued} recovery requests (${reason})`);
		}
	}

	public get name(): string {
		return this.path.split("/").pop() || "";
	}

	public getUserDisplayName(userId: string): string | undefined {
		const name = this.relayManager?.users.get(userId)?.name?.trim();
		return name || undefined;
	}

	public isLocalUserId(userId: string): boolean {
		return [
			this.loginManager?.user?.id,
			this.relayManager?.user?.id,
			this._provider?.awareness.getLocalState()?.user?.id,
		].some((id) => id === userId);
	}

	public get location(): string {
		return this.path.split("/").slice(0, -1).join("/");
	}

	public get remote(): RemoteSharedFolder | undefined {
		try {
			// FIXME: race condition because sharedFolder doesn't use postie
			// for notifyListener updates.
			this._remote?.relay;
		} catch (e) {
			return undefined;
		}
		return this._remote;
	}

	/**
	 * Tri-state content-write answer from the client-side role policy.
	 * Null means the role data needed to answer has not synced (every real
	 * folder carries at least its owner's role record), so callers should
	 * fall back to token- or default-derived modes rather than trusting a
	 * fail-closed policy evaluation over missing data.
	 *
	 * The role is the primary access-mode source: tokens are minted from
	 * roles but served through an API cache, so a freshly flipped role with
	 * a stale cached token is the normal case during a live transition.
	 */
	private deriveCanWriteContentAnswer(): boolean | null {
		return this.deriveFolderPolicyAnswer("edit_content");
	}

	private deriveCanManageFilesAnswer(): boolean | null {
		return this.deriveFolderPolicyAnswer("manage_files");
	}

	private deriveFolderPolicyAnswer(
		action: "edit_content" | "manage_files",
	): boolean | null {
		const remote = this.remote;
		if (!remote) {
			return null;
		}
		const userId = this.relayManager?.user?.id;
		const policyManager = this.relayManager?.policyManager;
		if (!userId || !policyManager) {
			return null;
		}
		const folderRolesSynced = this.relayManager.folderRoles
			.values()
			.some((r) => r.sharedFolderId === remote.id);
		const relayRolesSynced = this.relayManager.relayRoles
			.values()
			.some((r) => r.relayId === remote.relayId);
		if (!folderRolesSynced && !relayRolesSynced) {
			return null;
		}
		const result = policyManager.isAllowed({
			principal: userId,
			action,
			resource: ["folder", remote.id],
		});
		return result.allowed;
	}

	public get canWriteContentAnswer(): boolean | null {
		if (this._canWriteContentAnswerCache === undefined) {
			this._canWriteContentAnswerCache =
				this.deriveCanWriteContentAnswer();
		}
		return this._canWriteContentAnswerCache;
	}

	/**
	 * Content-write permission for documents in this folder. Unknown states
	 * default to write — the server enforces real authorization, and failing
	 * open avoids stranding writes on missing client state.
	 */
	public get canWriteContent(): boolean {
		if (!flags().enableReadOnlyPermissions) {
			return true;
		}
		if (this._lastCanWriteContent == null) {
			this._lastCanWriteContent = this.canWriteContentAnswer ?? true;
		}
		return this._lastCanWriteContent;
	}

	/** Whether local create, rename, move, and delete intent may change membership. */
	public get canManageFiles(): boolean {
		if (
			!FeatureFlagManager.getInstance().getFlag("enableReadOnlyPermissions")
		) {
			return true;
		}
		if (this._canManageFilesAnswerCache === undefined) {
			this._canManageFilesAnswerCache = this.deriveCanManageFilesAnswer();
		}
		return this._canManageFilesAnswerCache ?? true;
	}

	private handleRoleRecordsChanged(): void {
		if (!flags().enableReadOnlyPermissions) {
			// Flag-off role notifications retain legacy behavior and avoid
			// paying for a policy derivation nobody consumes.
			this._canWriteContentAnswerCache = undefined;
			this._canManageFilesAnswerCache = undefined;
			this._lastCanWriteContent = null;
			this._lastCanManageFiles = null;
			return;
		}
		const writeAnswer = this.deriveCanWriteContentAnswer();
		const manageAnswer = this.deriveCanManageFilesAnswer();
		this._canWriteContentAnswerCache = writeAnswer;
		this._canManageFilesAnswerCache = manageAnswer;
		const canWrite = writeAnswer ?? true;
		const canManage = manageAnswer ?? true;
		if (!this._roleSnapshotReceived) {
			this._roleSnapshotReceived = true;
			this._lastCanWriteContent = canWrite;
			this._lastCanManageFiles = canManage;
			if (!canWrite || !canManage) {
				this.notifyFolderPermissionSubscribers();
			}
			return;
		}
		const changed =
			this._lastCanWriteContent !== canWrite ||
			this._lastCanManageFiles !== canManage;
		this._lastCanWriteContent = canWrite;
		this._lastCanManageFiles = canManage;
		if (!changed) {
			return;
		}
		this.refreshDocumentTokensForPermissionChange();
		this.notifyFolderPermissionSubscribers();
	}

	private rejectReaderFolderChange(paths: string[]): boolean {
		if (this.canManageFiles) return false;
		for (const path of paths) {
			this.recordReaderEditOverwrite("", this.getPath(path));
		}
		return true;
	}

	/**
	 * Watch for the current user's permissions on this folder to change
	 * (e.g. a Reader promoted to Member). Fires after the role-derived
	 * policy caches update, so subscribers read fresh answers.
	 */
	public subscribeToPermissionChanges(callback: () => void): () => void {
		if (this.destroyed) {
			return () => {};
		}
		this.folderPermissionSubscribers.add(callback);
		return () => {
			this.folderPermissionSubscribers.delete(callback);
		};
	}

	private notifyFolderPermissionSubscribers(): void {
		if (this.destroyed) return;
		for (const subscriber of [...this.folderPermissionSubscribers]) {
			subscriber();
		}
	}

	/**
	 * Propagate a content-write permission flip to this folder's documents.
	 * Open documents transition immediately from the role change itself;
	 * documents holding a registered token also get a forced refresh so the
	 * provider's authorization catches up with the role-derived policy.
	 */
	private refreshDocumentTokensForPermissionChange(): void {
		if (!flags().enableReadOnlyPermissions) {
			return;
		}
		this.debug(
			`content-write permission changed; refreshing document tokens`,
		);
		this.tokenStore.forceRefresh(S3RN.encode(this.s3rn));
		this.files.forEach((file) => {
			const s3rn = (file as unknown as { s3rn?: HasProvider["s3rn"] }).s3rn;
			if (s3rn) {
				this.tokenStore.forceRefresh(S3RN.encode(s3rn));
			}
			if (isDocument(file)) {
				file.notifyAccessModeChanged();
			}
		});
	}

	private subscribeToRemoteRelay(remote: RemoteSharedFolder): void {
		this.unsubscribes.push(
			remote.relay.subscribe((relay) => {
				if (relay.guid === this.relayId) {
					this.server = relay.providerId;
				}
			}),
		);
	}

	public set remote(value: RemoteSharedFolder | undefined) {
		if (this._remote === value) {
			return;
		}
		const previousRelayId = this.relayId;
		this._remote = value;
		this._canWriteContentAnswerCache = undefined;
		this._canManageFilesAnswerCache = undefined;
		this._lastCanWriteContent = null;
		this._lastCanManageFiles = null;
		this.relayId = value?.relay?.guid;
		this.s3rn = this.relayId
			? new S3RemoteFolder(this.relayId, this.guid)
			: new S3Folder(this.guid);
		this._settings.update((current) => ({
			...current,
			...{ relay: this.relayId },
		}));

		if (value) {
			this.subscribeToRemoteRelay(value);
		}

		this.server = value?.relay.providerId;

		// A folder pointed at a different relay finds empty per-document
		// rooms there: membership replicates with the folder doc, content
		// does not. Stage every registered doc's content once the new
		// provider handshake completes — uploads drained before then run
		// against a half-switched connection and fail terminally.
		if (this.relayId !== undefined && this.relayId !== previousRelayId) {
			const stagedRelayId = this.relayId;
			const p = this.onceProviderSynced().then(() => {
				if (this.destroyed || this.relayId !== stagedRelayId) return;
				this.stagePublicationUploads();
			});
			trackAsyncCleanup(p);
		}

		this.notifyListeners();
	}

	public get ready(): boolean {
		return (
			this.persistenceSynced &&
			(this.authoritative || this._persistence.hasServerSync || this.synced)
		);
	}

	async markSynced(): Promise<void> {
		await this._persistence.markServerSynced();
	}

	protected handleProviderSynced(): void {
		this.folderMachine.send({ type: "PROVIDER_SYNCED" });
		// The folder provider completing a sync is the connectivity-level signal
		// that the transport has returned. It fires on the provider's own
		// reconnect-backoff self-heal, which never routes through connect(), so a
		// sweep triggered only by connect misses a self-heal. Re-drive every
		// document still holding an unreconciled fork toward reconciliation.
		this.recoverForkedIdleDocuments();
		if (this.authoritative || this._persistence.hasServerSync) {
			return;
		}
		trackPromise(
			`folderMarkSynced:${this.guid}`,
			this.markSynced(),
		).catch((e) => {
			this.warn("failed to persist server sync marker", e);
		});
	}

	get folderDoc(): Y.Doc {
		return this.ydoc;
	}

	async getServerSynced(): Promise<boolean> {
		return this._persistence.getServerSynced();
	}

	private hasLocalDB(): boolean {
		return this._persistence.hasUserData();
	}

	/**
	 * Open the folder's connection, once. The gate inside connect() holds
	 * the attempt until the local replay has been read, so this is a
	 * single-shot dispatch: the machine owns the ordering.
	 */
	private async startupConnect(): Promise<void> {
		if (this.startupConnectRequested) return;
		this.startupConnectRequested = true;
		try {
			if (this.destroyed) return;
			if (!this.loginManager.loggedIn) return;
			await this.connect();
		} catch (e) {
			this.startupConnectRequested = false;
			this.warn("startup connect failed", e);
		}
	}

	whenReady(): Promise<SharedFolder> {
		const promiseFn = async (): Promise<SharedFolder> => {
			const open = await this.folderMachine.whenMayConnect();
			if (!open) return this;
			if (this.folderMachine.needsServerSnapshot) {
				// A folder with no persisted membership must take its snapshot
				// from the server's first view, so it connects while loading.
				this.connect().catch((e) => {
					this.warn("initial server connect failed", e);
				});
				await trackPromise(`folderConnected:${this.guid}`, this.onceConnected());
				await trackPromise(`folderReady:${this.guid}`, this.onceProviderSynced());
				return this;
			}
			// If this is a shared folder with edits, then we can behave as though we're just offline.
			return this;
		};
		this.readyPromise =
			this.readyPromise ||
			new Dependency<SharedFolder>(promiseFn, (): [boolean, SharedFolder] => {
				return [this.ready, this];
			}, this.timeProvider);
		return trackPromise(`folder:whenReady:${this.guid}`, this.readyPromise.getPromise());
	}

	whenSynced(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			await this._persistence.whenSynced;
			this.persistenceSynced = true;
		};

		this.whenSyncedPromise =
			this.whenSyncedPromise ||
			new Dependency<void>(promiseFn, (): [boolean, void] => {
				return [this.persistenceSynced, undefined];
			}, this.timeProvider);
		return trackPromise(`folder:whenSynced:${this.guid}`, this.whenSyncedPromise.getPromise());
	}

	public get intent(): ConnectionIntent {
		return this.shouldConnect ? "connected" : "disconnected";
	}

	async _handleServerRename(
		doc: IFile,
		path: string,
		file: TAbstractFile,
		diffLog?: string[],
	): Promise<void> {
		// take a doc and it's new path.
		const oldVPath = this.getVirtualPath(file.path);
		this.serverOps.recordMove({ guid: doc.guid, from: oldVPath, to: path });
		diffLog?.push(`${file.path} was renamed to ${this.getPath(path)}`);
		if (file instanceof TFile) {
			const dir = dirname(path);
			if (!this.existsSync(dir)) {
				await this.mkdir(dir);
				diffLog?.push(`creating directory ${dir}`);
			}
		}
		await this.fileManager.renameFile(file, normalizePath(this.getPath(path)));
		this.serverOps.completeMove(oldVPath, path);
		this.bootSnapshot?.discard(oldVPath);
		if (!this.destroyed && doc.path !== path) {
			doc.move(path, this);
		}
	}

	trashFile(file: TAbstractFile): Promise<void> {
		return this.fileManager.trashFile(file);
	}

	async _handleServerCreate(
		vpath: string,
		meta: Meta,
		diffLog?: string[],
	): Promise<IFile | undefined> {
		// Create directories as needed
		const dir = dirname(vpath);
		if (!this.existsSync(dir)) {
			await this.mkdir(dir);
			diffLog?.push(`creating directory ${dir}`);
		}
		if (meta.type === "markdown") {
			diffLog?.push(`creating local .md file for remotely added doc ${vpath}`);
			const doc = await this.downloadDoc(vpath);
			if (!doc) {
				diffLog?.push(
					`deferred local .md file for remotely added doc ${vpath} (server has guid but no content yet)`,
				);
			}
			return doc;
		}
		if (meta.type === "canvas") {
			diffLog?.push(
				`created local .canvas file for remotely added canvas ${vpath}`,
			);
			const canvas = await this.downloadCanvas(vpath, false);
			return canvas;
		}
		if (meta.type === "folder") {
			diffLog?.push(`created local folder for remotely added folder ${vpath}`);
			return this.getSyncFolder(vpath);
		}
		if (this.syncStore.canSync(vpath)) {
			diffLog?.push(`created local file for remotely added file ${vpath}`);
			return this.downloadSyncFile(vpath);
		}
		throw new Error(
			`${vpath}: Unexpected file type ${meta.type} ${meta.mimetype}`,
		);
	}

	private _assertNamespacing(path: string): boolean {
		try {
			this.assertPath(normalizePath(join(this.path, path)));
			return true;
		} catch {
			this.error("Deleting doc (somehow moved outside of shared folder)", path);
			this.syncStore.delete(path);
			return false;
		}
	}

	/**
	 * Swap or rebuild a document's local CRDT identity. Called when the folder's
	 * meta CRDT resolves a path to a GUID that differs from the one we enrolled
	 * locally, and when the same GUID has unusable local CRDT state. Tears down
	 * the local Y.Doc + IDB + HSM state, downloads the winning CRDT from the
	 * server, and creates a fresh Document under the canonical GUID.
	 *
	 * Folder-level: does not require a living Document instance at fromGuid.
	 * On failure, leaves pendingUpload intact so the next observer event or
	 * startup scan re-detects and retries.
	 */
	private async executeRemap(args: {
		path: string;
		fromGuid: string;
		toGuid: string;
	}): Promise<void> {
		const { path, fromGuid, toGuid } = args;
		const operation = fromGuid === toGuid ? "rebuild" : "remap";

		// One reconciliation owns a path at a time. Two running together tear
		// down each other's document, and the first to finish would release
		// the claim while the second is still mid-flight — which would let a
		// download commit over it. Standing aside is recorded rather than
		// dropped: when committed metadata moves a path on again while a
		// reconciliation toward the previous identity is still running, the
		// newer one is real work, and nothing else re-detects it until the
		// next sweep.
		if (this._pendingRemaps.has(path)) {
			this._remapsDeferredByRemap.set(path, args);
			this.log(
				`[${path}] ${operation} deferred: another reconciliation already owns this path`,
			);
			return;
		}

		// Every remap passes through here, so this is the one place the claim
		// can be raised for all of them. It goes up before the first await, so
		// anything dispatched later in the same turn — the download retry that
		// shares this path's update event — already sees it. The release is in
		// a finally so a thrown remap cannot strand the path.
		this._pendingRemaps.add(path);
		try {
			await this.runRemap(args, operation);
		} finally {
			this._pendingRemaps.delete(path);
			// The reconciliation goes first: if one was waiting it claims the
			// path again in this same turn, and the download below sees the
			// claim and defers to it rather than racing it.
			this.resumeRemapDeferredByRemap(path);
			this.resumeDownloadDeferredByRemap(path, toGuid);
		}
	}

	/**
	 * Re-drive the reconciliation that stood aside for this one. The record is
	 * consumed before the re-drive, so the resumed reconciliation cannot
	 * observe the claim it deferred to and cannot defer to itself.
	 */
	private resumeRemapDeferredByRemap(path: string): void {
		const deferred = this._remapsDeferredByRemap.get(path);
		if (!deferred) return;
		this._remapsDeferredByRemap.delete(path);
		if (this.destroyed) return;
		this.log(`[${path}] resuming the reconciliation that deferred to the remap`);
		this.executeRemap(deferred).catch((e) => {
			this.warn(`[${path}] deferred remap retry failed`, e);
		});
	}

	/**
	 * A download that stood aside for a reconciliation has no other retry on
	 * the default configuration — the download sweep only runs with the folder
	 * engine enabled — so the reconciliation that displaced it is what
	 * discharges it. Only paths that actually deferred are re-driven.
	 */
	private resumeDownloadDeferredByRemap(path: string, guid: string): void {
		if (!this._downloadsDeferredByRemap.delete(path)) return;
		if (this.destroyed) return;
		this.log(`[${path}] resuming the download that deferred to the remap`);
		// A reconciliation registers its document before it reads the file,
		// and reading a file that is not there is exactly how it fails — so a
		// failed one can leave the document registered and the file still
		// missing. The download is the only thing that restores the file, so
		// the resume asks whether the file is there, not whether the document
		// is loaded.
		this.startDeferredDownloadForGuid(guid, {
			evenIfDocumentLoaded: !this.existsSync(path),
		});
	}

	private async runRemap(
		{ path, fromGuid, toGuid }: {
			path: string;
			fromGuid: string;
			toGuid: string;
		},
		operation: "rebuild" | "remap",
	): Promise<void> {
		const sameGuid = fromGuid === toGuid;
		metrics.incDocumentRebuild(this.guid, operation, "started");
		let operationTerminalRecorded = false;
		const recordOperationTerminal = (
			result: "completed" | "deferred" | "failed",
		) => {
			if (operationTerminalRecorded) return;
			metrics.incDocumentRebuild(this.guid, operation, result);
			operationTerminalRecorded = true;
		};
		if (!this.connected) {
			recordOperationTerminal("deferred");
			this.log(`[${path}] ${operation} deferred: folder offline`);
			return;
		}

		if (this.serverEmptyTerminal(toGuid)) {
			recordOperationTerminal("deferred");
			this.debug(
				`[${path}] ${operation} skipped: server has no content for guid; awaiting server evidence`,
			);
			return;
		}

		let updateBytes: Uint8Array | undefined;
		try {
			updateBytes = await this.backgroundSync.downloadByGuid(this, toGuid, path);
		} catch (e) {
			recordOperationTerminal("deferred");
			this.warn(`[${path}] ${operation} download failed, deferring`, e);
			return;
		}

		if (!updateBytes) {
			this.recordServerEmpty(toGuid);
			recordOperationTerminal("deferred");
			this.log(`[${path}] ${operation} deferred: server has guid but no content yet`);
			return;
		}

		if (this.destroyed) {
			recordOperationTerminal("deferred");
			this.log(`[${path}] ${operation} aborted: folder destroyed during download`);
			return;
		}

		try {
			const existingFile = this.files.get(fromGuid);
			const existingHsm = existingFile && isDocument(existingFile)
				? existingFile.hsm
				: null;
			if (sameGuid) {
				try {
					await existingHsm?.resetLocalPersistenceForRebuild();
				} catch (e) {
					this.warn(`[${path}] rebuild local cleanup failed`, e);
					throw e;
				}
				await this._hsmStore.deleteState(fromGuid);
			} else {
				try {
					indexedDB.deleteDatabase(`${this.appId}-relay-doc-${fromGuid}`);
				} catch { /* best effort stale database cleanup */ }
				const p = this._hsmStore.deleteState(fromGuid).catch(() => {});
				trackAsyncCleanup(p);
			}

			this.backgroundSync.cancelDocumentWork(fromGuid);

			if (existingFile) {
				this.files.delete(fromGuid);
				this.fset.delete(existingFile);
				existingFile.cleanup();
				existingFile.destroy();
			}

			this.syncStore.pendingUpload.delete(path);

			const newDoc = this.getOrCreateDoc(toGuid, path);
			this.files.set(toGuid, newDoc);
			this.fset.add(newDoc);
			const isCurrentDoc = () =>
				!this.destroyed && !newDoc.destroyed && this.files.get(toGuid) === newDoc;

			if (!isCurrentDoc()) {
				recordOperationTerminal("deferred");
				this.log(`[${path}] ${operation} aborted: new document is stale`);
				return;
			}

			if (updateBytes) {
				await newDoc.hsm?.initializeFromRemote(updateBytes);
				const remoteDoc = newDoc.ensureRemoteDoc();
				Y.applyUpdate(remoteDoc, updateBytes, remoteDoc);
				newDoc.hsm?.setRemoteDoc(remoteDoc);
			}
			if (!isCurrentDoc()) {
				recordOperationTerminal("deferred");
				this.log(`[${path}] ${operation} aborted after enroll: new document is stale`);
				return;
			}
			if (newDoc.hsm && !newDoc.hsm.state.lca) {
				await newDoc.hsm.awaitIdle();
				const diskState = await newDoc.readDiskContent();
				await newDoc.hsm.bootstrapLCAFromDisk(diskState);
			}
			await this.poll([toGuid]);

			recordOperationTerminal("completed");

			this.log(
				sameGuid
					? `Rebuilt Document ${path}: ${toGuid}`
					: `Remapped Document ${path}: ${fromGuid} → ${toGuid}`,
			);
		} catch (e) {
			recordOperationTerminal("failed");
			throw e;
		}
	}

	async rebuildDocumentFromRemote(guid: string, path: string): Promise<void> {
		await this.executeRemap({ path, fromGuid: guid, toGuid: guid });
	}

	/**
	 * Adopt the committed GUID for a canvas whose path resolves to a
	 * different identity than the one enrolled locally. Tears down the
	 * local canvas (IDB, machine record, in-memory instance), creates a
	 * fresh Canvas under the canonical GUID, and seeds its remoteDoc from
	 * the server; the bridge and the machine converge localDoc and disk
	 * from there. On failure, pendingUpload stays intact so the next
	 * observer event or startup scan retries.
	 */
	private async executeCanvasRemap({ path, fromGuid, toGuid }: {
		path: string;
		fromGuid: string;
		toGuid: string;
	}): Promise<void> {
		if (!this.connected) {
			this.log(`[${path}] canvas remap deferred: folder offline`);
			return;
		}
		if (this.serverEmptyTerminal(toGuid)) {
			this.debug(
				`[${path}] canvas remap skipped: server has no content for guid; awaiting server evidence`,
			);
			return;
		}

		let updateBytes: Uint8Array | undefined;
		try {
			updateBytes = await this.backgroundSync.downloadByGuid(
				this,
				toGuid,
				path,
				"canvas",
			);
		} catch (e) {
			this.warn(`[${path}] canvas remap download failed, deferring`, e);
			return;
		}
		if (!updateBytes) {
			this.recordServerEmpty(toGuid);
			this.log(`[${path}] canvas remap deferred: server has guid but no content yet`);
			return;
		}
		if (this.destroyed) return;

		// From here the local identity's CRDT history is discarded: the
		// localDoc database and machine record are deleted, and only the
		// disk file carries the local content forward. The new canvas meets
		// that file with no LCA and converges by additive union on its
		// first evaluation — nothing durable is lost that the disk file
		// does not hold, but edit history under the old guid is gone. This
		// mirrors the document-remap precedent.
		const existing = this.files.get(fromGuid);
		try {
			indexedDB.deleteDatabase(`${this.appId}-relay-canvas-${fromGuid}`);
		} catch { /* best effort stale database cleanup */ }
		const p = this._hsmStore.deleteState(fromGuid).catch(() => {});
		trackAsyncCleanup(p);
		this.backgroundSync.cancelDocumentWork(fromGuid);
		this.mergeManager?.unregisterManagedFile(fromGuid);

		if (existing) {
			this.files.delete(fromGuid);
			this.fset.delete(existing);
			existing.cleanup();
			existing.destroy();
		}
		this.syncStore.pendingUpload.delete(path);

		const canvas = this.getOrCreateCanvas(toGuid, path);
		this.files.set(toGuid, canvas);
		this.fset.add(canvas);
		canvas.wake();
		Y.applyUpdate(canvas.ydoc, updateBytes);
		canvas.hsm.send({ type: "DOWNLOAD_COMPLETE" });

		this.log(
			`Remapped Canvas ${path}: ${fromGuid} → ${toGuid} ` +
				"(local history under the old identity discarded; disk content " +
				"re-converges when the canvas is next opened)",
		);
	}

	private applyRemoteState(
		guid: string,
		path: string,
		remoteIds: Set<string>,
		diffLog: string[],
	): OperationType {
		const file = this.files.get(guid);
		const meta = this.syncStore.getMeta(path);
		if (!meta) {
			this.warn("unknown sync type", path);
			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (this.existsSync(path)) {
			// Check for type mismatch: local SyncFile vs remote Canvas
			if (file && isSyncFile(file) && isCanvasMeta(meta)) {
				// Upgrade SyncFile to Canvas type
				const promise = this._upgradeToCanvas(file, guid, path, diffLog);
				return { op: "upgrade", path, promise };
			}

			// XXX file meta typing
			if (file && isSyncFile(file) && file.shouldPull(meta as FileMeta)) {
				// Route through the download queue: it retries transient
				// failures with backoff and records terminal ones for the
				// periodic reclaim pass, so a failed pull stays claimable
				// instead of spending its single attempt here.
				const promise = this.backgroundSync
					.enqueueDownload(file, false)
					.then(
						() => undefined,
						(error) => {
							this.warn(`pull failed for ${path}`, error);
						},
					);
				return { op: "update", path, promise };
			}

			// GUID mismatch — file at this path is mapped under a different
			// guid locally than meta.id. Reconcile by swapping identity to
			// the canonical meta.id.
			if (!file) {
				const localIdentity = this.findNonCanonicalIdentityAtPath(path, guid);
				const localGuid = localIdentity?.guid;
				const localFile = localIdentity?.file;

				if (localGuid && localFile && isSyncFile(localFile) && isFileMetas(meta)) {
					const promise = this.resolveLostFileClaim(
						localFile,
						localGuid,
						guid,
						path,
						meta,
					);
					return { op: "update", path, promise };
				}

				if (localGuid && localGuid !== guid && isDocumentMeta(meta)) {
					return {
						op: "update",
						path,
						promise: this.executeRemap({
							path,
							fromGuid: localGuid,
							toGuid: guid,
						}),
					};
				}
			}

			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (remoteIds.has(guid) && file) {
			const oldPath = this.getPath(file.path);
			const tfile = this.vault.getAbstractFileByPath(oldPath);
			if (tfile) {
				const promise = this._handleServerRename(file, path, tfile, diffLog);
				return {
					op: "rename",
					path: path,
					from: oldPath,
					to: path,
					promise,
				};
			}
		}

		// write will trigger `create` which will read the file from disk by default.
		// so we need to pre-empt that by loading the file into docs.
		const promise = this._handleServerCreate(path, meta, diffLog);
		return { op: "create", path, promise };
	}

	/**
	 * Resolve a content-addressed file whose local identity lost its claim
	 * race: committed metadata names another identity for the path, so the
	 * local mint can never publish. Matching bytes adopt the committed
	 * identity in place. When bytes diverge, the committed claim wins: the
	 * resolver logs the discarded local hash, adopts temporarily, and pulls
	 * the committed bytes before releasing the losing hold. A failed pull
	 * rolls the identity back so reconciliation can retry. Every resolution
	 * releases the pending-upload hold: a lost claim left held shields its
	 * path from remote deletions indefinitely and republishes the losing
	 * identity the moment the committed entry is deleted.
	 */
	private async resolveLostFileClaim(
		localFile: SyncFile,
		localGuid: string,
		remoteGuid: string,
		path: string,
		remoteMeta: FileMetas,
	): Promise<void> {
		// One reconciliation owns a path at a time (the remap discipline):
		// a second sweep re-detecting the same lost claim mid-resolution
		// must stand down rather than preserve the same bytes twice.
		if (this._pendingRemaps.has(path)) {
			this.log(
				`[${path}] lost-claim resolution deferred: another reconciliation owns this path`,
			);
			return;
		}
		this._pendingRemaps.add(path);
		try {
			this.backgroundSync.cancelDocumentWork(localGuid);
			if (!localFile.caf.exists()) {
				// No local bytes to adopt or preserve. Release the losing
				// enrollment and its hold; the next reconciliation pass
				// materializes the committed file through the server-create
				// path.
				this.files.delete(localGuid);
				this.pendingUpload.delete(path);
				this.fset.delete(localFile);
				localFile.cleanup();
				localFile.destroy();
				this.log(
					`Released lost claim for missing local file ${path} (${localGuid})`,
				);
				return;
			}
			const localHash = await localFile.caf.hash();
			const diverged = localHash !== remoteMeta.hash;
			if (diverged) {
				this.warn(
					`[${path}] discarding divergent local content ${localHash}; committed content ${remoteMeta.hash} won the claim`,
				);
				await this.adoptAndPullCommittedFile(
					localFile,
					localGuid,
					remoteGuid,
				);
				this.pendingUpload.delete(path);
				this.log(
					`Discarded divergent local content ${localHash} at ${path} after pulling committed content`,
				);
				return;
			}
			this.files.delete(localGuid);
			this.pendingUpload.delete(path);
			this.enrollUnderCommittedGuid(localFile, remoteGuid);
			this.log(
				`Remapped file ${path} from local GUID ${localGuid} to remote GUID ${remoteGuid}`,
			);
		} catch (error) {
			this.error("Error during GUID remapping:", error);
			throw error;
		} finally {
			this._pendingRemaps.delete(path);
		}
	}

	/**
	 * Temporarily enroll a divergent file under the committed identity and
	 * pull the committed bytes. The losing hold remains until the pull has
	 * succeeded. If the queue gives up, restore the losing enrollment so no
	 * later sync can publish the divergent bytes under the winner's identity.
	 */
	private async adoptAndPullCommittedFile(
		localFile: SyncFile,
		localGuid: string,
		remoteGuid: string,
	): Promise<void> {
		const existing = this.files.get(remoteGuid);
		if (existing && existing !== localFile) {
			if (!isSyncFile(existing)) {
				throw new Error(`committed identity ${remoteGuid} is not a file`);
			}
			await this.backgroundSync.enqueueDownload(existing, false);
			this.files.delete(localGuid);
			this.fset.delete(localFile);
			localFile.cleanup();
			localFile.destroy();
			return;
		}

		this.files.delete(localGuid);
		this.files.set(remoteGuid, localFile);
		localFile.guid = remoteGuid;
		try {
			await this.backgroundSync.enqueueDownload(localFile, false);
		} catch (error) {
			this.files.delete(remoteGuid);
			this.files.set(localGuid, localFile);
			localFile.guid = localGuid;
			throw error;
		}
	}

	/**
	 * Enroll the surviving instance under the committed identity. When a
	 * live instance already owns that identity the losing instance stands
	 * down instead — two instances must never share a guid.
	 */
	private enrollUnderCommittedGuid(
		localFile: SyncFile,
		remoteGuid: string,
	): SyncFile | undefined {
		const existing = this.files.get(remoteGuid);
		if (existing && existing !== localFile) {
			this.fset.delete(localFile);
			localFile.cleanup();
			localFile.destroy();
			return isSyncFile(existing) ? existing : undefined;
		}
		this.files.set(remoteGuid, localFile);
		localFile.guid = remoteGuid;
		return localFile;
	}

	private async _upgradeToCanvas(
		syncFile: SyncFile,
		remoteGuid: string,
		path: string,
		diffLog?: string[],
	): Promise<void> {
		try {
			// Remove the old SyncFile
			const localGuid = syncFile.guid;
			this.files.delete(localGuid);
			this.fset.delete(syncFile);
			syncFile.destroy();

			diffLog?.push(`Upgrading ${path} from SyncFile to Canvas`);
			this.log(
				`Upgrading ${path} from SyncFile to Canvas (GUID: ${localGuid} → ${remoteGuid})`,
			);

			// downloadCanvas will handle adding to files and fset
			await this.downloadCanvas(path, false);
			this.log(`Successfully upgraded ${path} to Canvas`);
		} catch (error) {
			this.error("Error during SyncFile to Canvas upgrade:", error);
			throw error;
		}
	}

	private cleanupExtraLocalFiles(
		remotePaths: ReadonlySet<string>,
		diffLog: string[],
	): Delete[] {
		// Delete files that are no longer shared
		const ffiles = this.getSyncFiles();
		const deletes: Delete[] = [];
		const folders = ffiles.filter((file) => file instanceof TFolder);
		const files = ffiles.filter((file) => file instanceof TFile);
		const sync = (file: TAbstractFile) => {
			// If the file is in the shared folder and not in the map, move it to the Trash
			const isSyncableFile = this.isSyncableTFile(file);
			const fileInFolder = this.checkPath(file.path);
			const vpath = this.getVirtualPath(file.path);
			const fileInMap = remotePaths.has(vpath);
			const filePending =
				this.pendingUpload.has(vpath) || this.pendingCreates.has(vpath);
			const synced = this._provider?.synced && this._persistence?.synced;
			if (fileInFolder && isSyncableFile && !fileInMap && !filePending) {
				if (synced) {
					diffLog.push(`deleted local file ${vpath} for remotely deleted doc`);
					this.markPendingDelete(vpath);
					const promise = this.vault.adapter
						.trashLocal(file.path)
						.then(() => {
							// The pending-delete mark suppresses the trash's own
							// vault-delete echo, so the deletion handler that
							// would destroy the live in-memory doc never runs for
							// this path. A surviving doc re-creates the file on
							// its next engine write and re-registers it as new.
							// Tear it down here the way a processed vault delete
							// would, before the mark clears — the write guard
							// covers the window, and a destroyed doc's queued
							// writes stand down.
							const doc = this.fset.find((f) => f.path === vpath);
							if (doc) {
								this.fset.delete(doc);
								this.files.delete(doc.guid);
								doc.cleanup();
								doc.destroy();
								this.teardownDocState(doc.guid);
								this.fset.update();
							}
							// The removal's disk adoption is complete: the path
							// may classify as a local creation again, so a
							// legitimate recreation is not refused.
							this.serverOps.clearDelete(vpath);
							this.bootSnapshot?.discard(vpath);
						})
						.finally(() => {
							this.clearPendingDelete(vpath);
						});
					deletes.push({
						op: "delete",
						path: vpath,
						promise,
					});
				}
			}
		};
		files.forEach(sync);
		folders.forEach(sync);
		return deletes;
	}

	private getDesiredRemotePaths(): Set<string> {
		const paths = new Set<string>();
		this.syncStore.forEachWithPending((_meta, path) => {
			paths.add(path);
		});
		return expandDesiredRemotePaths(paths);
	}

	/**
	 * True once outbound membership publication is permitted. Kept as the
	 * outbound consumers' API; the machine is its authority.
	 */
	public get membershipSettled(): boolean {
		return this.folderMachine.mayPublish;
	}

	/** Resolves when publication is permitted (immediately at teardown). */
	public whenMembershipSettled(): Promise<void> {
		return this.folderMachine.whenMayPublish().then(() => undefined);
	}

	public shouldDeferPendingPublication(path: string): boolean {
		return !this.folderMachine.mayPublish && this.pendingUpload.has(path);
	}

	/**
	 * Is this path a genuinely local creation? Reads the blended store, the
	 * boot snapshot, and the pending remote deletes — each source only ever
	 * widens "not novel", so the answer is strictly a refusal to mint.
	 */
	private isNovelPath(vpath: string): boolean {
		return (
			!this.syncStore.has(vpath) &&
			!(this.bootSnapshot?.has(vpath) ?? false) &&
			!this.serverOps.coversPath(vpath)
		);
	}

	/**
	 * A vault create at a move source is a distinct disk occupant: it may
	 * claim the path without taking over the moved guid, so the snapshot
	 * retires for it and normal settling may mint the new occupant.
	 */
	private observeMoveSourceRecreation(vpath: string): boolean {
		if (!this.serverOps.observeSourceRecreation(vpath)) return false;
		this.bootSnapshot?.discard(vpath);
		return true;
	}

	/** Consume the vault rename that makes one server move real on disk. */
	private consumeMoveEcho(oldVPath: string, newVPath: string): boolean {
		const move = this.serverOps.moveFrom(oldVPath);
		if (!move || move.to !== newVPath) return false;

		// Live membership at the source belongs to a separately recreated
		// file, even while the guid-keyed move remains in flight.
		const sourceGuid = this.syncStore.get(oldVPath);
		if (sourceGuid !== undefined && sourceGuid !== move.guid) return false;

		const moved = this.files.get(move.guid);
		if (moved && moved.path !== newVPath) {
			moved.move(newVPath, this);
		}
		this.serverOps.completeMove(oldVPath, newVPath);
		this.bootSnapshot?.discard(oldVPath);
		return true;
	}

	/**
	 * The initial reconcile: the boot snapshot meets the server's completed
	 * view. Stale claims on remotely deleted paths release synchronously —
	 * before any parked publication resumes — and the tree sync then adopts
	 * those deletions on disk. The snapshot dies with the drain.
	 */
	private runInitialReconcile(): void {
		// The probe excludes the device's own claims: a path the device
		// still holds a claim on is "known" to the blended accessor because
		// of the claim under review, which would let every stale hold vouch
		// for itself.
		const liveMembership = (path: string) =>
			this.syncStore.has(path) && !this.pendingUpload.has(path);
		const gone = (
			this.bootSnapshot?.deletedSince(liveMembership) ?? []
		).filter((path) => !this.serverOps.moveFrom(path));
		for (const path of this.serverOps.pendingDeletePaths()) {
			if (this.bootSnapshot?.has(path)) continue;
			if (!liveMembership(path)) gone.push(path);
		}
		for (const path of gone) {
			const guid = this.pendingUpload.get(path);
			if (!guid) continue;
			this.log("releasing stale claim on remotely deleted path", path, guid);
			this.pendingUpload.delete(path);
			this.backgroundSync.cancelDocumentWork(guid);
		}
		const reconcile = (async () => {
			// A tree sync already in flight may predate the claim drops above;
			// let it finish, then run one that observes them.
			if (this.syncFileTreePromise) {
				await this.syncFileTreePromise.getPromise().catch(() => {});
			}
			if (this.destroyed) return;
			await this.syncFileTree();
		})()
			.catch((e) => {
				if (!isDestroyedError(e)) {
					this.warn("initial reconcile tree sync failed", e);
				}
			})
			.finally(() => {
				this.bootSnapshot = null;
				this.folderMachine.send({ type: "INITIAL_RECONCILE_COMPLETE" });
			});
		trackPromise(`folder:initialReconcile:${this.guid}`, reconcile);
	}

	/**
	 * Legacy create routing. A file already known to the sync store
	 * materializes immediately (the caller reads it in); a genuinely-new file's
	 * registration settles for the debounce window so a short-lived atomic-write
	 * temp file vanishes before it is place-held and uploaded. Returns whether
	 * the caller should materialize the file now.
	 */
	public notifyVaultCreateLegacy(tfile: TAbstractFile): boolean {
		const vpath = this.getVirtualPath(tfile.path);
		if (this.isPendingDelete(vpath)) return false;
		if (this.syncStore.has(vpath)) return true;
		this.observeMoveSourceRecreation(vpath);
		this.scheduleLegacyCreate(vpath);
		return false;
	}

	/**
	 * Place-hold and upload a novel legacy-path file after the debounce window.
	 * The timer re-checks that the file still exists on disk before acting — a
	 * rename-away or delete within the window leaves nothing to register.
	 */
	private scheduleLegacyCreate(vpath: string): void {
		this.cancelPendingCreate(vpath);
		const timer = this.timeProvider.setTimeout(() => {
			this.pendingCreates.delete(vpath);
			if (this.isPendingDelete(vpath)) return;
			const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
			if (!tfile) return;
			if (this.rejectReaderFolderChange([vpath])) return;
			const newDocs = this.placeHold([tfile]);
			if (newDocs.includes(vpath)) {
				this.uploadFile(tfile);
			}
		}, NEW_FILE_REGISTRATION_DEBOUNCE_MS);
		this.pendingCreates.set(vpath, timer);
	}

	/** Cancel a settling create — the path was removed or renamed away. */
	private cancelPendingCreate(vpath: string): void {
		const timer = this.pendingCreates.get(vpath);
		if (timer !== undefined) {
			this.timeProvider.clearTimeout(timer);
			this.pendingCreates.delete(vpath);
		}
	}

	private readerRestoreRenameKey(oldPath: string, newPath: string): string {
		return `${oldPath}\0${newPath}`;
	}

	private consumeReaderRestoreRenameEcho(
		file: TAbstractFile,
		oldPath: string,
	): boolean {
		const echoes = this.readerRestoreRenameEchoes ??= new Set();
		return echoes.delete(this.readerRestoreRenameKey(oldPath, file.path));
	}

	private restoreUntrackedReaderRename(
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> {
		const echoes = this.readerRestoreRenameEchoes ??= new Set();
		const key = this.readerRestoreRenameKey(file.path, oldPath);
		echoes.add(key);
		let restore: Promise<void>;
		try {
			restore = this.fileManager.renameFile(file, normalizePath(oldPath));
		} catch (error) {
			echoes.delete(key);
			throw error;
		}
		return restore.catch((error) => {
			echoes.delete(key);
			throw error;
		});
	}

	/** Route an in-folder vault rename. */
	public notifyVaultRename(file: TAbstractFile, oldPath: string): void {
		if (this.consumeReaderRestoreRenameEcho(file, oldPath)) return;
		const oldVPath = this.getVirtualPath(oldPath);
		const newVPath = this.getVirtualPath(file.path);
		this.cancelPendingCreate(oldVPath);
		this.cancelPendingCreate(newVPath);
		if (this.consumeMoveEcho(oldVPath, newVPath)) {
			return;
		}
		const oldTracked = this.syncStore.has(oldVPath);
		const newTracked = this.syncStore.has(newVPath);
		const hasPendingClaim =
			this.pendingUpload.has(oldVPath) || this.pendingUpload.has(newVPath);
		if (!this.canManageFiles && !oldTracked && !hasPendingClaim) return;
		if (this.rejectReaderFolderChange([oldVPath, newVPath])) {
			const guid = this.syncStore.get(oldVPath);
			const sharedFile = guid ? this.files.get(guid) : undefined;
			const restore = sharedFile
				? this._handleServerRename(sharedFile, oldVPath, file)
				: this.restoreUntrackedReaderRename(file, oldPath);
			trackPromise(`restoreReaderRename:${this.guid}:${oldVPath}`, restore);
			return;
		}
		if (oldTracked) {
			this.renameFile(file, oldPath);
			return;
		}
		if (newTracked || !this.isSyncableTFile(file)) return;
		// A distinct file renamed into the vacated source is a new disk
		// occupant. It may claim the path without taking over the moved guid.
		this.observeMoveSourceRecreation(newVPath);
		const newDocs = this.placeHold([file]);
		if (newDocs.includes(newVPath)) {
			this.uploadFile(file);
		}
	}

	/**
	 * Remove the durable records this folder owns outside its per-file IDB
	 * databases: merge-HSM states scoped to this folder and hash-store rows
	 * for paths inside it. Both stores are app-wide and outlive the folder
	 * instance; explicit removal is the only point where these records
	 * become garbage.
	 */
	public async reclaimOwnedRecords(): Promise<void> {
		try {
			const stateMetas = await this._hsmStore.getAllStateMeta();
			for (const stateMeta of stateMetas) {
				if (stateMeta.folder !== this.guid) continue;
				await this._hsmStore.deleteState(stateMeta.guid).catch(() => {});
			}
		} catch (e) {
			this.warn("record reclaim: HSM state metadata unavailable", e);
		}
		try {
			const entries = await this.hashStore.getAllEntries();
			for (const entry of entries) {
				if (!this.checkPath(entry.path)) continue;
				await this.hashStore.removeHash(entry.path).catch(() => {});
			}
		} catch (e) {
			this.warn("record reclaim: hash store unavailable", e);
		}
	}

	public recordReaderEditOverwrite(guid: string, path: string): void {
		if (this.destroyed || !flags().enableReadOnlyPermissions) return;
		const file = this.files.get(guid);
		const fullPath =
			file && (isDocument(file) || isCanvas(file))
				? join(this.path, file.path)
				: path || guid;
		const now = this.timeProvider.now();
		const lastShown = this._recentReaderEditOverwrites.get(fullPath);
		if (
			lastShown !== undefined &&
			now - lastShown < READER_EDIT_OVERWRITE_COOLDOWN_MS
		) {
			return;
		}
		this._recentReaderEditOverwrites.set(fullPath, now);
		if (!this._readerEditOverwrites.includes(fullPath)) {
			this._readerEditOverwrites.push(fullPath);
		}
		if (this._readerEditOverwriteTimer !== null) return;
		this._readerEditOverwriteTimer = this.timeProvider.setTimeout(() => {
			this._readerEditOverwriteTimer = null;
			this.flushReaderEditOverwrites();
		}, READER_EDIT_OVERWRITE_COALESCE_MS);
	}

	private flushReaderEditOverwrites(): void {
		if (this._readerEditOverwriteTimer !== null) {
			this.timeProvider.clearTimeout(this._readerEditOverwriteTimer);
			this._readerEditOverwriteTimer = null;
		}
		const paths = this._readerEditOverwrites;
		this._readerEditOverwrites = [];
		if (paths.length === 0) return;

		const shown = paths.slice(0, 3);
		const remainder = paths.length - shown.length;
		const fileList =
			shown.join(", ") + (remainder > 0 ? `, +${remainder} more` : "");
		const lead =
			paths.length === 1
				? `A local edit to ${shown[0]} was rejected because this folder is read-only.`
				: `Local edits to ${paths.length} files were rejected because this folder is read-only: ${fileList}.`;
		const message =
			`${lead} The shared version remains authoritative and the edit was not shared. ` +
			`If the edit reached disk, open Obsidian's File Recovery (core plugin), ` +
			`or use git if this vault is version-controlled.`;
		new Notice(message, READER_EDIT_OVERWRITE_NOTICE_MS);
		this.log(`[read-only] reader edits overwritten: ${paths.join(", ")}`);
	}
	syncByType(
		syncStore: SyncStore,
		diffLog: string[],
		ops: Operation[],
		types: SyncType[],
	) {
		const remoteIds = syncStore.remoteIds;
		syncStore.forEachWithPending((meta, path) => {
			if (!this._assertNamespacing(path)) return;
			if (meta && types.contains(meta.type)) {
				ops.push(this.applyRemoteState(meta.id, path, remoteIds, diffLog));
			} else if (!meta && types.contains(SyncType.Document)) {
				ops.push(this.applyPendingUpload(path));
			}
		});
	}

	/**
	 * Retry a pending upload for a path whose local meta was never written
	 * (the initial enqueueSync failed or was deferred). Resolves the file via
	 * pendingUpload's guid, re-enqueues sync, and calls markUploaded on success
	 * so the local meta gets written and pendingUpload is cleared.
	 */
	private applyPendingUpload(
		path: string,
		coordinated = false,
		run?: PendingPublicationRun,
	): OperationType {
		if (this.destroyed) {
			return { op: "noop", path, promise: Promise.resolve() };
		}
		const pendingGuid = this.syncStore.pendingUpload.get(path);
		if (!pendingGuid) {
			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (!this.folderMachine.mayPublish) {
			// Publication defers until the initial reconcile. Its claim drops
			// run synchronously at the transition, so a resumed park re-reads
			// the hold and stands down when its claim was released.
			let parked = this._parkedPublications.get(path);
			if (!parked) {
				parked = this.folderMachine
					.whenMayPublish()
					.then(async () => {
						if (this.destroyed) return;
						await this.applyPendingUpload(path).promise;
					})
					.finally(() => {
						this._parkedPublications.delete(path);
					});
				this._parkedPublications.set(path, parked);
			}
			return {
				op: "update",
				path,
				promise: parked,
			};
		}
		if (!coordinated) {
			return this.coordinatePendingPublication(path, pendingGuid);
		}

		const committedMeta =
			run?.supersedingMeta ?? this.syncStore.getCommittedMeta(path);
		if (run?.supersedingMeta) run.supersedingMeta = undefined;

		// Server-authoritative rule: if committed filemeta already points at a
		// different GUID for this path, do not publish/overwrite local pending
		// metadata. Adopt the committed GUID instead.
		if (committedMeta && committedMeta.id !== pendingGuid) {
			if (run) run.decision = "rebind";
			this.backgroundSync.cancelDocumentWork(pendingGuid);
			this.warn(
				"[applyPendingUpload] committed GUID differs from pending upload",
				{
					path,
					pendingGuid,
					committedGuid: committedMeta.id,
				},
			);
			const pendingFile = this.files.get(pendingGuid);
			// A document rebind does not need the losing file loaded: the
			// remap materializes the committed identity itself.
			if (
				isDocumentMeta(committedMeta) &&
				(!pendingFile || isDocument(pendingFile))
			) {
				return {
					op: "update",
					path,
					promise: this.executeRemap({
						path,
						fromGuid: pendingGuid,
						toGuid: committedMeta.id,
					}),
				};
			}
			if (isCanvasMeta(committedMeta) && pendingFile && isCanvas(pendingFile)) {
				return {
					op: "update",
					path,
					promise: this.executeCanvasRemap({
						path,
						fromGuid: pendingGuid,
						toGuid: committedMeta.id,
					}),
				};
			}
			if (isFileMetas(committedMeta) && pendingFile && isSyncFile(pendingFile)) {
				return {
					op: "update",
					path,
					promise: this.resolveLostFileClaim(
						pendingFile,
						pendingGuid,
						committedMeta.id,
						path,
						committedMeta,
					),
				};
			}
			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (this.skipStorageBlockedUpload(path)) {
			if (run) run.decision = "noop";
			return { op: "noop", path, promise: Promise.resolve() };
		}

		const file = this.files.get(pendingGuid);
		if (!file || !(isDocument(file) || isCanvas(file) || isSyncFile(file))) {
			if (run) run.decision = "noop";
			return { op: "noop", path, promise: Promise.resolve() };
		}
		if (run) run.decision = "publish";
		return {
			op: "update",
			path,
			promise: (async () => {
				await this.preparePendingFileForPublication(file);
				if (this.destroyed || run?.cancelled) return;
				const latestMeta = this.syncStore.getCommittedMeta(path);
				if (latestMeta && latestMeta.id !== pendingGuid) {
					if (run) {
						run.cancelled = true;
						run.rerun = true;
						run.supersedingMeta = latestMeta;
					}
					this.backgroundSync.cancelDocumentWork(pendingGuid);
					return;
				}
				const outcome = await this.backgroundSync.enqueueUpload(file);
				if (run?.cancelled) {
					this.backgroundSync.cancelDocumentWork(pendingGuid);
					return;
				}
				await this.markUploaded(file, outcome);
			})(),
		};
	}

	private coordinatePendingPublication(
		path: string,
		pendingGuid: string,
	): OperationType {
		const active = this._publicationRuns.get(path);
		if (active) {
			active.rerun = true;
			const committedMeta = this.syncStore.getCommittedMeta(path);
			if (
				active.decision === "publish" &&
				committedMeta &&
				committedMeta.id !== active.pendingGuid
			) {
				active.cancelled = true;
				active.supersedingMeta = committedMeta;
				this.backgroundSync.cancelDocumentWork(active.pendingGuid);
			}
			return { op: "update", path, promise: active.promise };
		}

		const run: PendingPublicationRun = {
			decision: "noop",
			pendingGuid,
			rerun: false,
			cancelled: false,
			supersedingMeta: undefined,
			promise: Promise.resolve(),
		};
		this._publicationRuns.set(path, run);
		run.promise = this.runPendingPublication(path, run)
			.finally(() => {
				if (this._publicationRuns.get(path) === run) {
					this._publicationRuns.delete(path);
				}
			});
		return { op: "update", path, promise: run.promise };
	}

	private async runPendingPublication(
		path: string,
		run: PendingPublicationRun,
	): Promise<void> {
		do {
			run.rerun = false;
			run.cancelled = false;
			run.pendingGuid = this.pendingUpload.get(path) ?? run.pendingGuid;
			const operation = this.applyPendingUpload(path, true, run);
			await operation.promise;
		} while (
			run.rerun &&
			!this.destroyed &&
			this.pendingUpload.has(path)
		);
	}

	private async preparePendingFileForPublication(file: IFile): Promise<void> {
		if (isDocument(file)) {
			await this.initializeDocumentContentOnce(file);
			return;
		}
		if (isCanvas(file) && (await file.getOrigin()) === undefined) {
			const contents = await this.read(file);
			// Teardown can release the read; a canvas teardown took apart is
			// not ours to enroll content into.
			if (this.destroyed) return;
			await file.enrollLocal(contents);
			file.markOrigin("local");
		}
	}

	private async initializeDocumentContentOnce(file: Document): Promise<void> {
		const hsm = file.hsm;
		if (!hsm) return;
		let enrollment = this._pendingDocumentEnrollments.get(file);
		if (!enrollment) {
			const newEnrollment = (async () => {
				await hsm.initializeWithContent();
			})().catch((error) => {
				this._pendingDocumentEnrollments.delete(file);
				throw error;
			});
			this._pendingDocumentEnrollments.set(file, newEnrollment);
			enrollment = newEnrollment;
		}
		await enrollment;
	}

	/**
	 * A pending-upload hold whose path already has committed metadata is
	 * finished business: a matching guid means the publication completed and
	 * the clear was missed; a different guid means the claim lost its race
	 * and adoption has had its chance by the end of a converged sync. A
	 * leaked hold is not inert — it shields the local file from
	 * remote-delete cleanup and re-publishes the path on the first tree
	 * sync after its committed meta is deleted (deleted files silently
	 * reappear) — and its backing storage preserves it across sessions
	 * indefinitely.
	 */
	private sweepStalePendingUploads(): void {
		if (!(this._provider?.synced && this._persistence?.synced)) return;

		const stale: {
			vpath: string;
			pending: string;
			committed: string;
			enrolledUnderPending: boolean;
		}[] = [];
		this.syncStore.pendingUpload.forEach((guid, vpath) => {
			if (this._pendingRemaps.has(vpath)) return;
			if (this._publicationRuns.has(vpath)) return;
			const committed = this.syncStore.getCommittedMeta(vpath);
			if (!committed) return;
			// A live instance still enrolled under the losing guid means
			// adoption stalled; clearing the hold lets path lookups resolve
			// to the committed identity and the reconciliation sweep re-key
			// it.
			stale.push({
				vpath,
				pending: guid,
				committed: committed.id,
				enrolledUnderPending: !!this.files.get(guid),
			});
		});
		if (stale.length === 0) return;

		stale.forEach(({ vpath }) => this.pendingUpload.delete(vpath));
		this.warn("dropped stale pending-upload holds", stale);
	}

	syncFileTree(): Promise<void> {
		// If a sync is already running, mark that we want another sync after
		if (this.syncFileTreePromise) {
			this.syncRequestedDuringSync = true;
			const promise = this.syncFileTreePromise.getPromise();
			void promise.then(
				() => {
					if (this.syncRequestedDuringSync) {
						this.syncRequestedDuringSync = false;
						void this.syncFileTree().catch((error) => {
							if (!isDestroyedError(error)) {
								this.warn("syncFileTree follow-up failed", error);
							}
						});
					}
				},
				() => {},
			);
			return promise;
		}

		const promiseFn = async (): Promise<void> => {
			try {
				if (!this.mergeManager || this.destroyed) return;
				await this.mergeManager.initialize();
				if (this.destroyed) return;

				// When file types are newly enabled, enqueue their local
				// files for syncing before the rest of the tree sync runs.
				const currentTypes = this.syncStore.typeRegistry.getEnabledFileSyncTypes();
				const newlyEnabled = currentTypes.filter(
					(t) => !this.enabledSyncTypes.has(t),
				);
				this.enabledSyncTypes = new Set(currentTypes);
				if (newlyEnabled.length > 0) {
					this.addLocalDocs(newlyEnabled);
				}

				const ops: Operation[] = [];
				const diffLog: string[] = [];

				this.folderDoc.transact(async () => {
					// Sync folder operations first because renames/moves also affect files
					this.syncStore.migrateUp();
					this.syncByType(this.syncStore, diffLog, ops, [SyncType.Folder]);
				}, this);
				await Promise.all(ops.map((op) => op.promise));
				this.folderDoc.transact(async () => {
					this.syncByType(
						this.syncStore,
						diffLog,
						ops,
						this.syncStore.typeRegistry.getEnabledFileSyncTypes(),
					);
					this.syncStore.commit();
				}, this);

				const creates = ops.filter((op) => op.op === "create");
				const renames = ops.filter((op) => op.op === "rename");

				// Ensure these complete before checking for deletions
				await Promise.all(
					[...creates, ...renames].map((op) =>
						withTimeoutWarning<IFile | void>(
							op.promise,
							this.timeProvider,
							op,
						),
					),
				);

				const remotePaths = this.getDesiredRemotePaths();
				const deletes = this.cleanupExtraLocalFiles(remotePaths, diffLog);
				if (![...ops, ...deletes].every((op) => op.op === "noop")) {
					this.log("remote paths", Array.from(remotePaths));
				}
				if ([...ops, ...deletes].every((op) => op.op === "noop")) {
					this.debug("sync: noop");
				} else {
					this.log("operations", [...ops, ...deletes]);
				}
				if (renames.length > 0 || creates.length > 0 || deletes.length > 0) {
					this.fset.update();
				}
				if (diffLog.length > 0) {
					this.log("syncFileTree diff:\n" + diffLog.join("\n"));
				}
				// An op with nothing left on disk to adopt has no echo to wait
				// for; confirm its absence so a later recreation is not refused
				// as a re-mint.
				for (const path of this.serverOps.pendingDeletePaths()) {
					if (!this.existsSync(path)) {
						this.serverOps.clearDelete(path);
						this.bootSnapshot?.discard(path);
					}
				}
				for (const move of this.serverOps.pendingMoves()) {
					if (!this.existsSync(move.from) && this.existsSync(move.to)) {
						const moved = this.files.get(move.guid);
						if (moved && moved.path === move.from) {
							moved.move(move.to, this);
						}
						this.serverOps.completeMove(move.from, move.to);
						this.bootSnapshot?.discard(move.from);
					}
				}
				this.sweepStalePendingUploads();
			} finally {
				// Reset the promise after completion (success or failure)
				this.syncFileTreePromise = null;
			}
		};

		this.syncFileTreePromise = new SharedPromise<void>(
			promiseFn,
			this.timeProvider,
		);

		return trackPromise(`folder:syncFileTree:${this.guid}`, this.syncFileTreePromise.getPromise());
	}

	move(path: string) {
		this.path = path;
		this.setLoggers(`[SharedFile](${this.path})`);
		this._settings.update((current) => ({
			...current,
			path,
		}));
	}

	read(doc: IFile): Promise<string> {
		const vaultPath = join(this.path, doc.path);
		return this.vault.adapter.read(normalizePath(vaultPath));
	}

	existsSync(path: string): boolean {
		const vaultPath = normalizePath(join(this.path, path));
		const pathExists = this.vault.getAbstractFileByPath(vaultPath) !== null;
		return pathExists;
	}

	exists(doc: IFile): Promise<boolean> {
		const vaultPath = join(this.path, doc.path);
		return this.vault.adapter.exists(normalizePath(vaultPath));
	}

	/**
	 * Write content over a file, refusing when the document is carrying work
	 * of its own.
	 *
	 * Resolves false when nothing was written — refused here, or refused
	 * inside the queued write once it reached the front. A caller that goes on
	 * to record the write as having happened has to be able to tell the
	 * difference, or a refusal turns into a file that silently never arrives.
	 */
	flush(doc: IFile, content: string): Promise<boolean> {
		const vaultPath = join(this.path, doc.path);
		if (isDocument(doc)) {
			// Last line of defence in front of the one operation that destroys
			// what the user has on disk. Whatever decided to write, a document
			// carrying work of its own is not ours to overwrite: the write
			// would settle the difference in the writer's favour, with no
			// record of it and no way back. Decided from machine state alone,
			// never from content — and fail-closed on a missing machine,
			// because a document that has been torn down cannot answer for
			// what is on its disk and is not the one anybody is tracking.
			if (!doc.hsm?.acceptsRemoteEnrollment) {
				this.warn(
					`[${doc.path}] write refused: the document is not in a state that accepts a remote copy`,
				);
				return Promise.resolve(false);
			}
			// Through the document, so the write records its own identity and
			// comes back recognised as ours. Written straight to the adapter it
			// reads as a change the user made, and is ingested into the local
			// copy of the document as one.
			this.log("writing to ", normalizePath(vaultPath));
			return doc.writeEngineContents(content);
		}
		this.log("writing to ", normalizePath(vaultPath));
		return this.vault.adapter
			.write(normalizePath(vaultPath), content)
			.then(() => true);
	}

	getPath(path: string): string {
		return join(this.path, path);
	}

	assertPath(path: string) {
		if (!this.checkPath(path)) {
			throw new Error("Path is not in shared folder: " + path);
		}
	}

	mkdir(path: string): Promise<void> {
		const vaultPath = join(this.path, path);
		return this.vault.adapter.mkdir(normalizePath(vaultPath));
	}

	checkPath(path: string): boolean {
		return path.startsWith(this.path + sep);
	}

	getVirtualPath(path: string): string {
		this.assertPath(path);

		const vPath = path.slice(this.path.length);
		return vPath;
	}

	getTFile(file: IFile): TFile | null {
		const maybeTFile = this.vault.getAbstractFileByPath(
			this.getPath(file.path),
		);
		if (maybeTFile instanceof TFile) {
			return maybeTFile;
		}
		return null;
	}

	private getDoc(vpath: string): Document | null {
		const id = this.syncStore.get(vpath);
		if (id !== undefined) {
			const doc = this.files.get(id);
			if (doc !== undefined) {
				doc.move(vpath, this);
				if (!isDocument(doc)) {
					throw new Error("getDoc(): unexpected ifile type");
				}
				return doc;
			} else {
				// the ID exists, but the file doesn't
				this.log("[getDoc]: creating doc for shared ID");
				if (this.pendingUpload.has(vpath)) {
					return this.uploadDoc(vpath);
				}
				return this.createDoc(vpath);
			}
		} else {
			if (!this.canManageFiles) return null;
			// the File exists, but the ID doesn't
			const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
			if (!(tfile instanceof TFile)) {
				throw new Error("unexpectedly missing tfile or got tfolder");
			}
			this.warn("[getDoc]: creating new shared ID for existing tfile");
			const newDocs = this.placeHold([tfile]);
			if (newDocs.length > 0) {
				return this.uploadDoc(vpath);
			} else {
				return this.createDoc(vpath);
			}
		}
	}

	private getCanvas(vpath: string): Canvas | null {
		const id = this.syncStore.get(vpath);
		if (id !== undefined) {
			const canvas = this.files.get(id);
			if (canvas !== undefined) {
				canvas.move(vpath, this);
				if (!isCanvas(canvas)) {
					throw new Error("getCanvas(): unexpected ifile type");
				}
				return canvas;
			} else {
				// the ID exists, but the file doesn't
				this.log("[getCanvas]: creating canvas for shared ID");
				if (this.pendingUpload.has(vpath)) {
					return this.uploadCanvas(vpath);
				}
				return this.createCanvas(vpath);
			}
		} else {
			if (!this.canManageFiles) return null;
			// the File exists, but the ID doesn't
			const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
			if (!(tfile instanceof TFile)) {
				throw new Error("unexpectedly missing tfile or got tfolder");
			}
			this.warn("[getCanvas]: creating new shared ID for existing tfile");
			const newDocs = this.placeHold([tfile]);
			if (newDocs.length > 0) {
				return this.uploadCanvas(vpath);
			} else {
				return this.createCanvas(vpath);
			}
		}
	}

	/**
	 * Drop the folder's durable pending-upload records wholesale. Only for
	 * folder removal: a suspended or merely unloaded folder still needs them
	 * to resume first uploads after relink.
	 */
	public clearPendingUploads(): void {
		this.pendingUpload.clear();
	}

	async markUploaded(
		file: IFile,
		outcome: SyncCompletionOutcome = "completed",
	) {
		if (isSyncFolder(file) && !this.canManageFiles) {
			if (this.pendingUpload.get(file.path) === file.guid) {
				this.recordReaderEditOverwrite("", this.getPath(file.path));
			}
			return;
		}
		// Claim-implies-fetchable: membership is never published for content
		// whose transfer did not complete. A cancelled transfer must stand
		// down even when the slot reads empty — the competing claim that
		// triggered the cancellation can itself be deleted before this
		// pipeline resumes, and publishing into that empty slot would commit
		// a claim whose bytes no server holds. The hold stays in place: the
		// reconciliation sweep re-dispatches the upload into the genuinely
		// empty slot, and publication follows the completed transfer.
		if (outcome === "cancelled") {
			this.log(
				"[markUploaded] stood down: the content transfer was cancelled",
				file.path,
			);
			return;
		}
		const mark = (file: IFile, meta: Meta) => {
			if (!this.syncStore) {
				return;
			}

			// Server-authoritative rule: never overwrite an existing committed
			// GUID for this path with a local pending GUID. The upload ran
			// outside the map, so the slot may have acquired a committed claim
			// while the transfer was in flight. The recheck is atomic with the
			// publication: the transaction that writes is the one that proves
			// the slot is still empty (or already carries this identity), so
			// no step can interleave between the proof and the write.
			let contestedMeta: Meta | undefined = undefined;
			this.folderDoc.transact(() => {
				const committedMeta = this.syncStore.getCommittedMeta(file.path);
				if (committedMeta && committedMeta.id !== meta.id) {
					contestedMeta = committedMeta;
					return;
				}
				if (this.syncStore.willSet(file.path, meta)) {
					this.log("new meta", file.path, meta);
					this.syncStore.markUploaded(file.path, meta);
				}
			}, this);
			// Read through an assertion: control flow cannot see the closure
			// assignment above.
			const committedMeta = contestedMeta as Meta | undefined;
			if (committedMeta) {
				this.warn(
					"[markUploaded] committed GUID differs from local upload metadata",
					{
						path: file.path,
						localGuid: meta.id,
						committedGuid: committedMeta.id,
					},
				);
				// Server metadata already chose a different GUID for this path.
				// The local upload succeeded, but the path must adopt the
				// committed identity instead of leaving pendingUpload to shadow
				// every later path lookup.
				if (this.pendingUpload.has(file.path)) {
					this.applyPendingUpload(file.path).promise.catch((e) => {
						this.warn(`[${file.path}] coordinated remap after upload failed`, e);
					});
				} else if (
					isDocument(file) &&
					isDocumentMeta(committedMeta) &&
					!this._pendingRemaps.has(file.path)
				) {
					// executeRemap owns the in-flight claim for the path.
					this.executeRemap({
						path: file.path,
						fromGuid: file.guid,
						toGuid: committedMeta.id,
					}).catch((e) => {
						this.warn(`[${file.path}] remap retry from markUploaded failed`, e);
					});
				} else if (
					isCanvas(file) &&
					isCanvasMeta(committedMeta) &&
					!this._pendingRemaps.has(file.path)
				) {
					this._pendingRemaps.add(file.path);
					this.executeCanvasRemap({
						path: file.path,
						fromGuid: file.guid,
						toGuid: committedMeta.id,
					}).catch((e) => {
						this.warn(`[${file.path}] canvas remap from markUploaded failed`, e);
					}).finally(() => {
						this._pendingRemaps.delete(file.path);
					});
				}
				return;
			}
		};
		if (isDocument(file)) {
			const meta = makeDocumentMeta(file.guid);
			mark(file, meta);
			return;
		}
		if (isCanvas(file)) {
			const meta = makeCanvasMeta(file.guid);
			mark(file, meta);
			return;
		}
		if (isSyncFolder(file)) {
			const meta = makeFolderMeta(file.guid);
			mark(file, meta);
			return;
		}
		if (isSyncFile(file)) {
			if (this.skipStorageBlockedUpload(file.path)) {
				return;
			}
			const type = this.syncStore.typeRegistry.getTypeForPath(file.path);
			if (!type) {
				throw new Error("unexpected sync type");
			}
			const hash = await file.caf.hash();
			if (!hash) {
				throw new Error("file hash not yet computed");
			}
			const meta = makeFileMeta(
				type as SyncFileType,
				file.guid,
				file.mimetype,
				hash,
				file.stat.mtime,
			);
			mark(file, meta);
			return;
		}
	}

	getFile(tfile: TAbstractFile): IFile | null {
		const file = this.resolveFile(tfile);
		if (file) {
			this.tfileGuids.set(tfile, file.guid);
		}
		return file;
	}

	private resolveFile(tfile: TAbstractFile): IFile | null {
		const vpath = this.getVirtualPath(tfile.path);

		// Identity first: Obsidian keeps one TAbstractFile instance per file
		// and mutates its path in place, so a guid learned for the instance
		// stays correct through the window where a rename has changed the
		// path but the path-keyed store hasn't processed the move yet. A
		// delete recreates the instance, so a stale entry cannot be reached.
		const known = this.tfileGuids.get(tfile);
		if (known !== undefined) {
			const knownFile = this.files.get(known);
			if (knownFile) {
				return knownFile;
			}
		}

		const guid = this.syncStore.get(vpath);

		// If file exists in sync store, use its metadata type to determine what to return
		if (guid) {
			const file = this.files.get(guid);
			if (file) {
				return file;
			}

			// File exists in sync store but not loaded - check its type from metadata
			const meta = this.syncStore.getMeta(vpath);
			if (meta) {
				if (meta.type === "markdown") {
					return this.getDoc(vpath);
				}
				if (meta.type === "canvas") {
					return this.getCanvas(vpath);
				}
				if (meta.type === "folder") {
					return this.getSyncFolder(vpath);
				}
				// Default to sync file for other types
				if (this.syncStore.canSync(vpath)) {
					return this.getSyncFile(vpath);
				}
			}
		}
		if (this.pendingCreates.has(vpath)) {
			return null;
		}
		// A path with no identity whose mint would be refused — known at
		// boot or mid remote-removal adoption — has no way to get one here.
		// Report it unresolved; reconciliation decides its fate.
		if (
			!guid &&
			(!this.folderMachine.mayMint || !this.isNovelPath(vpath))
		) {
			return null;
		}

		// Fallback to extension-based detection for new files
		if (tfile instanceof TFolder) {
			return this.getSyncFolder(vpath);
		} else if (tfile instanceof TFile) {
			if (Document.checkExtension(vpath)) {
				return this.getDoc(vpath);
			}
			if (
				Canvas.checkExtension(vpath) &&
				this.syncSettingsManager.isExtensionEnabled(vpath)
			) {
				return this.getCanvas(vpath);
			}
			if (this.isSyncableTFile(tfile)) {
				return this.getSyncFile(vpath);
			}
		}
		return null;
	}

	placeHold(newFiles: TAbstractFile[]): string[] {
		const newDocs: string[] = [];
		let loadedByPath: Map<string, IFile> | null = null;
		// Every discovery route reaches minting through this one predicate:
		// identity is minted only for a genuinely local creation, and only
		// while the machine permits minting. The refusal is what keeps a
		// deletion from resurrecting.
		const mayMint = this.folderMachine.mayMint;
		this.folderDoc.transact(() => {
			newFiles.forEach((file) => {
				const vpath = this.getVirtualPath(file.path);
				if (this.isPendingDelete(vpath)) {
					this.log("skipping place hold for pending delete", vpath);
					return;
				}
				const knownGuid = this.tfileGuids?.get(file);
				if (knownGuid !== undefined && this.files.has(knownGuid)) {
					this.log("skipping place hold for known file identity", vpath);
					return;
				}
				if (!this.isNovelPath(vpath)) {
					return;
				}
				// A loaded file still claiming this path marks it as the
				// disk-side source of a move whose membership entry has
				// already gone elsewhere — not a novel local create.
				if (loadedByPath === null) {
					loadedByPath = new Map();
					for (const loaded of this.files.values()) {
						loadedByPath.set(loaded.path, loaded);
					}
				}
				const loaded = loadedByPath.get(vpath);
				if (loaded) {
					this.tfileGuids ??= new WeakMap();
					this.tfileGuids.set(file, loaded.guid);
					this.log(
						"skipping place hold for the source of an in-flight move",
						vpath,
					);
					return;
				}
				if (!mayMint) {
					this.log("place hold refused before the boot snapshot", vpath);
					return;
				}
				this.log("place hold new", vpath);
				this.syncStore.new(vpath);
				newDocs.push(vpath);
			});
		}, this);
		return newDocs;
	}

	/** Load this canvas's persisted machine state from the vault-wide store. */
	public async loadCanvasState(
		guid: string,
	): Promise<PersistedCanvasState | null> {
		try {
			const record = await this._hsmStore.loadState(guid);
			return record?.kind === "canvas" ? record : null;
		} catch {
			return null;
		}
	}

	/** Persist a canvas machine record; background write, failures logged. */
	public saveCanvasState(guid: string, state: PersistedCanvasState): void {
		// Server-head comparisons for a canvas that has never materialized
		// this session read the manager's caches; every persisted record
		// refreshes them.
		this.mergeManager?.refreshManagedRecord(state);
		const p = this._hsmStore.saveState(guid, state).catch((err) => {
			this.error(`[CanvasHSM] saveState failed for ${guid}:`, err);
		});
		trackAsyncCleanup(p);
	}

	getOrCreateCanvas(guid: string, vpath: string): Canvas {
		const canvas =
			this.files.get(guid) || new Canvas(vpath, guid, this.loginManager, this);
		if (!isCanvas(canvas)) {
			throw new Error("getOrCreateCanvas(): unexpected ifile type");
		}
		canvas.move(vpath, this);
		if (this._localOnly) {
			canvas.setLocalOnly(true);
		}
		if (this.mergeManager) {
			const mergeManager = this.mergeManager;
			mergeManager.registerManagedFile(canvas);
			canvas.unregisterSyncMachine = mergeManager.registerSyncMachine(
				canvas.guid,
				canvas.hsm,
			);
			// Lazy materialization anywhere (a view touching localDoc, an
			// explicit whenSynced) flows back into warm accounting.
			canvas.onMaterialize = () =>
				mergeManager.notifyManagedFileWarm(canvas.guid);
		}
		return canvas;
	}

	async downloadCanvas(vpath: string, userVisible = true): Promise<Canvas> {
		if (!Canvas.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error(`called download on item that is not in ids ${vpath}`);
		}
		const canvas = this.getOrCreateCanvas(guid, vpath);
		canvas.markOrigin("remote");

		this.backgroundSync.enqueueDownload(canvas, userVisible);

		this.files.set(guid, canvas);
		this.fset.add(canvas);

		return canvas;
	}
	public uploadCanvas(vpath: string): Canvas {
		if (!Canvas.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const canvas = this.getOrCreateCanvas(guid, vpath);

		(async () => {
			const exists = await this.exists(canvas);
			// Same shape as uploadDoc: a detached dispatch with no rejection
			// handler, resuming on a folder that may since have been torn
			// down — and after teardown the file is usually gone, so the
			// existence failure below is the expected outcome.
			if (this.destroyed) return;
			if (!exists) {
				throw new Error(`Upload failed, doc does not exist at ${vpath}`);
			}
			// The publication run parks until the machine permits publishing
			// and enrolls the canvas's disk content just before its upload.
			if (this.pendingUpload.has(vpath)) {
				await this.applyPendingUpload(vpath).promise;
			}
		})();

		this.files.set(guid, canvas);
		this.fset.add(canvas);
		return canvas;
	}

	public createCanvas(vpath: string): Canvas {
		if (!Canvas.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const canvas = this.getOrCreateCanvas(guid, vpath);

		// Cold start: a persisted record whose last known disk state matches
		// the file on disk proves the canvas was cleanly synced — the shell
		// stays hibernated with no IDB open and no connection. Wake triggers
		// (lock acquisition, remote traffic, disk change) materialize it.
		const managedMeta = this.mergeManager?.getManagedMeta(guid);
		if (
			!canvas.isMaterialized &&
			managedMeta?.lcaMeta &&
			managedMeta.disk &&
			canvas.tfile?.stat.mtime === managedMeta.disk.mtime &&
			!this.pendingUpload.get(canvas.path)
		) {
			this.files.set(guid, canvas);
			this.fset.add(canvas);
			return canvas;
		}

		void trackPromise(`folder:canvasReady:${canvas.guid}`, this.whenReady())
			.then(async () => {
				const synced = await canvas.getServerSynced();
				if (canvas.stat.size === 0 && !synced) {
					this.backgroundSync.enqueueDownload(canvas);
				} else if (this.pendingUpload.get(canvas.path)) {
					await this.applyPendingUpload(canvas.path).promise;
				}
			})
			.catch((error) => {
				if (this.destroyed || canvas.destroyed) return;
				this.error("canvas ready failed", error);
			});

		this.files.set(guid, canvas);
		this.fset.add(canvas);
		return canvas;
	}

	/**
	 * Read-only accessor for debug and CDP consumers: resolve a
	 * folder-relative path through membership to its loaded Document.
	 * Returns undefined when the path has no membership entry, the entry
	 * is not loaded, or it is not a document. Never creates, uploads, or
	 * moves — safe to call with a path in any state.
	 */
	public viewDoc(vpath: string): Document | undefined {
		const guid = this.syncStore.get(vpath);
		if (!guid) return;
		const doc = this.files.get(guid);
		if (!isDocument(doc)) return;
		return doc;
	}

	/**
	 * Read-only accessor for debug and CDP consumers: resolve a
	 * folder-relative path through membership to its loaded Canvas.
	 * Returns undefined when the path has no membership entry, the entry
	 * is not loaded, or it is not a canvas. Never creates, uploads, or
	 * moves.
	 */
	public viewCanvas(vpath: string): Canvas | undefined {
		const guid = this.syncStore.get(vpath);
		if (!guid) return;
		const canvas = this.files.get(guid);
		if (!isCanvas(canvas)) return;
		return canvas;
	}

	/**
	 * Read-only accessor for debug and CDP consumers: the loaded file for
	 * a membership guid. Guids are stable across renames, so a script can
	 * resolve a path once and follow the file through moves by guid.
	 * Returns undefined when the file is not loaded. Never creates.
	 */
	public viewFileByGuid(guid: string): IFile | undefined {
		return this.files.get(guid);
	}

	public viewSyncFile(tfile: TFile): SyncFile | undefined {
		const vpath = this.getVirtualPath(tfile.path);
		const guid = this.syncStore.get(vpath);
		if (!guid) return;
		const file = this.files.get(guid);

		if (!file) {
			// File exists in sync store but not loaded yet
			this.debug(
				`viewSyncFile(): file not loaded yet, guid=${guid}, vpath=${vpath}`,
			);
			return undefined;
		}

		if (!isSyncFile(file)) {
			// File exists but is not a SyncFile (could be Canvas, Document, etc.)
			// This can happen when file types change due to feature flags or server metadata
			this.debug(
				`viewSyncFile(): file exists but is not SyncFile, guid=${guid}, vpath=${vpath}, actual type=${file.constructor.name}`,
			);
			return undefined;
		}
		return file;
	}

	getOrCreateDoc(guid: string, vpath: string): Document {
		const existing = this.files.get(guid) || this.fset.find((file) => file.guid === guid);
		const doc =
			existing ||
			new Document(vpath, guid, this.loginManager, this);
		if (!isDocument(doc)) {
			throw new Error("unexpected ifile type");
		}
		this.files.set(guid, doc);
		doc.move(vpath, this);

		if (this._localOnly && doc.hsm) {
			doc.hsm.setLocalOnly(true);
		}

		return doc;
	}

	async downloadDoc(vpath: string): Promise<Document | undefined> {
		const pending = this._pendingDownloadPromises.get(vpath);
		if (pending) return pending;

		const promise = this.downloadDocOnce(vpath);
		this._pendingDownloadPromises.set(vpath, promise);
		this._pendingDownloads.add(vpath);
		try {
			return await promise;
		} finally {
			this._pendingDownloadPromises.delete(vpath);
			this._pendingDownloads.delete(vpath);
		}
	}

	private async downloadDocOnce(vpath: string): Promise<Document | undefined> {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error(`called download on item that is not in ids ${vpath}`);
		}
		if (this.serverEmptyTerminal(guid)) {
			this.debug(
				`[${vpath}] download skipped: server has no content for guid; awaiting server evidence`,
			);
			return undefined;
		}

		// A download for this path is now under way by whatever route, so any
		// earlier wait on the document's machine is discharged. If this attempt
		// is stood down again it records a fresh one against the live machine.
		this.discardDownloadDeferredByState(vpath);

		// A remap already owns this path: stand aside before paying for the
		// fetch, not after.
		if (!this.downloadMayProceed(undefined, vpath, "before fetching")) {
			return undefined;
		}

		const updateBytes = await this.backgroundSync.downloadByGuid(this, guid, vpath);

		if (!updateBytes) {
			this.recordServerEmpty(guid);
			this.log(`[${vpath}] download deferred: server has guid but no content yet`);
			return undefined;
		}

		if (!this.downloadMayProceed(undefined, vpath, "after fetching")) {
			return undefined;
		}

		const tempDoc = new Y.Doc();
		Y.applyUpdate(tempDoc, updateBytes);
		const contents = tempDoc.getText("contents").toString();
		const doc = this.getOrCreateDoc(guid, vpath);

		// The commit half below enrolls the server's content and writes it
		// over the file. Every step of it is separated from the last check by
		// at least one await — persistence, a machine transition, a hash — and
		// a competing reconciliation can settle this identity inside any of
		// those gaps. So the question is asked again immediately before each
		// step that cannot be taken back, from live state rather than from
		// something sampled earlier.
		if (!this.downloadMayProceed(doc, vpath, "before enrolling")) {
			return undefined;
		}
		await doc.hsm?.initializeFromRemote(updateBytes);
		const remoteDoc = doc.ensureRemoteDoc();
		doc.hsm?.setRemoteDoc(remoteDoc);
		await doc.hsm?.awaitIdle();

		if (!this.downloadMayProceed(doc, vpath, "before completing enrollment")) {
			return undefined;
		}
		await doc.hsm?.completeInitialEnrollmentFromRemote(contents);

		if (!this.syncStore.has(doc.path)) {
			throw new Error("file no longer wanted");
		}

		if (!this.downloadMayProceed(doc, vpath, "before writing")) {
			return undefined;
		}

		this.files.set(guid, doc);
		const wrote = await this.flush(doc, contents);
		if (!wrote) {
			// The write is the one refusal downstream of the decision to call
			// the download done, and it is the only one the download cannot
			// see unless it asks. Dropping it silently registers the document
			// as a file of the folder while the file itself was never created
			// — a note receiving live edits that exists nowhere on disk, with
			// nothing scheduled to bring it. That is the same loss this whole
			// path is here to prevent, arrived at from the other side.
			//
			// So a refused write stands the download down exactly like the
			// checks above it: recorded against the document's own machine,
			// re-driven when the document would take a copy again, and not
			// reported to the caller as a download that happened.
			this.warn(
				`[${vpath}] download deferred at the write: the document is not in a state ` +
					`that accepts a remote copy (${doc.hsm?.state.statePath ?? "no machine"})`,
			);
			this.deferDownloadUntilDocumentAccepts(doc, vpath);
			return undefined;
		}
		this.fset.add(doc);

		return doc;
	}

	/**
	 * Whether a download may take its next irreversible step for a path. Two
	 * independent reasons to stand down, both read live and both decided from
	 * identity and machine state — never from document content:
	 *
	 * - a reconciliation holds the path, so it owns this identity's outcome;
	 * - the document is not in a state that accepts the server's copy as its
	 *   starting point, so enrolling it and writing it over the file would
	 *   discard whatever the document is carrying.
	 *
	 * The second reason stands on its own: a document carrying its own work
	 * must not be overwritten even when no reconciliation is in flight to
	 * announce it. It is asked of the live machine at every step, because the
	 * answer can change inside any of the awaits between them.
	 */
	private downloadMayProceed(
		doc: Document | undefined,
		vpath: string,
		stage: string,
	): boolean {
		if (this._pendingRemaps.has(vpath)) {
			// Recorded so the remap re-drives this download when it releases
			// the path — the download sweep is not available by default.
			this._downloadsDeferredByRemap.add(vpath);
			this.log(
				`[${vpath}] download deferred ${stage}: a remap is resolving this identity`,
			);
			return false;
		}
		// Fail-closed: a document with no machine cannot say what it is
		// carrying, so it does not get enrolled or written over.
		if (doc && !doc.hsm?.acceptsRemoteEnrollment) {
			// Loud, because a document that goes on refusing is otherwise only
			// visible as a file that never appears.
			this.warn(
				`[${vpath}] download deferred ${stage}: the document is not in a state ` +
					`that accepts a remote copy (${doc.hsm?.state.statePath ?? "no machine"})`,
			);
			this.deferDownloadUntilDocumentAccepts(doc, vpath);
			return false;
		}
		return true;
	}

	/**
	 * Record a download the document stood down, and watch for the answer to
	 * change.
	 *
	 * The reconciliation branch above hands its deferrals to the
	 * reconciliation that displaced them. This branch has nothing equivalent:
	 * the refusal comes from the document itself, so the document is what has
	 * to discharge it. The document machine notifies on every event it handles,
	 * which is exactly when its answer can change, so the re-drive is driven by
	 * the document's own state rather than by a timer.
	 */
	private deferDownloadUntilDocumentAccepts(
		doc: Document,
		vpath: string,
	): void {
		if (this.destroyed) return;
		const hsm = doc.hsm;
		if (!hsm || hsm.state.statePath === "destroyed") {
			// A torn-down machine never answers again, so there is nothing to
			// wait on here. Whatever tore the document down owns this identity
			// now, and the next tree sync re-detects the path if nothing else
			// does.
			this.warn(
				`[${vpath}] download has no machine left to wait on: the ` +
					`document was torn down while the download was in flight`,
			);
			return;
		}

		// Every route here runs after a download attempt for this path has
		// already discharged whatever was waiting on it, so in practice there
		// is nothing to replace. Replace it anyway rather than write over it:
		// two watchers on one path would both re-drive, and the older one
		// holds a machine that may already be gone.
		this.discardDownloadDeferredByState(vpath);

		const guid = doc.guid;
		const unsubscribe = hsm.stateChanges.subscribe((state) => {
			if (state.statePath === "destroyed") {
				// The machine has reached the end of its life and its listeners
				// are about to be dropped, so this record would sit here
				// holding a handle that can never fire again and keeping the
				// dead machine alive with it. The wait is over; let it go.
				this.discardDownloadDeferredByState(vpath);
				return;
			}
			if (!hsm.acceptsRemoteEnrollment) return;
			// The notification lands at the end of the machine's own handling
			// of an event, and the sync bridge can emit one from further in
			// still — from inside a document transaction. Either way the stack
			// that produced it is not finished. Re-drive on a fresh microtask
			// so that stack unwinds first and the download never re-enters the
			// machine from inside its own work.
			void Promise.resolve().then(() => {
				this.resumeDownloadDeferredByState(vpath);
			});
		});
		this._downloadsDeferredByState.set(vpath, { guid, hsm, unsubscribe });
	}

	/**
	 * Re-drive a download the document stood down, now that the document says
	 * it would take a remote copy. The record is consumed first so the
	 * re-driven download cannot observe the deferral it is discharging; if it
	 * is refused again it records a fresh one.
	 */
	private resumeDownloadDeferredByState(path: string): void {
		const record = this._downloadsDeferredByState.get(path);
		if (!record) return;
		// The answer can go back to no between the notification and here — a
		// disk event landing in the same turn, for instance. Keep waiting
		// rather than paying for a fetch that will be refused on arrival.
		if (!record.hsm.acceptsRemoteEnrollment) return;

		this._downloadsDeferredByState.delete(path);
		record.unsubscribe();
		if (this.destroyed) return;
		// The document is loaded by construction — it is the one that refused —
		// so the "already loaded, nothing to download" stand-down would drop
		// this every time. What actually needs restoring is the file, so that
		// is what the resume asks about.
		const fileMissing = !this.existsSync(path);
		const restarted = this.startDeferredDownloadForGuid(record.guid, {
			evenIfDocumentLoaded: fileMissing,
		});
		// Say what happened rather than what was attempted. The record is
		// consumed either way, so a line claiming a resume that did not
		// restart anything is the only trace left of a download that quietly
		// ended here.
		if (restarted) {
			this.log(`[${path}] resuming the download the document stood down`);
		} else if (!fileMissing) {
			this.log(
				`[${path}] the download the document stood down is moot: the file is here`,
			);
		} else {
			this.warn(
				`[${path}] the download the document stood down did not restart, ` +
					`and the file is still missing`,
			);
		}
	}

	/** Drop the wait on one path, without re-driving anything. */
	private discardDownloadDeferredByState(path: string): void {
		const record = this._downloadsDeferredByState.get(path);
		if (!record) return;
		this._downloadsDeferredByState.delete(path);
		record.unsubscribe();
	}

	/** Drop every outstanding wait on a document's machine. */
	private clearDownloadsDeferredByState(): void {
		this._downloadsDeferredByState.forEach((record) => record.unsubscribe());
		this._downloadsDeferredByState.clear();
	}

	uploadDoc(vpath: string): Document {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid: string | undefined = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("missing guid");
		}
		const doc = this.getOrCreateDoc(guid, vpath);

		(async () => {
			const exists = await this.exists(doc);
			// Re-check where the dispatch resumes, above the existence
			// failure: a folder is usually torn down because its file went
			// away, so after teardown `exists` is false as a matter of
			// course — and this function is detached with no rejection
			// handler, so the throw below escapes the process as an
			// unhandled rejection rather than reaching a log.
			if (this.destroyed) return;
			if (!exists) {
				throw new Error(`Upload failed, doc does not exist at ${vpath}`);
			}
			// The publication run parks until the machine permits publishing
			// and enrolls the document's content just before its upload.
			if (this.pendingUpload.has(vpath)) {
				await this.applyPendingUpload(vpath).promise;
			}
		})();

		this.files.set(guid, doc);
		this.fset.add(doc);
		return doc;
	}

	createDoc(vpath: string): Document {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const doc = this.getOrCreateDoc(guid, vpath);

		void trackPromise(`folder:docReady:${doc.guid}`, this.whenReady())
			.then(async () => {
				const synced = await doc.getServerSynced();
				if (doc.tfile?.stat.size === 0 && !synced) {
					this.backgroundSync.enqueueDownload(doc, false);
				} else if (this.pendingUpload.get(doc.path)) {
					await this.applyPendingUpload(doc.path).promise;
				}
			})
			.catch((error) => {
				if (this.destroyed || doc.destroyed) return;
				this.error("document ready failed", error);
			});

		this.files.set(guid, doc);
		this.fset.add(doc);

		return doc;
	}

	private getOrCreateSyncFolder(guid: string, vpath: string) {
		const file = this.files.get(guid) || new SyncFolder(vpath, guid, this);
		if (!isSyncFolder(file)) {
			throw new Error("unexpected ifile type");
		}
		file.move(vpath, this);
		return file;
	}

	private getSyncFolder(vpath: string) {
		this.log("[getSyncFolder]", `getting syncfolder`);
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const file = this.getOrCreateSyncFolder(guid, vpath);

		this.files.set(guid, file);
		this.fset.add(file);
		return file;
	}

	getOrCreateSyncFile(
		guid: string,
		vpath: string,
		hashOrTFile: TFile | string,
	): SyncFile {
		const file =
			this.files.get(guid) || new SyncFile(vpath, guid, this.hashStore, this);
		if (!isSyncFile(file)) {
			throw new Error(
				`getOrCreateSyncFile(): unexpected ifile type, guid=${guid}`,
			);
		}
		file.move(vpath, this);
		this.files.set(guid, file);
		return file;
	}

	syncFile(vpath: string) {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error(`called sync on item that is not in ids ${vpath}`);
		}
		const meta = this.syncStore.getMeta(vpath);
		if (!meta || !meta.hash) {
			return this.uploadSyncFile(vpath);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, meta.hash);

		this.backgroundSync.enqueueSync(file).catch((error) => {
			this.warn(`sync failed for ${vpath}`, error);
		});

		this.files.set(guid, file);
		this.fset.add(file);

		return file;
	}

	downloadSyncFile(vpath: string) {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error(`called download on item that is not in ids ${vpath}`);
		}
		const meta = this.syncStore.getMeta(vpath);
		if (!meta || !meta.hash) {
			return this.uploadSyncFile(vpath);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, meta.hash);

		this.backgroundSync.enqueueDownload(file, false).catch((error) => {
			this.warn(`initial download failed for ${vpath}`, error);
		});

		this.files.set(guid, file);
		this.fset.add(file);

		return file;
	}

	uploadSyncFile(vpath: string): SyncFile {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid: string | undefined = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("missing guid");
		}
		const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
		if (!tfile) {
			throw new Error(`Upload failed, file does not exist at ${vpath}`);
		}
		if (!(tfile instanceof TFile)) {
			throw new Error(`Upload failed, expected file at ${vpath}`);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, tfile);

		void (async () => {
			if (!this.pendingUpload.get(file.path)) return;
			await this.applyPendingUpload(file.path).promise;
		})();

		this.fset.add(file);
		return file;
	}

	private getSyncFile(vpath: string): SyncFile {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid: string | undefined = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("missing guid");
		}
		const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
		if (!tfile) {
			throw new Error(`Upload failed, file does not exist at ${vpath}`);
		}
		if (!(tfile instanceof TFile)) {
			throw new Error(`Upload failed, expected file at ${vpath}`);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, tfile);

		const meta = this.syncStore.getMeta(vpath);
		if (!meta) {
			this.log("get syncfile missing meta");
			void (async () => {
				if (!this.pendingUpload.get(file.path)) return;
				await this.applyPendingUpload(file.path).promise;
			})();
		} else {
			this.log("get syncfile initial pull", {
				path: vpath,
				guid,
				metaHash: meta.hash,
				metaSynctime: meta.synctime,
			});
			// The queue retries transient failures and records terminal ones
			// for the periodic reclaim pass; a bare pull() would spend its one
			// attempt and strand the file if the server blipped.
			this.backgroundSync.enqueueDownload(file, false).catch((error) => {
				this.warn(`initial pull failed for ${vpath}`, error);
			});
		}

		this.files.set(guid, file);
		this.fset.add(file);
		return file;
	}

	uploadFile(tfile: TAbstractFile): IFile | null {
		const vpath = this.getVirtualPath(tfile.path);
		if (!this.isSyncableTFile(tfile)) {
			this.log("skipping upload for unsyncable file", vpath);
			return null;
		}
		if (tfile instanceof TFolder) {
			return this.getSyncFolder(vpath);
		} else if (tfile instanceof TFile) {
			if (Document.checkExtension(vpath)) {
				return this.uploadDoc(vpath);
			}
			if (
				Canvas.checkExtension(vpath) &&
				this.syncSettingsManager.isExtensionEnabled(vpath)
			) {
				return this.uploadCanvas(vpath);
			}
			if (this.syncStore.canSync(vpath)) {
				return this.uploadSyncFile(vpath);
			}
		}
		throw new Error("unexpectedly unable to upload");
	}

	markPendingDelete(vpath: string) {
		this.pendingDeletes.set(vpath, this.timeProvider.now());
		this.log("marked pending delete", vpath);
	}

	clearPendingDelete(vpath: string) {
		this.pendingDeletes.delete(vpath);
		this.log("cleared pending delete", vpath);
	}

	isPendingDelete(vpath: string): boolean {
		const markedAt = this.pendingDeletes.get(vpath);
		if (markedAt === undefined) return false;
		if (this.timeProvider.now() - markedAt > PENDING_DELETE_TTL_MS) {
			this.pendingDeletes.delete(vpath);
			return false;
		}
		return true;
	}

	/**
	 * Check-and-consume a suppression token: the vault-delete echo it
	 * suppresses has arrived, so the token's work is done.
	 */
	consumePendingDelete(vpath: string): boolean {
		if (!this.isPendingDelete(vpath)) return false;
		this.pendingDeletes.delete(vpath);
		return true;
	}

	isPendingUpload(vpath: string): boolean {
		return this.pendingUpload.has(vpath);
	}

	expandDeletePaths(
		vpaths: Iterable<string>,
		folderRoots: Iterable<string> = [],
	): string[] {
		const paths = new Set(vpaths);
		const roots = Array.from(new Set(folderRoots));
		for (const root of roots) {
			paths.add(root);
		}
		if (roots.length === 0) {
			return Array.from(paths).sort();
		}

		const isUnderDeletedFolder = (path: string): boolean => {
			return roots.some((root) => path === root || path.startsWith(root + sep));
		};
		this.syncStore.forEach((_meta, path) => {
			if (isUnderDeletedFolder(path)) {
				paths.add(path);
			}
		});
		this.fset.forEach((file) => {
			if (isUnderDeletedFolder(file.path)) {
				paths.add(file.path);
			}
		});
		return Array.from(paths).sort();
	}

	deleteFile(vpath: string) {
		this.deleteFiles([vpath]);
	}

	deleteFiles(vpaths: Iterable<string>) {
		const paths = Array.from(new Set(vpaths));
		if (paths.length === 0) {
			return;
		}
		if (!this.canManageFiles) {
			const readerOwnedPaths = paths.filter(
				(vpath) => !!this.syncStore.getMeta(vpath) || this.pendingUpload.has(vpath),
			);
			if (readerOwnedPaths.length === 0) {
				// A local-only path has no shared membership to protect.
				return;
			}
			this.rejectReaderFolderChange(readerOwnedPaths);
			for (const vpath of readerOwnedPaths) {
				const meta = this.syncStore.getMeta(vpath);
				if (!meta || this.existsSync(vpath)) continue;
				trackPromise(
					`restoreReaderDelete:${this.guid}:${vpath}`,
					this._handleServerCreate(vpath, meta).then(() => undefined),
				);
			}
			return;
		}
		const cleanupGuids = new Map<string, string>();
		this.folderDoc.transact(() => {
			for (const vpath of paths) {
				const guid = this.syncStore?.get(vpath);
				const move = this.serverOps.moveFrom(vpath);
				if (
					move &&
					(guid === move.guid || (!guid && !this.pendingUpload.has(vpath)))
				) {
					// The delete echo for the vacated disk path, not a deletion
					// of the identity whose membership lives at `to`.
					const moved = this.files.get(move.guid);
					if (moved && moved.path === move.from) {
						moved.move(move.to, this);
					}
					continue;
				}
				this.pendingUpload.delete(vpath);
				if (guid) {
					this.syncStore.delete(vpath);
					const doc = this.files.get(guid);
					if (doc) {
						this.fset.delete(doc);
						this.files.delete(guid);
						doc.cleanup();
						doc.destroy();
					}
					cleanupGuids.set(guid, vpath);
				} else {
					// syncStore entry already gone (remote delete) - find by path
					const doc = this.fset.find((f) => f.path === vpath);
					if (doc) {
						const docGuid = doc.guid;
						this.fset.delete(doc);
						this.files.delete(docGuid);
						doc.cleanup();
						doc.destroy();
						cleanupGuids.set(docGuid, vpath);
					}
				}
			}
		}, this);

		for (const guid of cleanupGuids.keys()) {
			this.teardownDocState(guid);
		}
	}

	private teardownDocState(guid: string): void {
		indexedDB.deleteDatabase(`${this.appId}-relay-doc-${guid}`);
		// Canvases persist under their own prefix; deleting the unused name
		// for either file type is a no-op.
		indexedDB.deleteDatabase(`${this.appId}-relay-canvas-${guid}`);
		const p = this._hsmStore.deleteState(guid).catch(() => {});
		trackAsyncCleanup(p);
	}

	renameFile(tfile: TAbstractFile, oldPath: string) {
		if (this.consumeReaderRestoreRenameEcho(tfile, oldPath)) return;
		const newPath = tfile.path;
		let newVPath = "";
		let oldVPath = "";
		try {
			newVPath = this.getVirtualPath(newPath);
		} catch {
			this.log("Moving out of shared folder");
		}
		try {
			oldVPath = this.getVirtualPath(oldPath);
		} catch {
			this.log("Moving in from outside of shared folder");
		}

		if (!newVPath && !oldVPath) {
			// not related to shared folders
			return;
		}
		const oldTracked = oldVPath ? this.syncStore.has(oldVPath) : false;
		const newTracked = newVPath ? this.syncStore.has(newVPath) : false;
		const hasPendingClaim =
			(oldVPath ? this.pendingUpload.has(oldVPath) : false) ||
			(newVPath ? this.pendingUpload.has(newVPath) : false);
		if (!this.canManageFiles && !oldTracked && !newTracked && !hasPendingClaim) {
			return;
		}
		if (this.rejectReaderFolderChange([oldVPath, newVPath].filter(Boolean))) {
			const guid = oldVPath ? this.syncStore.get(oldVPath) : undefined;
			const sharedFile = guid ? this.files.get(guid) : undefined;
			const restore = sharedFile && oldVPath && newVPath
				? this._handleServerRename(sharedFile, oldVPath, tfile)
				: this.restoreUntrackedReaderRename(tfile, oldPath);
			trackPromise(`restoreReaderRename:${this.guid}:${oldVPath}`, restore);
			return;
		} else if (!oldVPath) {
			// if this was moved from outside the shared folder context, we need to create a live doc
			this.assertPath(newPath);
			if (!this.isSyncableTFile(tfile)) return;
			this.placeHold([tfile]);
			this.uploadFile(tfile);
		} else {
			const move = this.serverOps.moveFrom(oldVPath);
			if (move && !this.syncStore.has(oldVPath)) {
				if (newVPath && move.to === newVPath) {
					this.consumeMoveEcho(oldVPath, newVPath);
				} else {
					// A different rename belongs to a recreated source
					// occupant. It cannot move or destroy the guid already
					// living at `to`.
					this.observeMoveSourceRecreation(oldVPath);
				}
				return;
			}
			// live doc exists
			const guid = this.syncStore.get(oldVPath);
			if (!guid) return;
			const file = this.files.get(guid);
			if (!newVPath) {
				// moving out of shared folder.. destroy the live doc.
				this.folderDoc.transact(() => {
					this.syncStore.delete(oldVPath);
				}, this);
				if (file) {
					file.cleanup();
					file.destroy();
					this.fset.delete(file);
				}
				this.files.delete(guid);
			} else {
				// moving within shared folder.. move the live doc.
				const guid = this.syncStore.get(oldVPath);
				if (!guid) {
					return;
				}
				const toMove: [string, string, string][] = [];
				if (file instanceof SyncFolder) {
					this.syncStore.forEach((meta, path) => {
						if (path.startsWith(oldVPath + sep)) {
							const destination = path.replace(oldVPath, newVPath);
							toMove.push([meta.id, path, destination]);
						}
					});
				}
				this.folderDoc.transact(() => {
					this.syncStore.move(oldVPath, newVPath);
					if (file) {
						file.move(newVPath, this);
					}
					toMove.forEach((move) => {
						const [guid, oldVPath, newVPath] = move;
						this.syncStore.move(oldVPath, newVPath);
						const subdoc = this.files.get(guid);
						if (subdoc) {
							// it is critical that this happens within the transaction
							subdoc.move(newVPath, this);
						}
					});
				}, this);
			}
		}
	}

	onDestroy(cb: () => void): void {
		if (this.destroyed) {
			try { cb(); } catch { /* caller's problem */ }
			return;
		}
		this.unsubscribes.push(cb);
	}

	destroy() {
		const destroyedError = new DestroyedError(
			"SharedFolder",
			`${this.path} (${this.guid})`,
		);
		this.destroyed = true;
		// Close the machine: parked connect() callers resolve false and
		// parked publications resume, re-check `destroyed`, and bail instead
		// of pending forever.
		this.folderMachine.close();
		this.pendingCreates.forEach((timer) => this.timeProvider.clearTimeout(timer));
		this.pendingCreates.clear();
		this.clearDownloadsDeferredByState();
		if (this._readerEditOverwriteTimer !== null) {
			this.timeProvider.clearTimeout(this._readerEditOverwriteTimer);
			this._readerEditOverwriteTimer = null;
		}
		this._readerEditOverwrites = [];
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.unsubscribes = [];
		this.whenSyncedPromise?.destroy(destroyedError);
		this.whenSyncedPromise = null as any;
		this.readyPromise?.destroy(destroyedError);
		this.readyPromise = null as any;
		this.syncFileTreePromise?.destroy(destroyedError);
		this.syncFileTreePromise = null as any;

		// Mark the merge manager as shutting down before destroying docs so
		// per-doc unloads don't schedule hibernate timers we'd just orphan.
		this.mergeManager?.beginShutdown();

		this.files.forEach((doc: IFile) => {
			doc.destroy();
			this.files.delete(doc.guid);
		});

		this.recordingBridge?.dispose();
		this.cas.destroy();
		this.syncStore.destroy();
		this.syncSettingsManager.destroy();
		this.mergeManager?.destroy();
		// IndexeddbPersistence self-destructs on the ydoc's 'destroy' event,
		// but its async teardown promise (awaiting pending writes and
		// compaction before closing the DB) is dropped inside that event
		// handler. Capture it here so failures are logged. Calling destroy()
		// removes the 'destroy'
		// listener synchronously, so super.destroy() below won't double-fire.
		if (this._persistence) {
			const p = this._persistence.destroy().catch(() => {});
			trackAsyncCleanup(p);
		}
		super.destroy();
		this.fset.destroy();
		this._settings.destroy();
		this._settings = null as any;
		this.proxy = null as any;
		this.relayManager = null as any;
		this.backgroundSync = null as any;
		this.loginManager = null as any;
		this.tokenStore = null as any;
		this.fileManager = null as any;
		this.cas = null as any;
		this.syncStore = null as any;
		this.syncSettingsManager = null as any;
		this.mergeManager = null as any;
		this.fset = null as any;

	}
}

export class SharedFolders extends ObservableSet<SharedFolder> {
	private folderBuilder: (
		path: string,
		guid: string,
		relayId?: string,
		authoritative?: boolean,
		remote?: RemoteSharedFolder,
	) => SharedFolder;
	private _offRemoteUpdates?: () => void;

	constructor(
		private relayManager: RelayManager,
		private vault: Vault,
		folderBuilder: (
			path: string,
			guid: string,
			relayId?: string,
			authoritative?: boolean,
			remote?: RemoteSharedFolder,
		) => SharedFolder,
		private settings: NamespacedSettings<SharedFolderSettings[]>,
		private _hsmStore: HSMStore,
		private hashStore: ContentAddressedFileStore,
		private timeProvider: TimeProvider,
		private appId: string = "app",
	) {
		super();
		this.folderBuilder = folderBuilder;

		if (!this._offRemoteUpdates) {
			this._offRemoteUpdates = this.relayManager.remoteFolders.subscribe(
				(remotes) => {
					let updated = false;
					this.items().forEach((folder) => {
						const remote = remotes.find((remote) => remote.guid == folder.guid);
						if (folder.remote != remote) {
							updated = true;
						}
						folder.remote = remote;
					});
					if (updated) {
						this.update();
					}
				},
			);
		}
	}

	public delete(item: SharedFolder): boolean {
		// Collect IDB database names before destroy nulls references
		const dbNames: string[] = [];
		const docGuids: string[] = [];
		if (item) {
			item.files.forEach((file: IFile) => {
				// Databases are named by file type; attachments have no
				// per-file database (their rows live in the hash store,
				// reclaimed below).
				if (isCanvas(file)) {
					dbNames.push(`${item.appId}-relay-canvas-${file.guid}`);
				} else if (isDocument(file)) {
					dbNames.push(`${item.appId}-relay-doc-${file.guid}`);
				}
				docGuids.push(file.guid);
			});
			// Folder-level databases: the raw-guid database and the split-era
			// local and remote folder databases.
			dbNames.push(item.guid);
			dbNames.push(`${item.appId}-relay-folder-${item.guid}`);
			dbNames.push(`${item.appId}-relay-folder-${item.guid}-remote`);
			// The folder's pending-upload records live in localStorage, not
			// IDB; removal is the only point where they become garbage.
			item.clearPendingUploads();
			// Folder-scoped HSM states and in-folder hash rows, including
			// records for files outside the current in-memory enumeration.
			void item.reclaimOwnedRecords();
		}
		item?.destroy();
		const deleted = super.delete(item);
		void this.settings.update((current) => {
			return current.filter((settings) => settings.guid !== item.guid);
		}).catch((error) => {
			if (this.destroyed) return;
			const message = error instanceof Error ? error.message : String(error);
			this.warn(`Failed to persist shared folder removal for ${item.path}: ${message}`);
		});
		// Delete IDB databases after in-memory objects are destroyed
		for (const name of dbNames) {
			indexedDB.deleteDatabase(name);
		}
		// Purge merge-HSM states so orphaned records cannot masquerade as
		// local-record evidence for a future folder sharing these vpaths.
		for (const guid of docGuids) {
			void this._hsmStore.deleteState(guid).catch(() => {});
		}
		return deleted;
	}

	/**
	 * Complete cleanup for a suspension that expired without the folder
	 * returning. No in-memory instance exists, so children are enumerated
	 * from the folder doc read out of IDB before the databases are dropped.
	 */
	private async reclaimExpiredFolder(
		guid: string,
		folderPath: string,
	): Promise<void> {
		const childGuids = new Set<string>();
		const childDbNames = new Set<string>();
		// The split-era database holds the authoritative maps; the raw-guid
		// database carries the same maps for folders predating the split.
		for (const dbName of [`${this.appId}-relay-folder-${guid}`, guid]) {
			const ydoc = new Y.Doc();
			const persistence = new IndexeddbPersistence(
				dbName,
				ydoc,
				null,
				null,
				this.timeProvider,
			);
			try {
				await persistence.whenSynced;
				ydoc.getMap("filemeta_v0").forEach((value: unknown) => {
					const meta = value as Meta;
					const id = meta?.id;
					if (!id) return;
					childGuids.add(id);
					if (isCanvasMeta(meta)) {
						childDbNames.add(`${this.appId}-relay-canvas-${id}`);
					} else if (isDocumentMeta(meta)) {
						childDbNames.add(`${this.appId}-relay-doc-${id}`);
					}
				});
				ydoc.getMap("docs").forEach((docGuid: unknown) => {
					if (typeof docGuid !== "string") return;
					childGuids.add(docGuid);
					childDbNames.add(`${this.appId}-relay-doc-${docGuid}`);
				});
			} catch (e) {
				// An unreadable folder doc bounds cleanup to the folder-level
				// databases and the path- and folder-keyed records below.
			} finally {
				persistence.destroy();
				ydoc.destroy();
			}
		}
		for (const name of childDbNames) {
			indexedDB.deleteDatabase(name);
		}
		for (const child of childGuids) {
			void this._hsmStore.deleteState(child).catch(() => {});
		}
		try {
			const stateMetas = await this._hsmStore.getAllStateMeta();
			for (const stateMeta of stateMetas) {
				if (stateMeta.folder !== guid) continue;
				void this._hsmStore.deleteState(stateMeta.guid).catch(() => {});
			}
		} catch (e) {
			// App-wide store unavailable; the databases below still fall.
		}
		try {
			const prefix = folderPath.endsWith("/")
				? folderPath
				: `${folderPath}/`;
			const entries = await this.hashStore.getAllEntries();
			for (const entry of entries) {
				if (!entry.path.startsWith(prefix)) continue;
				void this.hashStore.removeHash(entry.path).catch(() => {});
			}
		} catch (e) {
			// Hash store unavailable; the databases below still fall.
		}
		indexedDB.deleteDatabase(`${this.appId}-relay-folder-${guid}`);
		indexedDB.deleteDatabase(`${this.appId}-relay-folder-${guid}-remote`);
		indexedDB.deleteDatabase(guid);
	}

	/**
	 * Suspend a folder whose local copy left the vault (root deletion
	 * classified as detach): tear down the in-memory instance but keep the
	 * settings registration and every local database, so the folder relinks
	 * if it returns. Suspended registrations expire on load after the
	 * deletion retention window.
	 */
	public suspend(item: SharedFolder): boolean {
		item.destroy();
		const deleted = super.delete(item);
		void this.settings
			.update((current) =>
				current.map((settings) =>
					settings.guid === item.guid
						? { ...settings, suspended: true, suspendedAt: Date.now() }
						: settings,
				),
			)
			.catch((error) => {
				if (this.destroyed) return;
				const message =
					error instanceof Error ? error.message : String(error);
				this.warn(
					`Failed to persist shared folder suspension for ${item.path}: ${message}`,
				);
			});
		return deleted;
	}

	update: Debouncer<[], void> = debounce(() => this.notifyListeners(), 100);

	public get manager(): RelayManager {
		return this.relayManager;
	}

	lookup(path: string): SharedFolder | null {
		// Return the shared folder that contains the file -- agnostic of whether the file actually exists
		const folder = this.find((sharedFolder: SharedFolder) => {
			return sharedFolder.checkPath(path);
		});
		if (!folder) {
			return null;
		}
		return folder;
	}

	destroy() {
		this.update.cancel();
		this.items().forEach((folder) => {
			folder.destroy();
		});
		this._set.clear();
		if (this._offRemoteUpdates) {
			this._offRemoteUpdates();
			this._offRemoteUpdates = undefined;
		}
		super.destroy();
		this.relayManager = null as any;
		this.folderBuilder = null as any;
		this.settings = null as any;
		this._hsmStore = null as any;
	}

	load() {
		this._load(this.settings.get());
	}

	private _load(folders: SharedFolderSettings[]) {
		let updated = false;
		const expiredSuspensions: { guid: string; path: string }[] = [];
		const relinked: string[] = [];
		folders.forEach((folder: SharedFolderSettings) => {
			// Validate required fields
			if (!folder.path) {
				this.warn(`Invalid settings: folder missing path, skipping`);
				return;
			}
			if (!folder.guid || !S3RN.validateUUID(folder.guid)) {
				this.warn(
					`Invalid settings: folder "${folder.path}" has invalid guid "${folder.guid}", skipping`,
				);
				return;
			}
			const tFolder = this.vault.getFolderByPath(folder.path);
			if (folder.suspended) {
				if (tFolder) {
					// The folder returned to the vault: relink.
					this.log(`Relinking suspended folder ${folder.path}`);
					relinked.push(folder.guid);
				} else if (
					(folder.suspendedAt ?? 0) <
					Date.now() - FOLDER_DELETION_RETENTION_MS
				) {
					// The suspension expired without the folder returning.
					this.log(`Expiring suspended folder ${folder.path}`);
					expiredSuspensions.push({
						guid: folder.guid,
						path: folder.path,
					});
					return;
				} else {
					// Suspended and absent: stay inert, keep the registration.
					return;
				}
			}
			if (!tFolder) {
				this.warn(`Invalid settings, ${folder.path} does not exist`);
				return;
			}
			try {
				this._new(folder.path, folder.guid, folder?.relay);
				updated = true;
			} catch (e) {
				this.warn(
					`Failed to load folder "${folder.path}": ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		});

		if (expiredSuspensions.length > 0 || relinked.length > 0) {
			const expiredGuids = expiredSuspensions.map((s) => s.guid);
			void this.settings
				.update((current) =>
					current
						.filter((s) => !expiredGuids.includes(s.guid))
						.map((s) =>
							relinked.includes(s.guid)
								? { ...s, suspended: undefined, suspendedAt: undefined }
								: s,
						),
				)
				.catch(() => {});
			// An expired suspension gets the same complete cleanup as an
			// explicit removal; the folder never returned, so nothing is
			// left for a re-creation sweep.
			for (const expired of expiredSuspensions) {
				void this.reclaimExpiredFolder(expired.guid, expired.path);
			}
		}

		if (updated) {
			this.notifyListeners();
		}
	}

	private _new(
		path: string,
		guid: string,
		relayId?: string,
		authoritative?: boolean,
		remote?: RemoteSharedFolder,
	): SharedFolder {
		// Validate inputs
		if (!path) {
			throw new Error("Cannot create shared folder: path is required");
		}
		if (!guid || !S3RN.validateUUID(guid)) {
			throw new Error(`Cannot create shared folder: invalid guid "${guid}"`);
		}
		if (relayId && !S3RN.validateUUID(relayId)) {
			throw new Error(
				`Cannot create shared folder: invalid relayId "${relayId}"`,
			);
		}

		const existing = this.find(
			(folder) => folder.path == path && folder.guid == guid,
		);
		if (existing) {
			return existing;
		}
		const sameGuid = this.find((folder) => folder.guid == guid);
		if (sameGuid) {
			throw new Error(`This folder is already mounted at ${sameGuid.path}.`);
		}
		const samePath = this.find((folder) => folder.path == path);
		if (samePath) {
			throw new Error("Conflict: Tracked folder exists at this location.");
		}
		const folder = this.folderBuilder(path, guid, relayId, authoritative, remote);
		this._set.add(folder);
		return folder;
	}

	/** Share a local folder — user is authoritative (source of truth). */
	init(path: string, remote?: RemoteSharedFolder): SharedFolder {
		const guid = remote?.guid ?? uuidv4();
		const folder = this._new(path, guid, remote?.relay.guid, true, remote);
		this.notifyListeners();
		return folder;
	}

	/** Download a remote folder — server is authoritative. */
	clone(path: string, guid: string, relayId?: string): SharedFolder {
		const folder = this._new(path, guid, relayId, false);
		this.notifyListeners();
		return folder;
	}
}
