"use strict";
import { IndexeddbPersistence } from "./storage/y-indexeddb";
import * as idb from "lib0/indexeddb";
import * as Y from "yjs";
import { HasProvider } from "./HasProvider";
import { LoginManager } from "./LoginManager";
import { S3Document, S3Folder, S3RN, S3RemoteDocument } from "./S3RN";
import { SharedFolder } from "./SharedFolder";
import type { TFile, Vault, TFolder } from "obsidian";
import { debounce } from "obsidian";
import type { Unsubscriber } from "./observable/Observable";
import { Dependency } from "./promiseUtils";
import { flags, withFlag } from "./flagManager";
import { flag } from "./flags";
import type { HasMimeType, IFile } from "./IFile";
import { getMimeType } from "./mimetypes";
import { diffMatchPatch } from "./y-diffMatchPatch";
import type { MergeHSM } from "./merge-hsm/MergeHSM";
import type { EditorViewRef } from "./merge-hsm/types";
import { ProviderIntegration, type YjsProvider } from "./merge-hsm/integration/ProviderIntegration";
import { generateHash } from "./hashing";

export function isDocument(file?: IFile): file is Document {
	return file instanceof Document;
}

export class Document extends HasProvider implements IFile, HasMimeType {
	private _parent: SharedFolder;
	private _persistence: IndexeddbPersistence | null = null;
	whenSyncedPromise: Dependency<void> | null = null;
	persistenceSynced: boolean = false;
	_awaitingUpdates?: boolean;
	readyPromise?: Dependency<Document>;
	path: string;
	_tfile: TFile | null;
	name: string;
	userLock: boolean = false;
	extension: string;
	basename: string;
	vault: Vault;
	stat: {
		ctime: number;
		mtime: number;
		size: number;
	};
	unsubscribes: Unsubscriber[] = [];
	pendingOps: ((data: string) => string)[] = [];

	/**
	 * MergeHSM instance for this document.
	 * Only available when HSM active mode is enabled.
	 * Use acquireLock() to get/create the HSM.
	 */
	private _hsm: MergeHSM | null = null;

	/**
	 * ProviderIntegration instance for bridging HSM with the provider.
	 * Created when lock is acquired, destroyed when released.
	 */
	private _providerIntegration: ProviderIntegration | null = null;

	/**
	 * Flag to track when we're in the middle of our own save operation.
	 * Used to distinguish our writes from external modifications.
	 */
	private _isSaving: boolean = false;

