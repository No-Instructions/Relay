"use strict";
import { uuidv4 } from "lib0/random";
import {
	FileManager,
	type MetadataCache,
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
import { BackgroundSync } from "./BackgroundSync";
import type { NamespacedSettings } from "./SettingsStorage";
import { RelayInstances, metrics } from "./debug";
import { LocalStorage } from "./LocalStorage";
import type { CapturedOp } from "./merge-hsm/undo";
import type { MergeHSM } from "./merge-hsm/MergeHSM";
import { SyncFolder, isSyncFolder } from "./SyncFolder";
import { isDocument } from "./Document";
import { SyncStore, type FolderMapDelta } from "./SyncStore";
import {
	FolderHSM,
	FolderDocBridge,
	DeleteCollector,
	BRIDGE_IN_ORIGIN,
	FOLDER_LOCAL_DELETE_ORIGIN,
	deriveRecoveryDelta,
	isEmptyRecoveryDelta,
	pathWasDeleted,
	type FolderEffect,
	type LocalFileKind,
	type FolderSyncSnapshot,
	type DeletionGateSnapshot,
	type DeleteCollectorOptions,
	type GateResolution,
	type HeldDelete,
	type SerializedCollectorState,
} from "./folder-hsm";
import {
	SyncType,
	makeCanvasMeta,
	makeDocumentMeta,
	makeFileMeta,
	makeFolderMeta,
	isSyncFileMeta,
	isDocumentMeta,
	isCanvasMeta,
	type FileMeta,
	type Meta,
	type SyncFileType,
} from "./SyncTypes";
import type { IFile } from "./IFile";
import { formatDuplicateGuidLog } from "./FileLogDetails";
import { createPathProxy } from "./pathProxy";
import { ContentAddressedStore } from "./CAS";
import { SyncSettingsManager, type SyncFlags } from "./SyncSettings";
import { ContentAddressedFileStore, SyncFile, isSyncFile } from "./SyncFile";
import { Canvas, isCanvas } from "./Canvas";
import { flags } from "./flagManager";
import { MergeManager } from "./merge-hsm/MergeManager";
import {
	E2ERecordingBridge,
	type HSMLogEntry,
} from "./merge-hsm/recording";
import { recordHSMEntry } from "./debug";
import { trackAsyncCleanup } from "./reloadUtils";
import { DestroyedError, isDestroyedError } from "./DestroyedError";
import { readNoteText } from "./diskText";
import {
	HSMStore,
} from "./merge-hsm/persistence";
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

/** Host policy hooks that do not belong in replicated folder settings. */
export interface SharedFolderOptions {
	deleteCollector?: DeleteCollectorOptions;
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

// Empty downloads for a guid become terminal after this many attempts; the
// server pushes a document.updated event (and advertises the guid in the
// subdoc index) once content exists, so polling past this is wasted work.
const MAX_EMPTY_SERVER_ATTEMPTS = 3;

// Captured deletion bursts (history/undo) and the deferred teardown of
// deleted docs' local state expire together after this window.
export const FOLDER_DELETION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

	add(item: IFile, update = true): ObservableSet<IFile> {
		const existing = this.find((file) => file.guid === item.guid);
		if (existing && existing !== item) {
			this.error(formatDuplicateGuidLog(existing, item));
			this._set.delete(existing);
		}
		this._set.add(item);
		if (update) {
			this.notifyListeners();
		}
		return this;
	}
}

export class SharedFolder extends HasProvider {
	path: string;
	files: Map<string, IFile>; // Maps guids to SharedDocs
	fset: Files;
	relayId?: string;
	_remote?: RemoteSharedFolder;
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
	private enabledSyncTypes: Set<SyncType> = new Set();


	private _persistence: IndexeddbPersistence;
	private _downloadSweepTimer: number | null = null;
	/**
	 * Vault-facing folder doc under the folder doc split (flag-on). Inherits
	 * the folder's persistence key, so local history and native tombstones
	 * ride it. Null flag-off: the provider doc is the only folder doc.
	 */
	private _localDoc: Y.Doc | null = null;
	/** Persistence for the provider-facing doc under the split. */
	private _remotePersistence: IndexeddbPersistence | null = null;
	/** Sole conduit between localDoc and the provider doc (flag-on). */
	folderBridge: FolderDocBridge | null = null;
	/** Outbound deletion policy at the bridge (flag-on). */
	deleteCollector: DeleteCollector | null = null;
	/** Deleted docs awaiting expired teardown (split only). */
	private _deferredTeardown: Array<{ guid: string; deletedAt: number }> = [];
	/** Host hook: the collector classified a burst as root detach. */
	onRootDetach: (() => void) | null = null;
	proxy: SharedFolder;
	private revokeProxy: (() => void) | null = null;
	cas: ContentAddressedStore;
	syncSettingsManager: SyncSettingsManager;
	mergeManager: MergeManager;
	private recordingBridge: E2ERecordingBridge;
	private _pendingKeyframeUpdates: Map<string, Uint8Array[]> = new Map();
	private _pendingRemaps: Set<string> = new Set();
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
	/**
	 * Per-folder membership machine. Null when
	 * enableFolderHSM is off; the flag is read once at construction.
	 */
	folderHSM: FolderHSM | null = null;
	/**
	 * Synchronous local-record lookups for the FolderHSM guards: vpath →
	 * guid, assembled from persisted HSM state metadata and guid-bearing
	 * hash-store entries before hydration completes.
	 */
	private _localRecordCache: Map<string, string> = new Map();
	/**
	 * True once the bootstrap discovery pass over the local tree has run —
	 * the boundary the origin discriminator uses to tell interactive vault
	 * creates from startup replays.
	 */
	private _hsmBootstrapScanned = false;
	private readonly remoteActivityIndex = new RemoteActivityIndex();
	private readonly remoteActivitySubscribers = new Set<() => void>();

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
		options: SharedFolderOptions = {},
	) {
		const folderRelayId = remote?.relay.guid ?? relayId;
		const s3rn = folderRelayId
			? new S3RemoteFolder(folderRelayId, guid)
			: new S3Folder(guid);

		super(guid, s3rn, tokenStore, loginManager);
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

		// The folder doc split (flag-on): the vault-facing localDoc carries
		// the map the machine observes and mutates; the provider doc
		// (HasProvider's ydoc) is the replica the server knows. Read once at
		// construction, like the machine itself.
		if (flags().enableFolderHSM) {
			this._localDoc = new Y.Doc({ gc: true });
		}

		this.syncStore = new SyncStore(
			this.folderDoc,
			this.path,
			this.pendingUpload,
			this.syncSettingsManager,
		);
		this.syncStore.on(async () => {
			await this.syncFileTree();
		});

		this.folderHSM = this.maybeConstructFolderHSM();
		if (this.folderHSM) {
			// Remote map deltas (provider-applied transactions) drive
			// membership; our own transactions are direct expressions of
			// effects the machine already accounted for.
			this.syncStore.onMapDelta = (
				delta: FolderMapDelta,
				origin: unknown,
			) => {
				if (
					origin === this ||
					origin === this._persistence ||
					origin === FOLDER_LOCAL_DELETE_ORIGIN
				)
					return;
				this.folderHSM?.send({ type: "MAP_DELTA", ...delta });
			};
		}

		this.unsubscribes.push(
			this.relayManager.remoteFolders.subscribe((folders) => {
				this.remote = folders.find((folder) => folder.guid == this.guid);
			}),
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

		const { proxy, revoke } = createPathProxy(this, this.path, (globalPath: string) => {
			return this.getVirtualPath(globalPath);
		});
		this.proxy = proxy;
		this.revokeProxy = revoke;

		try {
			const folderDbName = `${this.appId}-relay-folder-${this.guid}`;
			const migrateFrom = flags().enableFolderIdbMigration ? this.guid : null;
			// Under the split the existing folder DB stays with the localDoc,
			// preserving local history and native tombstones; the provider doc
			// persists separately and (re)fills from the server.
			this._persistence = new IndexeddbPersistence(
				folderDbName,
				this.folderDoc,
				// Deletion capture rides the localDoc persistence (split only):
				// bridge-applied remote deletions and host-executed local
				// deletions are captured, coalesced per origin, and persisted
				// for history/undo.
				this._localDoc
					? {
							scope: ["filemeta_v0", "docs"],
							scopeType: "map",
							trackedOrigins: new Set<unknown>([
								BRIDGE_IN_ORIGIN,
								FOLDER_LOCAL_DELETE_ORIGIN,
							]),
							captureTimeout: 2000,
						}
					: null,
				migrateFrom,
				this.timeProvider,
			);
			if (this._localDoc) {
				this._remotePersistence = new IndexeddbPersistence(
					`${folderDbName}-remote`,
					this.ydoc,
					null,
					null,
					this.timeProvider,
				);
			}
		} catch (e) {
			this.warn("Unable to open persistence.", this.guid);
			console.error(e);
			throw e;
		}

		if (this._localDoc) {
			this.folderBridge = new FolderDocBridge(this._localDoc, this.ydoc, {
				onOutboundDeletes: (deletes) => this.deleteCollector?.collect(deletes),
				onOutboundSets: (sets) => this.deleteCollector?.dropReasserted(sets),
				isHeld: (mapName, key) =>
					this.deleteCollector?.isHeld(mapName, key) ?? false,
				// A path awaiting first upload is local intent; everything else
				// converges toward server truth. Disk safety is the machine's:
				// remote-wins deletions reach it as evidence-checked map deltas.
				classifyDivergence: (_mapName, key) =>
					this.pendingUpload.has(key) ? "local-wins" : "remote-wins",
				// Persistence replay is not local intent; the remote doc
				// converges through its own persistence and reconcile().
				skipOutboundOrigin: (origin) =>
					origin != null && origin === this._persistence,
				// The remote doc's persisted snapshot can be stale — the
				// localDoc's database also advances while the split is
				// inactive — so its replay must not overwrite the localDoc.
				// reconcile() at provider sync converges the docs.
				skipInboundOrigin: (origin) =>
					origin != null && origin === this._remotePersistence,
				// Publication staged the membership to an empty relay; the
				// per-document rooms there are empty shells until content
				// re-uploads. Stage every registered doc's content.
				onPublication: () => this.stagePublicationUploads(),
			});
			this.deleteCollector = new DeleteCollector(
				this.folderBridge,
				this.timeProvider,
				{
					membershipSize: () => this.syncStore.committedEntryCount(),
					onDetach: (deletes) => this.handleCollectorDetach(deletes),
					onReplicated: () => this.notifyListeners(),
					onGated: (deletes) => {
						this.log(
							`[DeleteCollector] gated ${new Set(deletes.map((deleted) => deleted.key)).size} deletions pending send/restore`,
						);
						this.notifyListeners();
					},
					onRestored: (deletes) => this.handleCollectorRestore(deletes),
					persist: (state) => {
						this.persistCollectorState(state);
						// A gated burst that grows or shrinks (keys absorbed, or
						// keys re-asserted and dropped) reaches the deletion
						// surface through the same listeners the pill uses.
						this.notifyListeners();
					},
				},
				options.deleteCollector,
			);
			// Retention: captured deletion bursts and deferred doc teardown
			// expire together.
			void this.whenSynced()
				.then(() => {
					if (this.destroyed) return;
					this._persistence.opCapture?.dropBefore(
						this.timeProvider.now() - FOLDER_DELETION_RETENTION_MS,
					);
					this.sweepDeferredTeardown();
				})
				.catch(() => {});
			void this._persistence
				.get("deferredDocTeardown")
				.then((raw: unknown) => {
					if (this.destroyed || typeof raw !== "string" || !raw) return;
					try {
						const entries = JSON.parse(raw);
						if (Array.isArray(entries)) {
							this._deferredTeardown.push(...entries);
						}
					} catch (e) {
						this.warn("failed to parse deferred-teardown ledger", e);
					}
				})
				.catch(() => {});
			void this._persistence
				.get("deleteCollector")
				.then((raw: unknown) => {
					if (this.destroyed || typeof raw !== "string" || !raw) return;
					try {
						const state = JSON.parse(raw) as SerializedCollectorState;
						this.deleteCollector?.loadPersisted(state);
						if (this.deleteCollector?.currentPhase === "gated") {
							this.log(
								`[DeleteCollector] rehydrated gated burst of ${state.deletes.length} deletions`,
							);
							this.notifyListeners();
						}
					} catch (e) {
						this.warn("failed to parse persisted delete-collector state", e);
					}
				})
				.catch(() => {});
		}

		// If folder is authoritative (local-only, not awaiting server updates),
		// mark it as server synced so it's considered "ready" even after reload
		if (this.authoritative) {
			this._persistence.markServerSynced();
		}

		if (loginManager.loggedIn) {
			this.connect();
		}

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
					return await this._hsmStore.loadState(guid);
				} catch {
					return null;
				}
			},
			onEffect: async (guid, effect) => {
				if (effect.type === "PERSIST_STATE") {
					// Persisted fork/LCA state writes run in the background; track
					// failures so persistence errors are visible.
					const p = this._hsmStore
						.saveState(guid, effect.state)
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
				// Load persisted HSM metadata before sync startup can create
				// Documents. Document construction immediately creates HSMs,
				// and cold-start needs this cache to decide whether a doc can
				// remain hibernated without opening y-indexeddb.
				await this.mergeManager.initialize();
				if (this.destroyed) return;

				this.syncStore.start();
				// Wait until syncStore is observing the committed file metadata before
				// creating docs from local disk. On reload, addLocalDocs() can otherwise
				// reserve placeholder GUIDs for already-shared files and build HSMs that
				// miss their persisted fork/LCA state.
				//
				// Remote folder metadata can also land before SyncStore observers are
				// installed, so replay both local doc discovery and file-tree sync after
				// start() to avoid missing the first batch of remote entries.
				this.enabledSyncTypes = new Set(
					this.syncStore.typeRegistry.getEnabledFileSyncTypes(),
				);
				if (this.folderHSM) {
					// Assemble the local-record evidence before declaring the
					// folder persistence loaded, so the provenance ladder never
					// runs against an empty record cache.
					await this.assembleLocalRecordCache();
					// A clone's root directory may not exist on disk yet, so
					// local discovery can have nothing to scan — valid evidence
					// (every map entry classifies as a download). The machine
					// must still hear PERSISTENCE_LOADED: without it, it stays
					// in `loading` absorbing every observation forever.
					try {
						this.addLocalDocs();
					} catch (e) {
						this.warn(
							"local doc discovery failed during machine bootstrap",
							e,
						);
					}
					this._hsmBootstrapScanned = true;
					this.folderHSM.send({ type: "PERSISTENCE_LOADED" });
					// Hydration builds on the folder readiness latch: a folder
					// that completed the sync handshake before (hasServerSync)
					// or that is authoritative is hydrated as soon as
					// persistence loads; fresh folders wait for the first
					// provider handshake (handleProviderSynced).
					if (this.ready) {
						this.folderHSM.send({ type: "PROVIDER_SYNCED" });
					}
				} else {
					this.addLocalDocs();
				}
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
			.catch((e) => this.error("folder persistence sync failed", e));

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
			const advertisedGuids: string[] = [];
			const now = this.currentTime();
			for (const [docId, entry] of Object.entries(serverIndex)) {
				const guid = this.guidFromServerDocId(docId) ?? docId;
				advertisedGuids.push(guid);
				// An advertised index entry is server evidence of content;
				// re-allow downloads for guids parked as empty.
				this.clearServerEmpty(guid);
				this.mergeManager?.seedServerAdvertisedHeadFromBytes(
					guid,
					entry,
				);
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
				.then(() => {
					const queuedRemoteHead = this.backgroundSync.enqueueRemoteHeadSyncs(
						this,
						advertisedGuids,
					);
					const queuedLCABackfill = this.backgroundSync.enqueueAdvertisedLCABackfills(
						this,
						advertisedGuids,
					);
					if (queuedRemoteHead > 0) {
						this.debug(`[subdoc-index] queued ${queuedRemoteHead} remote-head syncs`);
					}
					if (queuedLCABackfill > 0) {
						this.debug(`[subdoc-index] queued ${queuedLCABackfill} LCA backfills`);
					}
				})
				.catch((e) => this.error("subdoc index sync sweep failed", e));
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
			this.retryDeferredDownloadForGuid(guid);
			this.retryDeferredRemapForGuid(guid);
			return;
		}

		const file = this.files.get(guid);
		if (!file || !isDocument(file)) return;

		// Active documents: ProviderIntegration handles sync via y-protocols
		if (this.mergeManager.isActive(guid)) {
			return;
		}

		if (!event.update) return;

		// Normalize update bytes (CBOR decoding may return Buffer or plain object)
		const update =
			event.update instanceof Uint8Array
				? event.update
				: new Uint8Array(event.update);

		// If a keyframe fetch is in progress, buffer the update
		const buf = this._pendingKeyframeUpdates.get(guid);
		if (buf) {
			metrics.recordDocumentUpdateEvent("catchup", this.guid);
			buf.push(update);
			return;
		}

		const classification = this.mergeManager.classifyUpdate(guid, update);
		switch (classification) {
			case 'apply':
				this.mergeManager.handleRemoteUpdate(guid, update);
				metrics.recordDocumentUpdateEvent("applied", this.guid);
				this.mergeManager.advanceAppliedRemoteUpdate(guid, update);
				break;
			case 'stale':
				break; // already covered by the applied remote baseline
			case 'gap':
				metrics.recordDocumentUpdateEvent("catchup", this.guid);
				this._fetchKeyframeAndDeliver(file, guid, [update]);
				break;
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

	private retryDeferredRemapForGuid(guid: string): void {
		// A live update event is fresh evidence the server has content now.
		this.clearServerEmpty(guid);
		const path = this.findCommittedPathByGuid(guid);
		if (!path || this._pendingRemaps.has(path)) return;

		const localGuid = this.syncStore.get(path);
		if (!localGuid || localGuid === guid) return;

		const localFile = this.files.get(localGuid);
		const committedMeta = this.syncStore.getCommittedMeta(path);
		if (!localFile || !isDocument(localFile) || !isDocumentMeta(committedMeta)) {
			return;
		}
		if (committedMeta.id !== guid) return;

		this._pendingRemaps.add(path);
		this.executeRemap({
			path,
			fromGuid: localGuid,
			toGuid: guid,
		}).catch((e) => {
			this.warn(`[${path}] remap retry from update event failed`, e);
		}).finally(() => {
			this._pendingRemaps.delete(path);
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
		const path = this.findCommittedPathByGuid(guid);
		if (!path || this._pendingDownloads.has(path)) return;

		const committedMeta = this.syncStore.getCommittedMeta(path);
		if (!isDocumentMeta(committedMeta) || committedMeta.id !== guid) {
			return;
		}

		const localGuid = this.syncStore.get(path);
		if (!localGuid || localGuid !== guid || this.files.has(guid)) {
			return;
		}

		this._pendingDownloads.add(path);
		this.downloadDoc(path, true)
			.catch((e) => {
				this.warn(`[${path}] deferred download retry failed`, e);
			})
			.finally(() => {
				this._pendingDownloads.delete(path);
			});
	}

	/**
	 * Fetch an HTTP keyframe, then deliver it and the buffered updates.
	 */
	private _fetchKeyframeAndDeliver(
		file: Document,
		guid: string,
		pending: Uint8Array[],
	): void {
		this._pendingKeyframeUpdates.set(guid, pending);
		this.backgroundSync.enqueueDownload(file, false).then((keyframe) => {
			const buf = this._pendingKeyframeUpdates.get(guid);
			this._pendingKeyframeUpdates.delete(guid);
			if (!buf || buf.length === 0) return;

			if (keyframe) {
				this.mergeManager.handleRemoteUpdate(guid, keyframe);
				this.mergeManager.seedAppliedRemoteUpdate(guid, keyframe);
			}

			for (const u of buf) {
				const c = this.mergeManager.classifyUpdate(guid, u);
				if (c === 'apply') {
					this.mergeManager.handleRemoteUpdate(guid, u);
					this.mergeManager.advanceAppliedRemoteUpdate(guid, u);
				}
				// 'stale' → drop (subsumed by keyframe)
				// 'gap' shouldn't happen after a keyframe, but if it does
				// the update is dropped — the keyframe is the best we have
			}
		});
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
	 * Any recovery that instead touches the transport — a fresh connect for a
	 * document with no live provider, or a remoteDoc rebuild for a stranded
	 * integration that reports connected but never synced its subdoc — waits for
	 * the transport to settle. Forcing a fresh sync while the transport still
	 * flaps drives the in-flight reconcile into a transport error and strands it
	 * in idle.error, the very failure this recovery exists to heal. The rebuild
	 * is the last resort, reserved for a document that stays
	 * connected-but-desynced after the transport is stable.
	 */
	private recoverForkedIdleDocument(file: Document, hsm: MergeHSM): void {
		if (file.connected && file.synced) {
			hsm.send({ type: "PROVIDER_SYNCED" });
			return;
		}
		if (!this.connectionStable) return;
		if (!file.hasProviderIntegration() || !file.connected) {
			file.connectForForkReconcile().catch(() => {});
			return;
		}
		file.connectForForkReconcile({ rebuildRemoteDoc: true }).catch(() => {});
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
			return !this.pendingCreates.has(vpath);
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
		if (!this.folderHSM && syncTFiles.length > 0) {
			// Legacy membership path: reserve GUIDs for new files up front.
			this.placeHold(syncTFiles);
		}
		syncTFiles.forEach((tfile) => {
			const vpath = this.getVirtualPath(tfile.path);
			if (this.folderHSM) {
				// Every syncable local file is evidence for the machine;
				// files unknown to the map are classified by the provenance
				// ladder after hydration instead of being
				// speculatively place-held, which minted guids and enqueued
				// uploads from a possibly partially hydrated map.
				this.folderHSM.send({
					type: "FILE_DISCOVERED",
					path: vpath,
					origin: "bootstrap",
					kind: tfile instanceof TFolder ? "folder" : "file",
				});
				// Pending-upload-only paths are ladder rung 1: the machine
				// re-enqueues them after hydration. Materializing them here
				// would route through uploadDoc before the hydration gate.
				if (this.pendingUpload.has(vpath)) return;
			}
			const guid = this.syncStore.get(vpath);
			if (this.folderHSM && !guid) return;
			const existing = guid ? this.files.get(guid) : undefined;
			if (existing) {
				files.push(existing);
				return;
			}
			const file = this.getFile(tfile, false);
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
	}

	async netSync() {
		try {
			await this.whenReady();
			await this.mergeManager.initialize();
			if (this.destroyed) return;
			this.addLocalDocs();
			await this.syncFileTree();
			this.backgroundSync.enqueueSharedFolderSync(this);
		} catch (error) {
			if (isDestroyedError(error)) return;
			throw error;
		}
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
	 * Level-triggered re-arm for pending downloads (the safety net over the
	 * edge-triggered enqueue): while membership holds pendingDownload
	 * entries, periodically re-run the enqueue for entries with no download
	 * in flight. Covers enqueues dropped against a mid-sync store and
	 * downloads deferred because the sharer had not yet staged content to
	 * the room ("server has guid but no content yet"). The guards inside
	 * executeEnqueueDownload keep each pass cheap and idempotent; the sweep
	 * disarms itself when nothing is pending.
	 */
	private armDownloadSweep(): void {
		if (this.destroyed || this._downloadSweepTimer !== null) return;
		if (!this.folderHSM) return;
		this._downloadSweepTimer = this.timeProvider.setTimeout(() => {
			this._downloadSweepTimer = null;
			if (this.destroyed || !this.folderHSM) return;
			const pending = this.folderHSM
				.getSnapshot()
				.entries.filter((entry) => entry.disposition === "pendingDownload");
			for (const entry of pending) {
				if (entry.guid === null) continue;
				this.executeEnqueueDownload(entry.path, entry.guid);
			}
			if (pending.length > 0) {
				this.armDownloadSweep();
			}
		}, DOWNLOAD_SWEEP_INTERVAL_MS);
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
		void Promise.resolve().then(() => {
			if (this.destroyed) return;
			let staged = 0;
			this.files.forEach((doc) => {
				if (isSyncFolder(doc)) return; // directories have no rooms
				const p = this.backgroundSync
					.enqueueUpload(doc as Document | Canvas | SyncFile)
					.catch((e) => {
						this.warn(
							"[FolderHSM] publication staging failed",
							doc.path,
							e,
						);
					});
				trackAsyncCleanup(p);
				staged++;
			});
			this.log(`[FolderHSM] publication: staged ${staged} content uploads`);
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
		if (this.s3rn instanceof S3RemoteFolder) {
			if (this.connected) {
				return true;
			}
			if (this.shouldConnect) {
				const result = await super.connect();
				if (result && this.mergeManager) {
					// Clear server-advertised reconnect metadata so the next
					// subdoc-index response reflects the current connection's
					// server view. The applied remote baseline stays intact
					// because it reflects state already incorporated locally.
					// The provider preserves eventCallbacks across reconnects
					// and re-sends the server subscribe frame itself, so the
					// callbacks registered by the constructor's
					// setupEventSubscriptions() call stay live.
					this.mergeManager.clearServerAdvertisedSVs();
					this.enqueueLCABackfill("connect");
					this.connectForkedIdleDocuments();
				}
				return result;
			}
		}
		return false;
	}

	private enqueueLCABackfill(reason: string): void {
		if (this.destroyed || this.localOnly || !this.connected) return;
		const queued = this.backgroundSync.enqueueLCABackfill(this);
		if (queued > 0) {
			this.debug(`[lca-backfill] queued ${queued} documents (${reason})`);
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

	/**
	 * Latch `ready` on the first completed handshake. `ready` is a
	 * one-way gate — "safe to enroll and edit files in this folder" —
	 * so the first provider sync must durably record hasServerSync.
	 * The transient `synced` term in the `ready` getter only bridges
	 * the moment between the handshake and this marker landing.
	 * Event-driven so the latch cannot miss the handshake when the
	 * remote record or login resolves after construction.
	 */
	protected handleProviderSynced(): void {
		// Bridge reconciliation runs only against genuine server truth (a
		// completed handshake), never a cold remote persistence — an empty
		// provider doc must not read as "everything was deleted". It runs
		// before the machine's hydration gate so the ladder sees a
		// converged map.
		this.folderBridge?.reconcile();
		// The FolderHSM hydration gate rides the same handshake as the
		// readiness latch; the machine itself dedups repeat syncs (the
		// ladder reruns only after a disconnect).
		this.folderHSM?.send({ type: "CONNECTED" });
		this.folderHSM?.send({ type: "PROVIDER_SYNCED" });
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

	protected handleProviderDesynced(): void {
		this.folderHSM?.send({ type: "DISCONNECTED" });
	}

	/**
	 * The vault-facing folder doc: the localDoc under the folder doc split
	 * (flag-on), the provider doc otherwise.
	 */
	get folderDoc(): Y.Doc {
		return this._localDoc ?? this.ydoc;
	}

	private persistCollectorState(state: SerializedCollectorState | null): void {
		try {
			if (state === null) {
				void this._persistence.del("deleteCollector");
			} else {
				void this._persistence.set("deleteCollector", JSON.stringify(state));
			}
		} catch (e) {
			// Gate persistence is best-effort; the localDoc/remoteDoc
			// divergence still carries the held deletions.
		}
	}

	/**
	 * A deletion burst containing the folder root: nothing replicates; the
	 * host detaches the folder locally (suspension is wired through
	 * flushVaultDeletes' flag-on path).
	 */
	private handleCollectorDetach(deletes: HeldDelete[]): void {
		this.log(
			`[DeleteCollector] detach: ${deletes.length} deletions withheld from replication`,
		);
		this.notifyListeners();
		this.onRootDetach?.();
	}

	/**
	 * A gated burst discarded by restore(): re-assert the keys on the
	 * localDoc from server truth. The resulting bridge-origin map deltas
	 * drive the machine to re-materialize the local files.
	 */
	private handleCollectorRestore(deletes: HeldDelete[]): void {
		this.folderBridge?.refreshFromRemote(deletes);
		this.notifyListeners();
	}

	/** Deletions currently held by the outbound gate. */
	heldDeletions(): HeldDelete[] {
		return this.deleteCollector?.heldDeletes() ?? [];
	}

	/** Stable, logical-path projection of the current gated burst. */
	deletionGate(): DeletionGateSnapshot | null {
		return this.deleteCollector?.gateSnapshot() ?? null;
	}

	/** Whether the outbound delete gate is awaiting a send/restore decision. */
	get deletionsGated(): boolean {
		return this.deleteCollector?.currentPhase === "gated";
	}

	/** Explicitly replicate a gated deletion burst. */
	sendHeldDeletions(token: string): GateResolution {
		return this.deleteCollector?.send(token) ?? "not-gated";
	}

	/** Explicitly discard a gated deletion burst and restore membership. */
	restoreHeldDeletions(token: string): GateResolution {
		return this.deleteCollector?.restore(token) ?? "not-gated";
	}

	/**
	 * Host signal from the vault feed: the folder's root was deleted. The
	 * root is never a map key, so the collector needs this out-of-band to
	 * classify the active burst as detach.
	 */
	notifyVaultRootDeleted(): void {
		this.deleteCollector?.notifyFolderRootDeleted();
	}

	/**
	 * Captured deletion history for this folder (split only): one entry per
	 * coalesced burst, newest last. Undo reverses the captured op — a
	 * compensating operation that re-asserts the removed entries on every
	 * replica (P10).
	 */
	deletionHistory(): Array<{
		id: number;
		origin: "local" | "remote";
		timestamp: number;
		paths: string[];
	}> {
		const capture = this._persistence?.opCapture;
		if (!capture) return [];
		return capture.entries.map((entry: CapturedOp, id: number) => ({
			id,
			origin:
				entry.origin === FOLDER_LOCAL_DELETE_ORIGIN
					? ("local" as const)
					: ("remote" as const),
			timestamp: entry.timestamp,
			paths: capture.deletedKeys(entry),
		}));
	}

	/**
	 * Reverse one captured deletion burst. The re-asserted entries flow
	 * outbound through the bridge (replicating the undo to peers) and their
	 * map deltas drive the machine to re-materialize local files. Always a
	 * user action, never automatic.
	 */
	undoDeletion(id: number): boolean {
		const capture = this._persistence?.opCapture;
		const entry = capture?.entries[id];
		if (!capture || !entry) return false;
		capture.reverse([entry]);
		this.notifyListeners();
		return true;
	}

	async getServerSynced(): Promise<boolean> {
		return this._persistence.getServerSynced();
	}

	private hasLocalDB(): boolean {
		return this._persistence.hasUserData();
	}

	async awaitingUpdates(): Promise<boolean> {
		await this.whenSynced();
		if (this.authoritative) {
			return false;
		}
		const serverSynced = await this.getServerSynced();
		if (serverSynced) {
			return false;
		}
		return !this.hasLocalDB();
	}

	whenReady(): Promise<SharedFolder> {
		const promiseFn = async (): Promise<SharedFolder> => {
			const awaitingUpdates = await this.awaitingUpdates();
			if (awaitingUpdates) {
				// If this is a brand new shared folder, we want to wait for a connection before we start reserving new guids for local files.
				this.connect();
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
		diffLog?.push(`${file.path} was renamed to ${this.getPath(path)}`);
		if (file instanceof TFile) {
			const dir = dirname(path);
			if (!this.existsSync(dir)) {
				await this.mkdir(dir);
				diffLog?.push(`creating directory ${dir}`);
			}
		}
		await this.fileManager
			.renameFile(file, normalizePath(this.getPath(path)))
			.then(() => {
				doc.move(path, this);
			});
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
			const doc = await this.downloadDoc(vpath, false);
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
			return this.getSyncFolder(vpath, false);
		}
		if (this.syncStore.canSync(vpath)) {
			diffLog?.push(`created local file for remotely added file ${vpath}`);
			return this.downloadSyncFile(vpath, false);
		}
		throw new Error(
			`${vpath}: Unexpected file type ${meta.type} ${meta.mimetype}`,
		);
	}

	private _assertNamespacing(path: string) {
		// Check if the path is valid (inside of shared folder), otherwise delete
		try {
			this.assertPath(this.path + path);
		} catch {
			this.error("Deleting doc (somehow moved outside of shared folder)", path);
			this.syncStore.delete(path);
			return;
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
	private async executeRemap({ path, fromGuid, toGuid }: {
		path: string;
		fromGuid: string;
		toGuid: string;
	}): Promise<void> {
		const sameGuid = fromGuid === toGuid;
		const operation = sameGuid ? "rebuild" : "remap";
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
			this.fset.add(newDoc, true);
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
				return { op: "update", path, promise: file.pull() };
			}

			// GUID mismatch — file at this path is mapped under a different
			// guid locally than meta.id. Reconcile by swapping identity to
			// the canonical meta.id.
			if (!file) {
				const localGuid = this.syncStore.get(path);
				const localFile = localGuid ? this.files.get(localGuid) : null;

				if (localGuid && localFile && isSyncFile(localFile) && isSyncFileMeta(meta)) {
					const promise = this.remapIfHashMatches(
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

	private async remapIfHashMatches(
		localFile: SyncFile,
		localGuid: string,
		remoteGuid: string,
		path: string,
		remoteMeta: Meta,
	): Promise<void> {
		try {
			const localHash = await localFile.caf.hash();
			if (localHash === remoteMeta.hash) {
				// Same content! Remap to use remote GUID
				this.files.delete(localGuid);
				this.pendingUpload.delete(path);
				this.files.set(remoteGuid, localFile);
				localFile.guid = remoteGuid;
				this.log(
					`Remapped file ${path} from local GUID ${localGuid} to remote GUID ${remoteGuid}`,
				);
			}
		} catch (error) {
			this.error("Error during GUID remapping:", error);
			throw error;
		}
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
					const promise = this.vault.adapter.trashLocal(file.path).finally(() => {
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
	 * Construct the membership machine when enableFolderHSM is on. The flag
	 * is read here, at folder construction, and never again — toggling it
	 * applies on the next folder (re)load. One FolderHSM per shared folder,
	 * as there is one MergeHSM per document.
	 */
	private maybeConstructFolderHSM(): FolderHSM | null {
		if (!flags().enableFolderHSM) {
			return null;
		}
		return new FolderHSM({
			folderGuid: this.guid,
			listMapEntries: () => this.syncStore.listEffectiveEntries(),
			getMapEntry: (vpath: string) => {
				const meta = this.syncStore.getCommittedMeta(vpath);
				return meta
					? { path: vpath, guid: meta.id, type: meta.type }
					: undefined;
			},
			getPendingUploadGuid: (vpath: string) =>
				this.pendingUpload.get(vpath) ?? undefined,
			getLocalRecordGuid: (vpath: string) =>
				this._localRecordCache.get(vpath),
			pathTombstoned: (vpath: string) =>
				pathWasDeleted(this.folderDoc.getMap<Meta>("filemeta_v0"), vpath),
			onEffect: (effect) => this.handleFolderHSMEffect(effect),
			onTransition: (from, to, eventType) => {
				this.debug(`[FolderHSM] ${from} -> ${to} (${eventType})`);
			},
		});
	}

	/** Live membership snapshot for status surfaces; null when the engine is off. */
	public getFolderSyncSnapshot(): FolderSyncSnapshot | null {
		return this.folderHSM?.getSnapshot() ?? null;
	}

	/**
	 * Route a vault create event into the machine with its origin decided
	 * by the discriminator: interactive iff the bootstrap scan completed and the
	 * path was not already known as a local file. Obsidian replays create
	 * events for every existing file at vault load; those must never
	 * launder into user intent.
	 */
	public notifyVaultCreate(tfile: TAbstractFile): boolean {
		const machine = this.folderHSM;
		if (!machine) return false;
		const vpath = this.getVirtualPath(tfile.path);
		if (this.isPendingDelete(vpath)) return false;
		// Capture shared-ness before the machine runs: its upload effect
		// place-holds the path, which must not be mistaken for an
		// already-shared file afterwards. Callers materialize the live file
		// object for already-shared paths (e.g. a download landing on disk).
		const alreadyShared = Boolean(this.syncStore.getCommittedMeta(vpath));
		const kind = tfile instanceof TFolder ? "folder" : "file";
		if (!this._hsmBootstrapScanned || machine.hasLocalFile(vpath)) {
			machine.send({
				type: "FILE_DISCOVERED",
				path: vpath,
				origin: "bootstrap",
				kind,
			});
			return alreadyShared;
		}
		this.scheduleInteractiveCreate(vpath, kind);
		return alreadyShared;
	}

	/**
	 * A novel interactive create settles for a debounce window before entering
	 * the machine, so a short-lived file removed by a rename or delete within
	 * the window never registers. The timer re-checks that the file still
	 * exists on disk before it fires — a rename-away leaves nothing to register.
	 */
	private scheduleInteractiveCreate(vpath: string, kind: LocalFileKind): void {
		this.cancelPendingCreate(vpath);
		const timer = this.timeProvider.setTimeout(() => {
			this.pendingCreates.delete(vpath);
			const machine = this.folderHSM;
			if (!machine) return;
			if (this.isPendingDelete(vpath)) return;
			if (!this.vault.getAbstractFileByPath(this.getPath(vpath))) return;
			machine.send({ type: "FILE_CREATED", path: vpath, kind });
		}, NEW_FILE_REGISTRATION_DEBOUNCE_MS);
		this.pendingCreates.set(vpath, timer);
	}

	/**
	 * Legacy (non-HSM) create routing. A file already known to the sync store
	 * materializes immediately (the caller reads it in); a genuinely-new file's
	 * registration settles for the debounce window so a short-lived atomic-write
	 * temp file vanishes before it is place-held and uploaded. Returns whether
	 * the caller should materialize the file now.
	 */
	public notifyVaultCreateLegacy(tfile: TAbstractFile): boolean {
		const vpath = this.getVirtualPath(tfile.path);
		if (this.isPendingDelete(vpath)) return false;
		if (this.syncStore.has(vpath)) return true;
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
			const newDocs = this.placeHold([tfile]);
			if (newDocs.includes(vpath)) {
				this.uploadFile(tfile);
			}
		}, NEW_FILE_REGISTRATION_DEBOUNCE_MS);
		this.pendingCreates.set(vpath, timer);
	}

	/** Cancel a settling interactive create — the path was removed or renamed away. */
	private cancelPendingCreate(vpath: string): void {
		const timer = this.pendingCreates.get(vpath);
		if (timer !== undefined) {
			this.timeProvider.clearTimeout(timer);
			this.pendingCreates.delete(vpath);
		}
	}

	/** Route a vault delete into the machine (skipping internal-trash echoes). */
	public notifyVaultDelete(vpath: string): void {
		this.cancelPendingCreate(vpath);
		const machine = this.folderHSM;
		if (!machine) return;
		if (this.isPendingDelete(vpath)) return;
		machine.send({ type: "FILE_DELETED", path: vpath });
	}

	/** Route an in-folder vault rename through the active membership path. */
	public notifyVaultRename(file: TAbstractFile, oldPath: string): void {
		const oldVPath = this.getVirtualPath(oldPath);
		const newVPath = this.getVirtualPath(file.path);
		this.cancelPendingCreate(oldVPath);
		this.cancelPendingCreate(newVPath);
		const machine = this.folderHSM;
		if (machine) {
			machine.send({
				type: "FILE_RENAMED",
				from: oldVPath,
				to: newVPath,
			});
			return;
		}

		if (this.syncStore.has(oldVPath)) {
			this.renameFile(file, oldPath);
			return;
		}
		if (this.syncStore.has(newVPath) || !this.isSyncableTFile(file)) {
			return;
		}
		const newDocs = this.placeHold([file]);
		if (newDocs.includes(newVPath)) {
			this.uploadFile(file);
		}
	}

	/**
	 * Missed-event recovery. The sweep is an event source for the machine, not an imperative
	 * differ: it replays the local file tree as discoveries and the
	 * difference between the machine's membership table and the committed
	 * map as a synthesized MAP_DELTA. Absence alone never deletes:
	 * every delete op in the derived delta carries the guid of a previously
	 * synced entry the map no longer holds anywhere — a real decision.
	 */
	private replayMembershipRecovery(diffLog: string[]): void {
		const machine = this.folderHSM;
		if (!machine) return;
		for (const tfile of this.getSyncFiles()) {
			const vpath = this.getVirtualPath(tfile.path);
			if (this.isPendingDelete(vpath) || this.pendingCreates.has(vpath)) {
				continue;
			}
			machine.send({
				type: "FILE_DISCOVERED",
				path: vpath,
				origin: "bootstrap",
				kind: tfile instanceof TFolder ? "folder" : "file",
			});
		}

		const snapshot = machine.getSnapshot();
		if (snapshot.statePath !== "tracking") return;
		const delta = deriveRecoveryDelta(
			snapshot.entries,
			this.syncStore.listEffectiveEntries(),
		);
		if (isEmptyRecoveryDelta(delta)) return;
		diffLog.push(
			`membership recovery delta: adds=${delta.adds.length} deletes=${delta.deletes.length} moves=${delta.moves.length}`,
		);
		machine.send({ type: "MAP_DELTA", ...delta });
	}

	/**
	 * Assemble the synchronous local-record cache the FolderHSM guards
	 * consult: HSM persisted state metadata (documents) plus guid-bearing
	 * hash-store entries (attachments). Runs before the folder is declared
	 * hydrated so the provenance ladder never sees an empty cache.
	 */
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

	private async assembleLocalRecordCache(): Promise<void> {
		try {
			const stateMetas = await this._hsmStore.getAllStateMeta();
			for (const stateMeta of stateMetas) {
				// The HSM store is app-wide; a record is evidence for THIS
				// folder only with a positive folder association. Records
				// predating folder scoping carry no association and are
				// ignored: absent evidence means upload, never trash (P4) —
				// a colliding vpath from another folder's record must not
				// classify a fresh local file as a stale materialization.
				if (stateMeta?.folder !== this.guid) continue;
				if (stateMeta?.path && stateMeta?.guid) {
					this._localRecordCache.set(stateMeta.path, stateMeta.guid);
				}
			}
		} catch (e) {
			this.warn("local record cache: HSM state metadata unavailable", e);
		}
		try {
			const entries = await this.hashStore.getAllEntries();
			for (const entry of entries) {
				if (!entry.guid) continue;
				// Hash store keys are vault-absolute paths.
				if (!this.checkPath(entry.path)) continue;
				this._localRecordCache.set(
					this.getVirtualPath(entry.path),
					entry.guid,
				);
			}
		} catch (e) {
			this.warn("local record cache: hash store unavailable", e);
		}
	}

	/**
	 * Execute FolderHSM effects through the existing sync machinery:
	 * uploads/downloads ride BackgroundSync via placeHold/uploadFile and
	 * _handleServerCreate, trash goes through Obsidian's trash
	 * (FileManager.trashFile — honors the user's trash preference), map
	 * mutations reuse deleteFile/renameFile.
	 */
	private handleFolderHSMEffect(effect: FolderEffect): void {
		switch (effect.type) {
			case "ENQUEUE_UPLOAD":
				this.executeEnqueueUpload(effect.path);
				return;
			case "ENQUEUE_DOWNLOAD":
				this.executeEnqueueDownload(effect.path, effect.guid);
				return;
			case "TRASH_LOCAL":
				this.executeTrashLocal(effect.path, effect.guid);
				return;
			case "RENAME_LOCAL":
				this.executeRenameLocal(effect.from, effect.to, effect.guid);
				return;
			case "MAP_SET":
				this.executeMapRename(effect.oldPath, effect.path);
				return;
			case "MAP_DELETE":
				this.executeMapDelete(effect.path);
				return;
			case "PARK":
				this.log(`[FolderHSM] parked ${effect.path}: ${effect.reason}`);
				return;
			case "SURFACE_STATUS":
				this.notifyListeners();
				return;
		}
	}

	private executeEnqueueUpload(vpath: string): void {
		try {
			const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
			if (!tfile || !this.isSyncableTFile(tfile)) return;
			if (this.skipStorageBlockedUpload(vpath)) return;
			// The guid is minted here (placeHold) — pendingUpload is the
			// durable record that this file is ours, awaiting first upload.
			this.placeHold([tfile]);
			this.uploadFile(tfile);
		} catch (e) {
			this.warn("[FolderHSM] upload effect failed", vpath, e);
		}
	}

	private executeEnqueueDownload(vpath: string, guid: string): void {
		if (this.existsSync(vpath)) return;
		if (this._pendingDownloads.has(vpath)) return;
		const meta = this.syncStore.getMeta(vpath);
		if (!meta || meta.id !== guid) {
			// A mid-sync store (meta/docs window) or a moved-on map. Report
			// instead of dropping silently: the machine keeps the entry
			// pendingDownload and retries on the next delta for the key.
			this.warn(
				"[FolderHSM] download enqueue dropped: store not ready",
				vpath,
				guid,
				meta?.id,
			);
			this.folderHSM?.send({ type: "DOWNLOAD_FAILED", path: vpath, guid });
			this.armDownloadSweep();
			return;
		}
		const promise = this._handleServerCreate(vpath, meta)
			.then((file) => {
				if (file) {
					this._localRecordCache.set(vpath, guid);
					this.folderHSM?.send({
						type: "DOWNLOAD_COMPLETE",
						path: vpath,
						guid,
					});
				} else {
					// Deferred: the room exists but carries no content yet
					// (the sharer has not finished staging). The sweep
					// retries once content lands.
					this.armDownloadSweep();
				}
				return file;
			})
			.catch((e) => {
				this.warn("[FolderHSM] download effect failed", vpath, e);
				this.folderHSM?.send({
					type: "DOWNLOAD_FAILED",
					path: vpath,
					guid,
				});
				this.armDownloadSweep();
			});
		trackPromise(`folderHSMDownload:${this.guid}:${vpath}`, promise);
	}

	private executeTrashLocal(vpath: string, guid: string | null): void {
		const fullPath = this.getPath(vpath);
		const tfile = this.vault.getAbstractFileByPath(fullPath);
		if (!tfile) {
			this.folderHSM?.send({ type: "TRASH_COMPLETE", path: vpath, guid });
			return;
		}
		// A folder trash cascades vault-delete events for every descendant.
		// Unmarked, those echoes launder into recorded local delete intent
		// and the machine then lawfully fights any later re-add (a deletion
		// undo re-deletes forever). Mark the whole subtree before trashing
		// so the cascade reads as our own effect, not user intent.
		const marked: string[] = [vpath];
		if (tfile instanceof TFolder) {
			Vault.recurseChildren(tfile, (child) => {
				if (child === tfile) return;
				try {
					marked.push(this.getVirtualPath(child.path));
				} catch {
					// Child resolves outside the folder namespace; no mark.
				}
			});
		}
		marked.forEach((p) => this.markPendingDelete(p));
		const promise = (async () => {
			try {
				await this.trashFile(tfile);
			} catch (e) {
				// A vanished file (already moved by an ancestor folder's
				// trash) IS completed work; anything else leaves the entry
				// pendingTrash for retry. TRASH_COMPLETE is a report of work
				// done, never of work attempted — reporting completion for
				// work that did not happen strands local files.
				if (this.vault.getAbstractFileByPath(fullPath)) {
					this.warn("[FolderHSM] trash effect failed", vpath, e);
					return;
				}
			}
			// The trash executor never mutates the map: membership deletion
			// belongs to the machine, and the entry was already removed by
			// the delta that emitted this effect. A map write here (the old
			// deleteFiles call) re-deleted undo-restored entries under a
			// local origin whenever a cascade-trashed child's own effect
			// resolved late — the deletion-echo defect. Only the live doc
			// object and local records are cleaned up.
			const doc =
				(guid ? this.files.get(guid) : undefined) ??
				this.fset.find((f) => f.path === vpath);
			if (doc) {
				this.fset.delete(doc);
				this.files.delete(doc.guid);
				doc.cleanup();
				doc.destroy();
				if (this._localDoc) {
					this.deferDocTeardown([doc.guid]);
				} else {
					this.teardownDocState(doc.guid);
				}
			}
			this.pendingUpload.delete(vpath);
			this._localRecordCache.delete(vpath);
			this.fset.update();
			this.folderHSM?.send({ type: "TRASH_COMPLETE", path: vpath, guid });
		})();
		// Suppression tokens are NOT cleared here: the cascade's vault
		// delete events arrive seconds after the rename resolves, so each
		// token is consumed by its event (consumePendingDelete) or expires
		// by TTL. Clearing on completion re-opens the echo window.
		trackPromise(`folderHSMTrash:${this.guid}:${vpath}`, promise);
	}

	private executeRenameLocal(from: string, to: string, guid: string): void {
		const tfile = this.vault.getAbstractFileByPath(this.getPath(from));
		if (!tfile) return;
		const file = this.files.get(guid);
		const promise = (async () => {
			if (file) {
				await this._handleServerRename(file, to, tfile);
			} else {
				const dir = dirname(to);
				if (!this.existsSync(dir)) {
					await this.mkdir(dir);
				}
				await this.fileManager.renameFile(
					tfile,
					normalizePath(this.getPath(to)),
				);
			}
			const record = this._localRecordCache.get(from);
			if (record) {
				this._localRecordCache.delete(from);
				this._localRecordCache.set(to, record);
			}
		})().catch((e) => {
			this.warn("[FolderHSM] rename effect failed", from, to, e);
		});
		trackPromise(`folderHSMRename:${this.guid}:${from}`, promise);
	}

	private executeMapRename(oldPath: string | undefined, newPath: string): void {
		try {
			const tfile = this.vault.getAbstractFileByPath(this.getPath(newPath));
			if (!tfile) return;
			if (oldPath) {
				this.renameFile(tfile, this.getPath(oldPath));
			} else if (this.isSyncableTFile(tfile)) {
				this.placeHold([tfile]);
				this.uploadFile(tfile);
			}
		} catch (e) {
			this.warn("[FolderHSM] map rename effect failed", newPath, e);
		}
	}

	private executeMapDelete(vpath: string): void {
		try {
			this.deleteFile(vpath);
		} catch (e) {
			this.warn("[FolderHSM] map delete effect failed", vpath, e);
		}
	}

	syncByType(
		syncStore: SyncStore,
		diffLog: string[],
		ops: Operation[],
		types: SyncType[],
	) {
		syncStore.forEachWithPending((meta, path) => {
			this._assertNamespacing(path);
			if (meta && types.contains(meta.type)) {
				ops.push(
					this.applyRemoteState(meta.id, path, syncStore.remoteIds, diffLog),
				);
			} else if (!meta && types.contains(SyncType.Document)) {
				// Pending upload only — no meta yet. Retry the upload so
				// syncFileTree's sweep covers outbound reconciliation alongside
				// the inbound remap/update work above.
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
	private applyPendingUpload(path: string): OperationType {
		const pendingGuid = this.syncStore.pendingUpload.get(path);
		if (!pendingGuid) {
			return { op: "noop", path, promise: Promise.resolve() };
		}

		// Server-authoritative rule: if committed filemeta already points at a
		// different GUID for this path, do not publish/overwrite local pending
		// metadata. Adopt the committed GUID instead.
		const committedMeta = this.syncStore.getCommittedMeta(path);
		if (committedMeta && committedMeta.id !== pendingGuid) {
			this.warn(
				"[applyPendingUpload] committed GUID differs from pending upload",
				{
					path,
					pendingGuid,
					committedGuid: committedMeta.id,
				},
			);
			const pendingFile = this.files.get(pendingGuid);
			if (isDocumentMeta(committedMeta) && pendingFile && isDocument(pendingFile)) {
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
			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (this.skipStorageBlockedUpload(path)) {
			return { op: "noop", path, promise: Promise.resolve() };
		}

		const file = this.files.get(pendingGuid);
		if (!file || !(isDocument(file) || isCanvas(file) || isSyncFile(file))) {
			return { op: "noop", path, promise: Promise.resolve() };
		}
		return {
			op: "update",
			path,
			promise: (async () => {
				await this.backgroundSync.enqueueUpload(file);
				await this.markUploaded(file);
			})(),
		};
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

				let deletes: Delete[] = [];
				if (this.folderHSM) {
					// Local deletions are event-driven (map observer deltas
					// plus the machine's decide-first recovery replay) — never
					// inferred from absence in the map.
					this.replayMembershipRecovery(diffLog);
				} else {
					const remotePaths = this.getDesiredRemotePaths();
					deletes = this.cleanupExtraLocalFiles(remotePaths, diffLog);
					if (![...ops, ...deletes].every((op) => op.op === "noop")) {
						this.log("remote paths", Array.from(remotePaths));
					}
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

	flush(doc: IFile, content: string): Promise<void> {
		const vaultPath = join(this.path, doc.path);
		this.log("writing to ", normalizePath(vaultPath));
		return this.vault.adapter.write(normalizePath(vaultPath), content);
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

	public getDoc(vpath: string, update = true): Document {
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
					return this.uploadDoc(vpath, update);
				}
				return this.createDoc(vpath, update);
			}
		} else {
			// the File exists, but the ID doesn't
			this.warn("[getDoc]: creating new shared ID for existing tfile");
			const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
			if (!(tfile instanceof TFile)) {
				throw new Error("unexpectedly missing tfile or got tfolder");
			}
			const newDocs = this.placeHold([tfile]);
			if (newDocs.length > 0) {
				return this.uploadDoc(vpath);
			} else {
				return this.createDoc(vpath, update);
			}
		}
	}

	public getCanvas(vpath: string, update = true): Canvas {
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
					return this.uploadCanvas(vpath, update);
				}
				return this.createCanvas(vpath, update);
			}
		} else {
			// the File exists, but the ID doesn't
			this.warn("[getCanvas]: creating new shared ID for existing tfile");
			const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
			if (!(tfile instanceof TFile)) {
				throw new Error("unexpectedly missing tfile or got tfolder");
			}
			const newDocs = this.placeHold([tfile]);
			if (newDocs.length > 0) {
				return this.uploadCanvas(vpath);
			} else {
				return this.createCanvas(vpath, update);
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

	async markUploaded(file: IFile) {
		const mark = (file: IFile, meta: Meta) => {
			if (!this.syncStore) {
				return;
			}

			// Server-authoritative rule: never overwrite an existing committed
			// GUID for this path with a local pending GUID.
			const committedMeta = this.syncStore.getCommittedMeta(file.path);
			if (committedMeta && committedMeta.id !== meta.id) {
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
				if (
					isDocument(file) &&
					isDocumentMeta(committedMeta) &&
					!this._pendingRemaps.has(file.path)
				) {
					this._pendingRemaps.add(file.path);
					this.executeRemap({
						path: file.path,
						fromGuid: file.guid,
						toGuid: committedMeta.id,
					}).catch((e) => {
						this.warn(`[${file.path}] remap retry from markUploaded failed`, e);
					}).finally(() => {
						this._pendingRemaps.delete(file.path);
					});
				}
				return;
			}

			if (this.syncStore.willSet(file.path, meta)) {
				this.log("new meta", file.path, meta);
				this.folderDoc.transact(() => {
					this.syncStore.markUploaded(file.path, meta);
				}, this);
			}
			if (this.folderHSM) {
				// A committed upload is a durable local record of this path's
				// identity, and it settles the machine's membership entry.
				this._localRecordCache.set(file.path, meta.id);
				this.folderHSM.send({
					type: "UPLOAD_COMPLETE",
					path: file.path,
					guid: meta.id,
				});
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

	getFile(tfile: TAbstractFile, update = true): IFile | null {
		const vpath = this.getVirtualPath(tfile.path);
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
					return this.getSyncFolder(vpath, update);
				}
				// Default to sync file for other types
				if (this.syncStore.canSync(vpath)) {
					return this.getSyncFile(vpath, update);
				}
			}
		}
		if (this.pendingCreates.has(vpath)) {
			return null;
		}

		// Fallback to extension-based detection for new files
		if (tfile instanceof TFolder) {
			return this.getSyncFolder(vpath, update);
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
				return this.getSyncFile(vpath, update);
			}
		}
		return null;
	}

	placeHold(newFiles: TAbstractFile[]): string[] {
		const newDocs: string[] = [];
		this.folderDoc.transact(() => {
			newFiles.forEach((file) => {
				const vpath = this.getVirtualPath(file.path);
				if (this.isPendingDelete(vpath)) {
					this.log("skipping place hold for pending delete", vpath);
					return;
				}
				if (!this.syncStore.has(vpath)) {
					this.log("place hold new", vpath);
					this.syncStore.new(vpath);
					newDocs.push(vpath);
				}
			});
		}, this);
		return newDocs;
	}

	getOrCreateCanvas(guid: string, vpath: string): Canvas {
		const canvas =
			this.files.get(guid) || new Canvas(vpath, guid, this.loginManager, this);
		if (!isCanvas(canvas)) {
			throw new Error("getOrCreateCanvas(): unexpected ifile type");
		}
		canvas.move(vpath, this);
		return canvas;
	}

	async downloadCanvas(vpath: string, update = true): Promise<Canvas> {
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

		this.backgroundSync.enqueueCanvasDownload(canvas, update);

		this.files.set(guid, canvas);
		this.fset.add(canvas, update);

		return canvas;
	}
	public uploadCanvas(vpath: string, update = true): Canvas {
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

		const originPromise = canvas.getOrigin();
		const awaitingUpdatesPromise = this.awaitingUpdates();

		(async () => {
			const exists = await this.exists(canvas);
			if (!exists) {
				throw new Error(`Upload failed, doc does not exist at ${vpath}`);
			}
			const [contents, origin, awaitingUpdates] = await Promise.all([
				this.read(canvas),
				originPromise,
				awaitingUpdatesPromise,
			]);
			if (!awaitingUpdates && origin === undefined) {
				this.log(`[${canvas.path}] No Known Peers: Syncing file into ytext.`);
				this.folderDoc.transact(() => {
					try {
						canvas.applyJSON(contents);
					} catch (e) {
						console.warn(contents);
						throw e;
					}
				}, this._persistence);
				canvas.markOrigin("local");
				this.log(`[${canvas.path}] Uploading file`);
				await this.backgroundSync.enqueueUpload(canvas);
				await this.markUploaded(canvas);
			}
		})();

		this.files.set(guid, canvas);
		this.fset.add(canvas, update);
		return canvas;
	}

	public createCanvas(vpath: string, update: boolean): Canvas {
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

		void trackPromise(`folder:canvasReady:${canvas.guid}`, this.whenReady())
			.then(async () => {
				const synced = await canvas.getServerSynced();
				if (canvas.stat.size === 0 && !synced) {
					this.backgroundSync.enqueueCanvasDownload(canvas);
				} else if (this.pendingUpload.get(canvas.path)) {
					await this.backgroundSync.enqueueUpload(canvas);
					await this.markUploaded(canvas);
				}
			})
			.catch((error) => {
				if (this.destroyed || canvas.destroyed) return;
				this.error("canvas ready failed", error);
			});

		this.files.set(guid, canvas);
		this.fset.add(canvas, update);
		return canvas;
	}

	public viewDoc(vpath: string): Document | undefined {
		const guid = this.syncStore.get(vpath);
		if (!guid) return;
		const doc = this.files.get(guid);
		if (!isDocument(doc)) {
			throw new Error("viewDoc(): unexpected ifile type");
		}
		return doc;
	}

	public viewSyncFile(vpath: string): SyncFile | undefined {
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

	async downloadDoc(
		vpath: string,
		update = true,
	): Promise<Document | undefined> {
		const pending = this._pendingDownloadPromises.get(vpath);
		if (pending) return pending;

		const promise = this.downloadDocOnce(vpath, update);
		this._pendingDownloadPromises.set(vpath, promise);
		this._pendingDownloads.add(vpath);
		try {
			return await promise;
		} finally {
			this._pendingDownloadPromises.delete(vpath);
			this._pendingDownloads.delete(vpath);
		}
	}

	private async downloadDocOnce(
		vpath: string,
		update: boolean,
	): Promise<Document | undefined> {
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
		const updateBytes = await this.backgroundSync.downloadByGuid(this, guid, vpath);

		if (!updateBytes) {
			this.recordServerEmpty(guid);
			this.log(`[${vpath}] download deferred: server has guid but no content yet`);
			return undefined;
		}

		const tempDoc = new Y.Doc();
		Y.applyUpdate(tempDoc, updateBytes);
		const contents = tempDoc.getText("contents").toString();
		const doc = this.getOrCreateDoc(guid, vpath);
		await doc.hsm?.initializeFromRemote(updateBytes);
		const remoteDoc = doc.ensureRemoteDoc();
		doc.hsm?.setRemoteDoc(remoteDoc);
		await doc.hsm?.awaitIdle();
		await doc.hsm?.completeInitialEnrollmentFromRemote(contents);

		if (!this.syncStore.has(doc.path)) {
			throw new Error("file no longer wanted");
		}

		this.files.set(guid, doc);
		await this.flush(doc, contents);
		this.fset.add(doc, update);

		return doc;
	}

	uploadDoc(vpath: string, update = true): Document {
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
			const [exists, awaitingUpdates] = await Promise.all([
				this.exists(doc),
				this.awaitingUpdates(),
			]);
			if (!exists) {
				throw new Error(`Upload failed, doc does not exist at ${vpath}`);
			}
			if (!awaitingUpdates) {
				await doc.hsm?.initializeWithContent();
				await this.backgroundSync.enqueueUpload(doc);
				await this.markUploaded(doc);
			}
		})();

		this.files.set(guid, doc);
		this.fset.add(doc, update);
		return doc;
	}

	createDoc(vpath: string, update = true): Document {
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
					await this.backgroundSync.enqueueUpload(doc);
					await this.markUploaded(doc);
				}
			})
			.catch((error) => {
				if (this.destroyed || doc.destroyed) return;
				this.error("document ready failed", error);
			});

		this.files.set(guid, doc);
		this.fset.add(doc, update);

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

	getSyncFolder(vpath: string, update: boolean) {
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
		this.fset.add(file, update);
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

	syncFile(vpath: string, update: boolean) {
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
			return this.uploadSyncFile(vpath, update);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, meta.hash);

		this.backgroundSync.enqueueSync(file);

		this.files.set(guid, file);
		this.fset.add(file, update);

		return file;
	}

	downloadSyncFile(vpath: string, update: boolean) {
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
			return this.uploadSyncFile(vpath, update);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, meta.hash);

		this.backgroundSync.enqueueDownload(file);

		this.files.set(guid, file);
		this.fset.add(file, update);

		return file;
	}

	uploadSyncFile(vpath: string, update = true): SyncFile {
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
			await this.backgroundSync.enqueueUpload(file);
			await this.markUploaded(file);
		})();

		this.fset.add(file, update);
		return file;
	}

	getSyncFile(vpath: string, update = true): SyncFile {
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
				await this.backgroundSync.enqueueUpload(file);
				await this.markUploaded(file);
			})();
		} else {
			this.log("get syncfile initial pull", {
				path: vpath,
				guid,
				metaHash: meta.hash,
				metaSynctime: meta.synctime,
			});
			file.pull();
		}

		this.files.set(guid, file);
		this.fset.add(file, update);
		return file;
	}

	uploadFile(tfile: TAbstractFile, update = true): IFile | null {
		const vpath = this.getVirtualPath(tfile.path);
		if (!this.isSyncableTFile(tfile)) {
			this.log("skipping upload for unsyncable file", vpath);
			return null;
		}
		if (tfile instanceof TFolder) {
			return this.getSyncFolder(vpath, update);
		} else if (tfile instanceof TFile) {
			if (Document.checkExtension(vpath)) {
				return this.uploadDoc(vpath, update);
			}
			if (
				Canvas.checkExtension(vpath) &&
				this.syncSettingsManager.isExtensionEnabled(vpath)
			) {
				return this.uploadCanvas(vpath, update);
			}
			if (this.syncStore.canSync(vpath)) {
				return this.uploadSyncFile(vpath, update);
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
		const cleanupGuids = new Set<string>();
		this.folderDoc.transact(() => {
			for (const vpath of paths) {
				this.pendingUpload.delete(vpath);
				const guid = this.syncStore?.get(vpath);
				if (guid) {
					this.syncStore.delete(vpath);
					const doc = this.files.get(guid);
					if (doc) {
						this.fset.delete(doc);
						this.files.delete(guid);
						doc.cleanup();
						doc.destroy();
					}
					cleanupGuids.add(guid);
				} else {
					// syncStore entry already gone (remote delete) - find by path
					const doc = this.fset.find((f) => f.path === vpath);
					if (doc) {
						const docGuid = doc.guid;
						this.fset.delete(doc);
						this.files.delete(docGuid);
						doc.cleanup();
						doc.destroy();
						cleanupGuids.add(docGuid);
					}
				}
			}
			// The tagged origin exists for deletion capture, which only
			// rides the split; flag-off keeps the folder instance origin.
		}, this._localDoc ? FOLDER_LOCAL_DELETE_ORIGIN : this);

		if (this._localDoc) {
			// Under the split, teardown of a deleted doc's local CRDT
			// persistence and HSM state defers for the capture retention
			// window, so a deletion undo reattaches instead of re-downloading.
			this.deferDocTeardown(cleanupGuids);
		} else {
			for (const guid of cleanupGuids) {
				this.teardownDocState(guid);
			}
		}
	}

	private teardownDocState(guid: string): void {
		indexedDB.deleteDatabase(`${this.appId}-relay-doc-${guid}`);
		const p = this._hsmStore.deleteState(guid).catch(() => {});
		trackAsyncCleanup(p);
	}

	private deferDocTeardown(guids: Iterable<string>): void {
		const now = this.timeProvider.now();
		let changed = false;
		for (const guid of guids) {
			this._deferredTeardown.push({ guid, deletedAt: now });
			changed = true;
		}
		if (changed) this.persistDeferredTeardown();
	}

	private persistDeferredTeardown(): void {
		try {
			void this._persistence.set(
				"deferredDocTeardown",
				JSON.stringify(this._deferredTeardown),
			);
		} catch (e) {
			// Ledger persistence is best-effort; an unswept entry only delays
			// cleanup, never loses data.
		}
	}

	/**
	 * Execute expired deferred teardowns. Guids re-added to membership by an
	 * undo leave the ledger without teardown — their state is live again.
	 */
	private sweepDeferredTeardown(): void {
		if (this._deferredTeardown.length === 0) return;
		const cutoff = this.timeProvider.now() - FOLDER_DELETION_RETENTION_MS;
		const live = new Set(this.syncStore.getCommittedSubdocGuids());
		const keep: Array<{ guid: string; deletedAt: number }> = [];
		for (const entry of this._deferredTeardown) {
			if (live.has(entry.guid)) continue;
			if (entry.deletedAt <= cutoff) {
				this.teardownDocState(entry.guid);
			} else {
				keep.push(entry);
			}
		}
		this._deferredTeardown = keep;
		this.persistDeferredTeardown();
	}

	renameFile(tfile: TAbstractFile, oldPath: string) {
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
		} else if (!oldVPath) {
			// if this was moved from outside the shared folder context, we need to create a live doc
			this.assertPath(newPath);
			if (!this.isSyncableTFile(tfile)) return;
			this.placeHold([tfile]);
			this.uploadFile(tfile);
		} else {
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
				if (this.folderHSM) {
					const record = this._localRecordCache.get(oldVPath);
					if (record) {
						this._localRecordCache.delete(oldVPath);
						this._localRecordCache.set(newVPath, record);
					}
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

				// Due to nested folder moves the tfiles and syncStore can diverge.
				// The nested folder moves are done in bulk in the sync store, but the tfile
				// events come in individually.
				this.syncStore.resolveMove(oldVPath);
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
		if (this._downloadSweepTimer !== null) {
			this.timeProvider.clearTimeout(this._downloadSweepTimer);
			this._downloadSweepTimer = null;
		}
		this.pendingCreates.forEach((timer) => this.timeProvider.clearTimeout(timer));
		this.pendingCreates.clear();
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
		this.deleteCollector?.destroy();
		this.deleteCollector = null;
		this.folderBridge?.destroy();
		this.folderBridge = null;
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
		if (this._remotePersistence) {
			const p = this._remotePersistence.destroy().catch(() => {});
			trackAsyncCleanup(p);
			this._remotePersistence = null;
		}
		this._localDoc?.destroy();
		this._localDoc = null;
		super.destroy();
		this.fset.destroy();
		this._settings.destroy();
		this._settings = null as any;
		this.revokeProxy?.();
		this.revokeProxy = null;
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
