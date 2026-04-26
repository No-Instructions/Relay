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
import { RelayInstances } from "./debug";
import { LocalStorage } from "./LocalStorage";
import { SyncFolder, isSyncFolder } from "./SyncFolder";
import { isDocument } from "./Document";
import { SyncStore } from "./SyncStore";
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
import { awaitOnReload } from "./reloadUtils";
import { generateHash } from "./hashing";
import {
	HSMStore,
} from "./merge-hsm/persistence";
import { trackPromise } from "./trackPromise";
import { expandDesiredRemotePaths } from "./syncPathUtils";
import * as Y from "yjs";

export interface SharedFolderSettings {
	guid: string;
	path: string;
	relay?: string;
	connect?: boolean;
	localOnly?: boolean;
	sync?: SyncFlags;
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

class Files extends ObservableSet<IFile> {
	// Startup performance optimization
	notifyListeners = debounce(super.notifyListeners, 100);

	update() {
		this.notifyListeners();
		return;
	}

	add(item: IFile, update = true): ObservableSet<IFile> {
		const existing = this.find((file) => file.guid === item.guid);
		if (existing && existing !== item) {
			this.error("duplicate guid", existing, item);
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
	private pendingDeletes: Set<string> = new Set();
	private enabledSyncTypes: Set<SyncType> = new Set();


	private _persistence: IndexeddbPersistence;
	proxy: SharedFolder;
	private revokeProxy: (() => void) | null = null;
	cas: ContentAddressedStore;
	syncSettingsManager: SyncSettingsManager;
	mergeManager: MergeManager;
	private recordingBridge: E2ERecordingBridge;
	private _pendingKeyframeUpdates: Map<string, Uint8Array[]> = new Map();
	private _pendingRemaps: Set<string> = new Set();
	private _pendingDownloads: Set<string> = new Set();
	private onFolderYDocUpdate = (_update: Uint8Array, origin: unknown): void => {
		// Folder metadata updates can arrive before SyncStore observers are active,
		// or with origins that bypass SyncStore-level callbacks. Reconcile directly
		// from Y.Doc updates so file materialization is not missed.
		if (this.destroyed || origin === this) {
			return;
		}
		trackPromise(`folder:ydocUpdateSync:${this.guid}`, this.syncFileTree()).catch(
			(e) => this.error("syncFileTree on ydoc update failed", e),
		);
	};

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
		relayId?: string,
		authoritative: boolean = false,
	) {
		const s3rn = relayId
			? new S3RemoteFolder(relayId, guid)
			: new S3Folder(guid);

		super(guid, s3rn, tokenStore, loginManager);
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
		this.relayId = relayId;
		this._shouldConnect = this.settings.connect ?? true;
		this._localOnly = this.settings.localOnly ?? false;

		this.authoritative = authoritative;

		this.syncSettingsManager = this._settings.getChild<
			Record<keyof SyncFlags, boolean>,
			SyncSettingsManager
		>("sync", (settings, path) => new SyncSettingsManager(settings, path));

		this.syncStore = new SyncStore(
			this.ydoc,
			this.path,
			this.pendingUpload,
			this.syncSettingsManager,
		);
		this.syncStore.on(async () => {
			await this.syncFileTree();
		});
		const subscribedYdoc = this.ydoc;
		subscribedYdoc.on("update", this.onFolderYDocUpdate);
		this.unsubscribes.push(() => {
			subscribedYdoc.off("update", this.onFolderYDocUpdate);
		});

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
			this._persistence = new IndexeddbPersistence(
				folderDbName, this.ydoc, null, null, migrateFrom
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

		if (loginManager.loggedIn) {
			this.connect();
		}

		this.cas = new ContentAddressedStore(this);

		// Create MergeManager for this SharedFolder (per-folder instance)
		this.mergeManager = new MergeManager({
			getVaultId: (guid: string) => `${this.appId}-relay-doc-${guid}`,
			getDocument: (guid: string) => {
				const file = this.files.get(guid);
				if (!file || !isDocument(file)) return undefined;
				return file;
			},
			timeProvider: undefined, // Use default
			createPersistence: (vaultId, doc, userId, captureOpts) =>
				new IndexeddbPersistence(vaultId, doc, userId, captureOpts),
			getDiskState: async (docPath: string) => {
				// docPath is SharedFolder-relative (e.g., "/note.md")
				const vaultPath = this.getPath(docPath);
				const tfile = this.vault.getAbstractFileByPath(vaultPath);
				if (!(tfile instanceof TFile)) return null;
				const contents = await this.vault.read(tfile);
				const encoder = new TextEncoder();
				const hash = await generateHash(encoder.encode(contents).buffer);
				return { contents, mtime: tfile.stat.mtime, hash };
			},
			loadAllStates: async () => {
				try {
					return await this._hsmStore.getAllStateMeta();
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
				this.debug?.(`[MergeManager] Effect for ${guid}:`, effect.type);
				if (effect.type === "PERSIST_STATE") {
					// Keep reload gating aware of pending HSM state writes so
					// plugin re-enable doesn't race persisted fork/LCA state.
					const p = this._hsmStore
						.saveState(guid, effect.state)
						.catch((err) => {
							this.error(
								`[MergeManager] saveState failed for ${guid}:`,
								err,
							);
						});
					awaitOnReload(p);
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
			userId: flags().enablePermanentUserData ? loginManager?.user?.id : undefined,
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
		const debugAPI = (globalThis as any).__relayDebug;
		if (debugAPI?.registerBridge) {
			const unregister = debugAPI.registerBridge(this.path, this.recordingBridge);
			this.unsubscribes.push(unregister);
		}
		this.mergeManager.setOnTransition((guid, path, info) => {
			this.recordingBridge.recordTransition(guid, path, info);
		});

		// Wire folder-level event subscriptions for idle mode remote updates
		this.setupEventSubscriptions();

		trackPromise(`folder:whenReady:${this.guid}`, this.whenReady()).then(async () => {
			if (!this.destroyed) {
				// Bulk-load LCA cache before registering HSMs
				await this.mergeManager.initialize();
				this.syncFileTree();
			}
		});

		trackPromise(`folder:whenSynced:${this.guid}`, this.whenSynced()).then(async () => {
			this.syncStore.start();
			// Wait until syncStore is observing the committed file metadata before
			// creating docs from local disk. On reload, addLocalDocs() can otherwise
			// reserve placeholder GUIDs for already-shared files and build HSMs that
			// miss their persisted fork/LCA state.
			//
			// Remote folder metadata can also land before SyncStore observers are
			// installed, so replay both local doc discovery and file-tree sync after
			// start() to avoid missing the first batch of remote entries.
			if (!this.destroyed) {
				this.enabledSyncTypes = new Set(
					this.syncStore.typeRegistry.getEnabledFileSyncTypes(),
				);
				this.addLocalDocs();
				await this.syncFileTree();
			}
			try {
				this._persistence.set("path", this.path);
				this._persistence.set("relay", this.relayId || "");
				this._persistence.set("appId", this.appId);
				this._persistence.set("s3rn", S3RN.encode(this.s3rn));
			} catch (e) {
				// pass
			}
		});

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
		})();

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

		// On (re)connect, the provider issues MSG_QUERY_SUBDOCS and receives
		// the server's complete view of this folder's docs: guid → state
		// vector. Seed server-advertised heads from that one message and fire a full
		// syncFileTree sweep; applyRemoteState + applyPendingUpload handle
		// both inbound reconciliation and outbound pending-upload retry.
		const provider = this._provider;
		provider.getSubdocQueryDocIds = () => {
			if (!flags().enableSelectiveSubdocQuery || !this.relayId) return [];
			const guids = this.syncStore.getCommittedSubdocGuids();
			return guids.length > 0
				? guids.map((guid) => this.serverDocIdForGuid(guid))
				: [];
		};
		provider.onSubdocIndex = (serverIndex) => {
			for (const [docId, entry] of Object.entries(serverIndex)) {
				const guid = this.guidFromServerDocId(docId) ?? docId;
				this.mergeManager?.seedServerAdvertisedSVFromBytes(
					guid,
					entry.stateVector,
				);
			}
			this.syncFileTree()
				.then(() => this.poll())
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
			buf.push(update);
			return;
		}

		const classification = this.mergeManager.classifyUpdate(guid, update);
		switch (classification) {
			case 'apply':
				this.mergeManager.handleRemoteUpdate(guid, update);
				this.mergeManager.advanceAppliedRemoteUpdate(guid, update);
				break;
			case 'stale':
				break; // already covered by the applied remote baseline
			case 'gap':
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

	private retryDeferredDownloadForGuid(guid: string): void {
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
		this.backgroundSync.enqueueDownload(file, !flags().enableNewSyncStatus).then((keyframe) => {
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
	 * Handle WRITE_DISK effect in idle mode.
	 *
	 * When a document is in idle mode and receives remote updates, the HSM
	 * may need to write merged content to disk. This happens when:
	 * 1. Remote update arrives (from server)
	 * 2. HSM performs idle auto-merge (remote → local CRDT)
	 * 3. HSM emits WRITE_DISK effect to update the file on disk
	 *
	 * Without this handler, the effect is dropped.
	 */
	private async handleIdleWriteDisk(
		guid: string,
		contents: string,
	): Promise<void> {
		try {
			// Look up document by guid to get current path (handles renames)
			const file = this.files.get(guid);
			if (!file || !isDocument(file)) {
				this.warn(`[handleIdleWriteDisk] Document not found for guid: ${guid}`);
				return;
			}

			const vaultPath = this.getPath(file.path);
			let tfile = this.vault.getAbstractFileByPath(vaultPath);

			if (tfile instanceof TFile) {
				await this.vault.modify(tfile, contents);
			} else {
				// File doesn't exist on disk yet (new remote file) — create it
				const normalized = normalizePath(vaultPath);
				// Ensure parent folders exist
				const parentPath = normalized.substring(0, normalized.lastIndexOf("/"));
				if (parentPath && !this.vault.getAbstractFileByPath(parentPath)) {
					await this.vault.createFolder(parentPath);
				}
				tfile = await this.vault.create(normalized, contents);
			}

			this.log(`[handleIdleWriteDisk] Wrote merged content to ${vaultPath}`);

		} catch (e) {
			this.warn(`[handleIdleWriteDisk] Failed to write for guid ${guid}:`, e);
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
					const diskState = await file.readDiskContent();

					if (this.shouldSendDiskChanged(currentDisk, diskState)) {
						hsm.send({
							type: "DISK_CHANGED",
							contents: diskState.content,
							mtime: diskState.mtime,
							hash: diskState.hash,
						});
					}
				}
			} catch (e) {
				// File might have been deleted - ignore
			}

			// Connect forked documents awaiting provider sync
			if (
				hsm.state.fork !== null
				&& hsm.matches("idle.localAhead")
				&& !file.hasProviderIntegration()
				&& this.shouldConnect
			) {
				file.connectForForkReconcile().catch(() => {});
			}

			if (
				this.shouldConnect &&
				this.mergeManager?.isServerAdvertisedRemoteAhead(guid)
			) {
				this.backgroundSync.enqueueSync(file).catch((e) => {
					this.warn(
						`[poll] failed to enqueue server-advertised remote sync for ${file.path}`,
						e,
					);
				});
			}
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

	/**
	 * Determine if DISK_CHANGED event should be sent based on current vs new disk state.
	 * Returns true if disk state has changed, false if unchanged.
	 */
	private shouldSendDiskChanged(
		currentDisk: { hash: string; mtime: number } | null,
		newDiskState: { mtime: number; hash: string },
	): boolean {
		// No current disk state - always send
		if (!currentDisk) return true;

		// Compare mtime first (fast check)
		if (currentDisk.mtime !== newDiskState.mtime) return true;

		// Compare hash as fallback (handles clock skew edge cases)
		if (currentDisk.hash !== newDiskState.hash) return true;

		return false;
	}

	private addLocalDocs = (types?: SyncType[]) => {
		let syncTFiles = this.getSyncFiles();
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
		// Reserve GUIDs for new files before processing
		this.placeHold(syncTFiles);
		syncTFiles.forEach((tfile) => {
			const file = this.getFile(tfile, false);
			if (file) {
				files.push(file);
			}
		});
		if (files.length > 0) {
			this.fset.update();
		}
	};

	public get server(): string | undefined {
		return this._server;
	}

	public set server(value: string | undefined) {
		if (value === this._server) {
			return;
		}
		this.warn("server changed -- reinitializing all connections");
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

		return inFolder && isSupportedFileType && isExtensionEnabled;
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
		await this.whenReady();
		this.addLocalDocs();
		await this.syncFileTree();
		this.backgroundSync.enqueueSharedFolderSync(this);
	}

	public get settings(): SharedFolderSettings {
		return this._settings.get();
	}

	async sync() {
		await this.syncFileTree();
	}

	async connect(): Promise<boolean> {
		if (this.s3rn instanceof S3RemoteFolder) {
			if (this.connected || this.shouldConnect) {
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
				}
				return result;
			}
		}
		return false;
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

	public set remote(value: RemoteSharedFolder | undefined) {
		if (this._remote === value) {
			return;
		}
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
			this._server = value.relay.providerId;
			this.unsubscribes.push(
				value.relay.subscribe((relay) => {
					if (relay.guid === this.relayId) {
						this.server = relay.providerId;
					}
				}),
			);
		}

		this.server = value?.relay.providerId;
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
			});
		return trackPromise(`folder:whenReady:${this.guid}`, this.readyPromise.getPromise());
	}

	whenSynced(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			// Check if already synced first
			if (this._persistence.synced) {
				this.persistenceSynced = true;
				return;
			}

			return new Promise<void>((resolve) => {
				this._persistence.once("synced", () => {
					this.persistenceSynced = true;
					resolve();
				});
			});
		};

		this.whenSyncedPromise =
			this.whenSyncedPromise ||
			new Dependency<void>(promiseFn, (): [boolean, void] => {
				if (this._persistence.synced) {
					this.persistenceSynced = true;
				}
				return [this.persistenceSynced, undefined];
			});
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
	 * Swap a document's local CRDT identity from fromGuid to toGuid. Called
	 * when the folder's meta CRDT resolves a path to a GUID that differs from
	 * the one we enrolled locally (concurrent-create race, delete+recreate,
	 * etc.). Tears down the losing Y.Doc + IDB + HSM state, downloads the
	 * winning CRDT from the server, and creates a fresh Document under the
	 * canonical GUID. HSMEditorPlugin picks up the Document swap on its next
	 * CM6 update tick; the HSM's active.entering flow handles any content
	 * divergence via its standard fork reconciliation path.
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
		if (!this.connected) {
			this.log(`[${path}] remap deferred: folder offline`);
			return;
		}

		let updateBytes: Uint8Array | undefined;
		try {
			updateBytes = await this.backgroundSync.downloadByGuid(this, toGuid, path);
		} catch (e) {
			this.warn(`[${path}] remap download failed, deferring`, e);
			return;
		}

		if (!updateBytes) {
			this.log(`[${path}] remap deferred: server has guid but no content yet`);
			return;
		}

		if (this.destroyed) {
			this.log(`[${path}] remap aborted: folder destroyed during download`);
			return;
		}

		const existingFile = this.files.get(fromGuid);
		if (existingFile) {
			this.files.delete(fromGuid);
			this.fset.delete(existingFile);
			existingFile.cleanup();
			existingFile.destroy();
		}

		try {
			indexedDB.deleteDatabase(`${this.appId}-relay-doc-${fromGuid}`);
		} catch {}
		const p = this._hsmStore.deleteState(fromGuid).catch(() => {});
		awaitOnReload(p);

		this.syncStore.pendingUpload.delete(path);

		const newDoc = this.getOrCreateDoc(toGuid, path);
		this.files.set(toGuid, newDoc);
		this.fset.add(newDoc, true);
		const isCurrentDoc = () =>
			!this.destroyed && !newDoc.destroyed && this.files.get(toGuid) === newDoc;

		if (!isCurrentDoc()) {
			this.log(`[${path}] remap aborted: new document is stale`);
			return;
		}

		if (updateBytes) {
			await newDoc.hsm?.initializeFromRemote(updateBytes);
		}
		if (!isCurrentDoc()) {
			this.log(`[${path}] remap aborted after enroll: new document is stale`);
			return;
		}
		await this.poll([toGuid]);

		this.log(`Remapped Document ${path}: ${fromGuid} → ${toGuid}`);
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

				if (localGuid && isDocumentMeta(meta)) {
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
			const filePending = this.pendingUpload.has(vpath);
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

		const file = this.files.get(pendingGuid);
		if (!file || !(isDocument(file) || isCanvas(file) || isSyncFile(file))) {
			return { op: "noop", path, promise: Promise.resolve() };
		}
		return {
			op: "update",
			path,
			promise: (async () => {
				await this.backgroundSync.enqueueSync(file);
				await this.markUploaded(file);
			})(),
		};
	}

	syncFileTree(): Promise<void> {
		// If a sync is already running, mark that we want another sync after
		if (this.syncFileTreePromise) {
			this.syncRequestedDuringSync = true;
			const promise = this.syncFileTreePromise.getPromise();
			promise.then(() => {
				if (this.syncRequestedDuringSync) {
					this.syncRequestedDuringSync = false;
					return this.syncFileTree();
				}
			});
			return promise;
		}

		const promiseFn = async (): Promise<void> => {
			try {
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

				this.ydoc.transact(async () => {
					// Sync folder operations first because renames/moves also affect files
					this.syncStore.migrateUp();
					this.syncByType(this.syncStore, diffLog, ops, [SyncType.Folder]);
				}, this);
				await Promise.all(ops.map((op) => op.promise));
				this.ydoc.transact(async () => {
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
						withTimeoutWarning<IFile | void>(op.promise, op),
					),
				);

				const remotePaths = this.getDesiredRemotePaths();
				const deletes = this.cleanupExtraLocalFiles(remotePaths, diffLog);
				if ([...ops, ...deletes].every((op) => op.op === "noop")) {
					this.debug("sync: noop");
				} else {
					this.log("remote paths", Array.from(remotePaths));
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

		this.syncFileTreePromise = new SharedPromise<void>(promiseFn);

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
				this.ydoc.transact(() => {
					this.syncStore.markUploaded(file.path, meta);
				}, this);
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
			if (this.syncStore.canSync(vpath)) {
				return this.getSyncFile(vpath, update);
			}
		}
		return null;
	}

	placeHold(newFiles: TAbstractFile[]): string[] {
		const newDocs: string[] = [];
		this.ydoc.transact(() => {
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

		this.backgroundSync.enqueueCanvasDownload(canvas);

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
				this.ydoc.transact(() => {
					try {
						canvas.applyJSON(contents);
					} catch (e) {
						console.warn(contents);
						throw e;
					}
				}, this._persistence);
				canvas.markOrigin("local");
				this.log(`[${canvas.path}] Uploading file`);
				await this.backgroundSync.enqueueSync(canvas);
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

		(async () => {
			trackPromise(`folder:canvasReady:${canvas.guid}`, this.whenReady()).then(async () => {
				const synced = await canvas.getServerSynced();
				if (canvas.stat.size === 0 && !synced) {
					this.backgroundSync.enqueueCanvasDownload(canvas);
				} else if (this.pendingUpload.get(canvas.path)) {
					await this.backgroundSync.enqueueSync(canvas);
					await this.markUploaded(canvas);
				}
			});
		})();

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
		const doc =
			this.files.get(guid) ||
			new Document(vpath, guid, this.loginManager, this);
		if (!isDocument(doc)) {
			throw new Error("unexpected ifile type");
		}
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
		const updateBytes = await this.backgroundSync.downloadByGuid(this, guid, vpath);

		if (!updateBytes) {
			this.log(`[${vpath}] download deferred: server has guid but no content yet`);
			return undefined;
		}

		const tempDoc = new Y.Doc();
		Y.applyUpdate(tempDoc, updateBytes);
		const contents = tempDoc.getText("contents").toString();
		const doc = this.getOrCreateDoc(guid, vpath);
		await doc.hsm?.initializeFromRemote(updateBytes);

		if (!this.syncStore.has(doc.path)) {
			throw new Error("file no longer wanted");
		}

		this.files.set(guid, doc);
		await doc.hsm?.setLCA();
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
				// HSM handles enrollment check and lazy disk loading internally.
				// initializeWithContent() checks origin in one IDB session, only reads
				// disk if not already enrolled, and sets origin atomically.
				await doc.hsm?.initializeWithContent();
				await this.backgroundSync.enqueueSync(doc);
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

		(async () => {
			trackPromise(`folder:docReady:${doc.guid}`, this.whenReady()).then(async () => {
				const synced = await doc.getServerSynced();
				if (doc.tfile?.stat.size === 0 && !synced) {
					this.backgroundSync.enqueueDownload(doc, !flags().enableNewSyncStatus);
				} else if (this.pendingUpload.get(doc.path)) {
					await this.backgroundSync.enqueueSync(doc);
					await this.markUploaded(doc);
				}
			});
		})();

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
			await this.backgroundSync.enqueueSync(file);
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
			file.push();
		} else {
			file.pull();
		}

		this.files.set(guid, file);
		this.fset.add(file, update);
		return file;
	}

	uploadFile(tfile: TAbstractFile, update = true): IFile {
		const vpath = this.getVirtualPath(tfile.path);
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
		this.pendingDeletes.add(vpath);
		this.log("marked pending delete", vpath);
	}

	clearPendingDelete(vpath: string) {
		this.pendingDeletes.delete(vpath);
		this.log("cleared pending delete", vpath);
	}

	isPendingDelete(vpath: string): boolean {
		return this.pendingDeletes.has(vpath);
	}

	isPendingUpload(vpath: string): boolean {
		return this.pendingUpload.has(vpath);
	}

	deleteFile(vpath: string) {
		this.pendingUpload.delete(vpath);
		const guid = this.syncStore?.get(vpath);
		if (guid) {
			this.ydoc.transact(() => {
				this.syncStore.delete(vpath);
				const doc = this.files.get(guid);
				if (doc) {
					this.fset.delete(doc);
					this.files.delete(guid);
					doc.cleanup();
					doc.destroy();
				}
			}, this);
			indexedDB.deleteDatabase(`${this.appId}-relay-doc-${guid}`);
			const p = this._hsmStore.deleteState(guid).catch(() => {});
			awaitOnReload(p);
		} else {
			// syncStore entry already gone (remote delete) - find by path
			const doc = this.fset.find((f) => f.path === vpath);
			if (doc) {
				const docGuid = doc.guid;
				this.fset.delete(doc);
				this.files.delete(docGuid);
				doc.cleanup();
				doc.destroy();
				indexedDB.deleteDatabase(`${this.appId}-relay-doc-${docGuid}`);
				const p = this._hsmStore.deleteState(docGuid).catch(() => {});
				awaitOnReload(p);
			}
		}
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
			if (!this.syncStore.canSync(newVPath)) return;
			this.placeHold([tfile]);
			this.uploadFile(tfile);
		} else {
			// live doc exists
			const guid = this.syncStore.get(oldVPath);
			if (!guid) return;
			const file = this.files.get(guid);
			if (!newVPath) {
				// moving out of shared folder.. destroy the live doc.
				this.ydoc.transact(() => {
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
				this.ydoc.transact(() => {
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
		this.destroyed = true;
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.unsubscribes = [];

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
		// handler. Capture it here so awaitOnReload holds plugin re-enable
		// until IDB has flushed. Calling destroy() removes the 'destroy'
		// listener synchronously, so super.destroy() below won't double-fire.
		if (this._persistence) {
			const p = this._persistence.destroy().catch(() => {});
			awaitOnReload(p);
		}
		super.destroy();
		this.fset.clear();
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
		this.whenSyncedPromise?.destroy();
		this.whenSyncedPromise = null as any;
		this.readyPromise?.destroy();
		this.readyPromise = null as any;
		this.syncFileTreePromise?.destroy();
		this.syncFileTreePromise = null as any;

	}
}

export class SharedFolders extends ObservableSet<SharedFolder> {
	private folderBuilder: (
		path: string,
		guid: string,
		relayId?: string,
		authoritative?: boolean,
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
		) => SharedFolder,
		private settings: NamespacedSettings<SharedFolderSettings[]>,
		private _hsmStore: HSMStore,
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
		if (item) {
			item.files.forEach((doc: IFile) => {
				dbNames.push(`${item.appId}-relay-doc-${doc.guid}`);
			});
			dbNames.push(item.guid);
		}
		item?.destroy();
		const deleted = super.delete(item);
		this.settings.update((current) => {
			return current.filter((settings) => settings.guid !== item.guid);
		});
		// Delete IDB databases after in-memory objects are destroyed
		for (const name of dbNames) {
			indexedDB.deleteDatabase(name);
		}
		// Delete folder-level index from global HSM database
		const p = this._hsmStore.deleteIndex(item.guid).catch(() => {});
		awaitOnReload(p);
		return deleted;
	}

	update = debounce(this.notifyListeners, 100);

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
		this.items().forEach((folder) => {
			folder.destroy();
		});
		this.clear();
		if (this._offRemoteUpdates) {
			this._offRemoteUpdates();
		}
		super.destroy();
		this.relayManager = null as any;
		this.folderBuilder = null as any;
	}

	load() {
		this._load(this.settings.get());
	}

	private _load(folders: SharedFolderSettings[]) {
		let updated = false;
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

		if (updated) {
			this.notifyListeners();
		}
	}

	private _new(
		path: string,
		guid: string,
		relayId?: string,
		authoritative?: boolean,
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
		const folder = this.folderBuilder(path, guid, relayId, authoritative);
		this._set.add(folder);
		return folder;
	}

	/** Share a local folder — user is authoritative (source of truth). */
	init(path: string, relayId?: string): SharedFolder {
		const guid = uuidv4();
		const folder = this._new(path, guid, relayId, true);
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