	constructor(
		path: string,
		guid: string,
		loginManager: LoginManager,
		parent: SharedFolder,
	) {
		const s3rn = parent.relayId
			? new S3RemoteDocument(parent.relayId, parent.guid, guid)
			: new S3Document(parent.guid, guid);
		super(guid, s3rn, parent.tokenStore, loginManager);
		this._parent = parent;
		this.path = path;
		this.name = "[CRDT] " + path.split("/").pop() || "";
		this.setLoggers(this.name);
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.vault = this._parent.vault;
		this.stat = {
			ctime: Date.now(),
			mtime: Date.now(),
			size: 0,
		};
		// Initialize HSM immediately so it's always available for filtering disk changes.
		// The HSM starts in loading state and transitions to idle once persistence loads.
		// Document owns the HSM - use ensureHSM() which uses MergeManager as a factory.
		this.ensureHSM();

		this.unsubscribes.push(
			this._parent.subscribe(this.path, (state) => {
				if (state.intent === "disconnected") {
					this.disconnect();
				}
			}),
		);

		this.setLoggers(`[SharedDoc](${this.path})`);

		// need to port this to the HSM
		// this.whenSynced().then(() => {
		// 	const statsObserver = (event: Y.YTextEvent) => {
		// 		const origin = event.transaction.origin;
		// 		if (event.changes.keys.size === 0) return;
		// 		if (origin == this) return;
		// 		this.updateStats();
		// 	};
		// 	this.ytext.observe(statsObserver);
		// 	this.unsubscribes.push(() => {
		// 		this.ytext?.unobserve(statsObserver);
		// 	});
		// 	this.updateStats();
		// 	try {
		// 		this._persistence!.set("path", this.path);
		// 		this._persistence!.set("relay", this.sharedFolder.relayId || "");
		// 		this._persistence!.set("appId", this.sharedFolder.appId);
		// 		this._persistence!.set("s3rn", S3RN.encode(this.s3rn));
		// 	} catch (e) {
		// 		// pass
		// 	}

		// 	(async () => {
		// 		const serverSynced = await this.getServerSynced();
		// 		if (!serverSynced) {
		// 			await this.onceProviderSynced();
		// 			await this.markSynced();
		// 		}
		// 	})();
		// });

		withFlag(flag.enableDeltaLogging, () => {
			// Only attach observer when remoteDoc is loaded (avoid triggering lazy creation)
			if (!this.isRemoteDocLoaded) return;
			const logObserver = (event: Y.YTextEvent) => {
				let log = "";
				log += `Transaction origin: ${event.transaction.origin} ${event.transaction.origin?.constructor?.name}\n`;
				for (const delta of event.changes.delta) {
					log += `insert: ${delta.insert}\n\nretain: ${delta.retain}\n\ndelete: ${delta.delete}\n`;
				}
				this.debug(log);
			};
			this.ytext.observe(logObserver);
			this.unsubscribes.push(() => {
				this.ytext.unobserve(logObserver);
			});
		});

		this._tfile = null;
	}

	move(newPath: string, sharedFolder: SharedFolder) {
		this.path = newPath;
		this._parent = sharedFolder;
		this.name = newPath.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.updateStats();
	}

	async process(_fn: (data: string) => string) {
		// Automatic diff resolution removed due to data loss issues (BUG-020)
		// This method is intentionally a no-op
	}

	public get parent(): TFolder | null {
		return this.tfile?.parent || null;
	}

	public get sharedFolder(): SharedFolder {
		return this._parent;
	}

	/**
	 * Get the MergeHSM instance for this document.
	 * Returns null if HSM active mode is not enabled or lock not acquired.
	 */
	public get hsm(): MergeHSM | null {
		return this._hsm;
	}

	/**
	 * Ensure an HSM exists for this document, creating one if needed.
	 * Document owns the HSM - MergeManager is just a factory.
	 * @returns The MergeHSM instance, or null if MergeManager not available
	 */
	ensureHSM(): MergeHSM | null {
		if (this._hsm) {
			return this._hsm;
		}

		const mergeManager = this.sharedFolder?.mergeManager;
		if (!mergeManager) {
			return null;
		}

		// Create HSM using factory
		this._hsm = mergeManager.createHSM({
			guid: this.guid,
			getPath: () => this.path,
			remoteDoc: this.isRemoteDocLoaded ? this.ydoc : null,
			getDiskContent: () => this.readDiskContent(),
			getPersistenceMetadata: () => ({
				path: this.path,
				relay: this.sharedFolder.relayId || "",
				appId: this.sharedFolder.appId,
				s3rn: this.s3rn ? S3RN.encode(this.s3rn) : "",
			}),
		});

		// Subscribe to effects
		this._hsm.subscribe((effect) => {
			this.handleEffect(effect);
		});

		// Subscribe to state changes for sync status updates
		this._hsm.onStateChange(() => {
			mergeManager.updateSyncStatus(this.guid, this._hsm!.getSyncStatus());
		});

		// Notify MergeManager for hibernation tracking
		mergeManager.notifyHSMCreated(this.guid);

		return this._hsm;
	}

	/**
	 * Create the remote YDoc, populating it from localDoc if available.
	 * This ensures the remoteDoc has content for provider sync even when
	 * content was enrolled into localDoc (e.g., via initializeWithContent).
	 */
	ensureRemoteDoc(): Y.Doc {
		const isNew = !this.isRemoteDocLoaded;
		const doc = super.ensureRemoteDoc();
		if (isNew && this._hsm) {
			const localDoc = this._hsm.getLocalDoc();
			if (localDoc) {
				const update = Y.encodeStateAsUpdate(localDoc);
				Y.applyUpdate(doc, update);
			}
		}
		return doc;
	}

	/**
	 * Acquire lock on this document for active editing.
	 * Transitions HSM from idle to active mode.
	 * Call this when editor opens (replaces userLock = true).
	 *
	 * @param editorContent - The current editor/disk content (required in v6).
	 *   Since the editor content equals the disk content when a file is first
	 *   opened (before CRDT loads), this provides accurate disk content for
	 *   merge operations. Pass the content from the editor or read from disk.
	 * @returns The MergeHSM instance, or null if HSM is not enabled
	 */
	async acquireLock(editorContent?: string, editorViewRef?: EditorViewRef): Promise<MergeHSM | null> {
		const mergeManager = this.sharedFolder.mergeManager;
		if (!mergeManager || !this._hsm) {
			this.userLock = true; // Fallback if MergeManager/HSM not available
			return null;
		}

		try {
			// v6: If editorContent not provided, read from disk (fallback for backward compatibility)
			let content = editorContent;
			if (content === undefined) {
				const tfile = this.tfile;
				if (tfile) {
					content = await this.vault.read(tfile);
				} else {
					content = "";  // New file, no content yet
				}
			}

			// Ensure remoteDoc and provider exist before entering active mode.
			// This wakes the document from hibernation if needed.
			const remoteDoc = this.ensureRemoteDoc();
			this._hsm.setRemoteDoc(remoteDoc);

			// Send ACQUIRE_LOCK with editorContent to transition from idle to active.
			// Always send (don't guard with isLoaded) because releaseLock() doesn't await
			// unload(), so activeDocs may not be cleared when file is quickly reopened.
			// The HSM handles duplicate ACQUIRE_LOCK gracefully (no-op if already active).
			this._hsm.send({ type: "ACQUIRE_LOCK", editorContent: content, editorViewRef });
			mergeManager.markActive(this.guid);

			// Create ProviderIntegration BEFORE awaiting so it can deliver
			// PROVIDER_SYNCED during the entering phase (needed for empty-IDB flow).
			if (!this._providerIntegration) {
				this._providerIntegration = new ProviderIntegration(
					this._hsm,
					remoteDoc,
					this._provider! as YjsProvider
				);
			}

			// Wait for HSM to reach a post-entering active state
			await this._hsm.awaitActive();

			// Guard against race: releaseLock() may have been called while we
			// were awaiting. If so, the HSM has already transitioned back to idle
			// and we must not keep a ProviderIntegration (it would leak).
			if (!this.userLock && !mergeManager.isActive(this.guid)) {
				this._providerIntegration.destroy();
				this._providerIntegration = null;
				return null;
			}

			this.userLock = true; // Keep for compatibility

			return this._hsm;
		} catch (e) {
			this.warn("[acquireLock] Failed to acquire HSM lock:", e);
			this.userLock = true; // Fallback
			return null;
		}
	}

	/**
	 * Release lock on this document.
	 * Transitions HSM from active back to idle mode.
	 * Call this when editor closes (replaces userLock = false).
	 */
	releaseLock(): void {
		this.userLock = false; // Keep for compatibility

		// Destroy ProviderIntegration (unsubscribes from events)
		if (this._providerIntegration) {
			this._providerIntegration.destroy();
			this._providerIntegration = null;
		}

		// Guard: sharedFolder may be null if document was orphaned (file moved out of folder)
		const mergeManager = this.sharedFolder?.mergeManager;
		if (mergeManager) {
			// MergeManager.unload() sends RELEASE_LOCK
			mergeManager.unload(this.guid);
		}
	}

	/**
	 * Get the HSM sync status for this document.
	 * Returns the status if HSM is available, or null otherwise.
	 * This can be used instead of checkStale() when HSM is enabled.
	 */
	getHSMSyncStatus(): import("./merge-hsm/types").SyncStatus | null {
		const mergeManager = this.sharedFolder?.mergeManager;
		if (!mergeManager) {
			return null;
		}
		return mergeManager.syncStatus.get(this.guid) ?? null;
	}

	/**
	 * Check if the document has a conflict according to HSM.
	 * Returns true if HSM indicates a conflict, false if synced/pending,
	 * or null if HSM is not available.
	 */
	hasHSMConflict(): boolean | null {
		const status = this.getHSMSyncStatus();
		if (!status) {
			return null;
		}
		return status.status === "conflict";
	}

	public get tfile(): TFile | null {
		if (!this._tfile) {
			this._tfile = this.getTFile();
		}
		return this._tfile;
	}

	getTFile(): TFile | null {
		return this._parent?.getTFile(this);
	}

	public get ytext(): Y.Text {
		return this.ydoc.getText("contents");
	}

	public get text(): string {
		if (!this.ytext) {
			return "";
		}
		return this.ytext.toString();
	}

	// ===========================================================================
	// HSM-aware accessors (localDoc only - no fallback to remoteDoc)
	// ===========================================================================

	/**
	 * Get the HSM's localDoc when available (active mode only).
	 * Returns null when HSM is not in active mode or not available.
	 *
	 * IMPORTANT: All editor operations should use localDoc, not ydoc (remoteDoc).
	 * Writing to ydoc directly causes corruption.
	 */
	public get localDoc(): Y.Doc | null {
		return this._hsm?.getLocalDoc() ?? null;
	}

	/**
	 * Get the Y.Text from HSM's localDoc.
	 * @throws Error if HSM is not in active mode (no localDoc available)
	 */
	public get localYText(): Y.Text {
		const doc = this.localDoc;
		if (!doc) {
			throw new Error(
				`Document ${this.path}: Cannot access localYText - HSM not in active mode.`
			);
		}
		return doc.getText("contents");
	}

	/**
	 * Get text content from HSM's localDoc.
	 * @throws Error if HSM is not in active mode (no localDoc available)
	 */
	public get localText(): string {
		return this.localYText.toString();
	}

	/**
	 * Get the YDoc that should be used for write operations.
	 * Returns localDoc when in active mode, throws when HSM not in active mode.
	 *
	 * IMPORTANT: Writing to ydoc (remoteDoc) directly causes corruption.
	 * All write operations must go through this method or the HSM.
	 *
	 * @throws Error if HSM is not in active mode (no localDoc available)
	 */
	public getWritableDoc(): Y.Doc {
		const localDoc = this.localDoc;
		if (!localDoc) {
			throw new Error(
				`Document ${this.path}: Cannot write - HSM not in active mode. ` +
				`Writing to ydoc (remoteDoc) directly causes corruption.`
			);
		}
		return localDoc;
	}

	/**
	 * Check if the document is in a writable state (HSM active mode).
	 */
	public get isWritable(): boolean {
		return this.localDoc !== null;
	}

	async connect(): Promise<boolean> {
		if (this.sharedFolder.s3rn instanceof S3Folder) {
			// Local only
			return false;
		} else if (this.s3rn instanceof S3Document) {
			// convert to remote document
			if (this.sharedFolder.relayId) {
				this.s3rn = new S3RemoteDocument(
					this.sharedFolder.relayId,
					this.sharedFolder.guid,
					this.guid,
				);
			} else {
				this.s3rn = new S3Document(this.sharedFolder.guid, this.guid);
			}
		}
		return (
			this.sharedFolder.shouldConnect &&
			this.sharedFolder.connect().then((connected) => {
				return super.connect();
			})
		);
	}

	public get ready(): boolean {
		if (!this._persistence) return this.synced;
		return this._persistence.isReady(this.synced);
	}

	hasLocalDB(): boolean {
		if (!this._persistence) return false;
		return this._persistence.hasServerSync || this._persistence.hasUserData();
	}

	async awaitingUpdates(): Promise<boolean> {
		await this.whenSynced();
		await this.getServerSynced();
		if (this._awaitingUpdates !== undefined) {
			return this._awaitingUpdates;
		}
		// If folder has synced with server (or is authoritative, which sets serverSynced), we don't need to wait
		const folderServerSynced = await this.sharedFolder.getServerSynced();
		if (folderServerSynced) {
			this._awaitingUpdates = false;
			return false;
		}
		this._awaitingUpdates = !this.hasLocalDB();
		return this._awaitingUpdates;
	}

	async whenReady(): Promise<Document> {
		const promiseFn = async (): Promise<Document> => {
			const awaitingUpdates = await this.awaitingUpdates();
			if (awaitingUpdates) {
				// If this is a brand new shared folder, we want to wait for a connection before we start reserving new guids for local files.
				this.log("awaiting updates");
				this.connect();
				await this.onceConnected();
				this.log("connected");
				await this.onceProviderSynced();
				this.log("synced");
				return this;
			}
			return this;
		};
		this.readyPromise =
			this.readyPromise ||
			new Dependency<Document>(promiseFn, (): [boolean, Document] => {
				return [this.ready, this];
			});
		return this.readyPromise.getPromise();
	}

	whenSynced(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			await this.sharedFolder.whenSynced();

			return new Promise<void>((resolve) => {
				if (this.persistenceSynced) {
					resolve();
					return;
				}

				if (!this._persistence) {
					this.persistenceSynced = true;
					resolve();
					return;
				}

				this._persistence.once("synced", () => {
					this.persistenceSynced = true;
					resolve();
				});
			});
		};

		this.whenSyncedPromise =
			this.whenSyncedPromise ||
			new Dependency<void>(promiseFn, (): [boolean, void] => {
				return [this.persistenceSynced, undefined];
			});
		return this.whenSyncedPromise.getPromise();
	}

	async hasKnownPeers(): Promise<boolean> {
		await this.whenSynced();
		return this.hasLocalDB();
	}

	public get mimetype(): string {
		return getMimeType(this.path);
	}

	async save() {
		if (!this.tfile) {
			return;
		}
		if (this.sharedFolder.isPendingDelete(this.path)) {
			this.warn("skipping save for pending delete", this.path);
			return;
		}

		// Mark that we're saving to distinguish from external modifications
		this._isSaving = true;
		try {
			const contents = this.text;
			await this.vault.modify(this.tfile, contents);
			this.warn("file saved", this.path);

			// Notify HSM of save completion with new mtime and hash
			if (this._hsm && this.tfile) {
				const mtime = this.tfile.stat.mtime;
				const encoder = new TextEncoder();
				const hash = await generateHash(encoder.encode(contents).buffer);
				this._hsm.send({ type: "SAVE_COMPLETE", mtime, hash });
			}
		} finally {
			this._isSaving = false;
		}
	}

	/**
	 * Check if the document is currently being saved by us.
	 * Used to distinguish our writes from external modifications.
	 */
	get isSaving(): boolean {
		return this._isSaving;
	}

	requestSave = debounce(this.save, 2000);

	async markSynced(): Promise<void> {
		if (!this._persistence) return;
		await this._persistence.markServerSynced();
	}

	async getServerSynced(): Promise<boolean> {
		if (!this._persistence) return false;
		return this._persistence.getServerSynced();
	}

	static checkExtension(vpath: string): boolean {
		return vpath.endsWith(".md");
	}

	destroy() {
		this.unsubscribes.forEach((unsubscribe) => {
			unsubscribe();
		});

		// Release HSM lock if held
		if (this._hsm) {
			this.releaseLock();
		}

		super.destroy();
		// Note: super.destroy() calls destroyRemoteDoc() which handles ydoc cleanup.
		// Do NOT call this.ydoc.destroy() here — it would trigger lazy creation.
		this.whenSyncedPromise?.destroy();
		this.whenSyncedPromise = null as any;
		this.readyPromise?.destroy();
		this.readyPromise = null as any;
		this._parent = null as any;
	}

	public async read(): Promise<string> {
		return this.text;
	}

	public async cleanup(): Promise<void> {
		this.sharedFolder?.mergeManager?.notifyHSMDestroyed(this.guid);
	}

	// Helper method to update file stats
	private updateStats(): void {
		this.stat.mtime = Date.now();
		// Only access text if remoteDoc is loaded (avoid triggering lazy creation)
		if (this.isRemoteDocLoaded) {
			this.stat.size = this.text.length;
		}
	}

	// ===========================================================================
	// HSM Effect Handling
	// ===========================================================================

	/**
	 * Read current disk content for the HSM.
	 * Used as diskLoader callback when creating HSM.
	 */
	async readDiskContent(): Promise<{ content: string; hash: string; mtime: number }> {
		const tfile = this.tfile;
		if (!tfile) {
			throw new Error(`[Document] Cannot read disk content for ${this.path}: TFile not found`);
		}
		const content = await this.vault.read(tfile);
		const encoder = new TextEncoder();
		const hash = await generateHash(encoder.encode(content).buffer);
		return { content, hash, mtime: tfile.stat.mtime };
	}

	/**
	 * Handle effects emitted by the HSM.
	 * Called by HSM subscriber in ensureHSM().
	 */
	async handleEffect(effect: import("./merge-hsm/types").MergeEffect): Promise<void> {
		switch (effect.type) {
			case "WRITE_DISK":
				await this.handleWriteDisk(effect.contents);
				break;
			case "PERSIST_STATE":
				await this.handlePersistState(effect.state);
				break;
			case "SYNC_TO_REMOTE":
				await this.handleSyncToRemote(effect.update);
				break;
			// Other effects (DISPATCH_CM6, STATUS_CHANGED, etc.) are handled elsewhere
		}
	}

	private async handleWriteDisk(contents: string): Promise<void> {
		const tfile = this.tfile;
		if (!tfile) {
			this.warn("[handleEffect:WRITE_DISK] TFile not found, cannot write");
			return;
		}
		if (this.sharedFolder.isPendingDelete(this.path)) {
			this.warn("[handleEffect:WRITE_DISK] Skipping write for pending delete", this.path);
			return;
		}

		this._isSaving = true;
		try {
			await this.vault.modify(tfile, contents);
			this.debug?.("[handleEffect:WRITE_DISK] Wrote to disk", this.path);

			// Notify HSM of save completion with new mtime and hash
			if (this._hsm) {
				const encoder = new TextEncoder();
				const hash = await generateHash(encoder.encode(contents).buffer);
				this._hsm.send({ type: "SAVE_COMPLETE", mtime: tfile.stat.mtime, hash });
			}
		} finally {
			this._isSaving = false;
		}
	}

	private async handlePersistState(state: import("./merge-hsm/types").PersistedMergeState): Promise<void> {
		const mergeManager = this.sharedFolder?.mergeManager;
		if (!mergeManager) return;

		// Update LCA cache in MergeManager
		if (state.lca) {
			mergeManager.setLCA(this.guid, {
				contents: state.lca.contents,
				meta: { hash: state.lca.hash, mtime: state.lca.mtime },
				stateVector: state.lca.stateVector,
			});
		} else {
			mergeManager.setLCA(this.guid, null);
		}
	}

	private async handleSyncToRemote(update: Uint8Array): Promise<void> {
		// Skip if document is in active mode - ProviderIntegration handles it
		if (this.userLock || this.sharedFolder?.mergeManager?.isActive(this.guid)) {
			return;
		}

		// Apply update to remoteDoc (intentionally triggers lazy creation / wake from hibernation)
		const remoteDoc = this.ensureRemoteDoc();
		Y.applyUpdate(remoteDoc, update, "idle-sync");
	}

}
