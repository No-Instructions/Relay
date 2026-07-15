import type { TFile, Vault } from "obsidian";
import { HasProvider } from "./HasProvider";
import type { HasMimeType, IFile } from "./IFile";
import type { LoginManager } from "./LoginManager";
import { S3Canvas, S3Folder, S3RN, S3RemoteCanvas } from "./S3RN";
import { snapshotFromDoc } from "./merge-hsm/state-vectors";
import * as Y from "yjs";
import type { SharedFolder } from "./SharedFolder";
import { getMimeType } from "./mimetypes";
import { IndexeddbPersistence } from "./storage/y-indexeddb";
import { Dependency } from "./promiseUtils";
import { trackAsyncCleanup } from "./reloadUtils";
import type { Unsubscriber } from "./observable/Observable";
import { DocumentDestroyedError } from "./DocumentDestroyedError";
import type {
	CanvasData,
	CanvasEdgeData,
	CanvasNodeData,
	CanvasView,
} from "./CanvasView";
import { areObjectsEqual } from "./areObjectsEqual";
import { trackPromise } from "./trackPromise";
import { formatCanvasData } from "./CanvasData";
import {
	CanvasDocBridge,
	CanvasHSM,
	CANVAS_BRIDGE_IN_ORIGIN,
} from "./canvas-hsm";
import type { CanvasEffect } from "./canvas-hsm";

export function isCanvas(file?: IFile | null): file is Canvas {
	return file instanceof Canvas;
}

function replaceYTextContent(ytext: Y.Text, nextText: string): void {
	const currentText = ytext.toString();
	if (currentText === nextText) return;

	let prefixLength = 0;
	const maxPrefixLength = Math.min(currentText.length, nextText.length);
	while (
		prefixLength < maxPrefixLength &&
		currentText[prefixLength] === nextText[prefixLength]
	) {
		prefixLength++;
	}

	let suffixLength = 0;
	const maxSuffixLength = maxPrefixLength - prefixLength;
	while (
		suffixLength < maxSuffixLength &&
		currentText[currentText.length - 1 - suffixLength] ===
			nextText[nextText.length - 1 - suffixLength]
	) {
		suffixLength++;
	}

	const deleteLength = currentText.length - prefixLength - suffixLength;
	if (deleteLength > 0) {
		ytext.delete(prefixLength, deleteLength);
	}

	const insertedText = nextText.slice(
		prefixLength,
		nextText.length - suffixLength,
	);
	if (insertedText.length > 0) {
		ytext.insert(prefixLength, insertedText);
	}
}

export class Canvas extends HasProvider implements IFile, HasMimeType {
	private _parent: SharedFolder;
	private _persistenceInstance: IndexeddbPersistence | null = null;
	private _localDoc: Y.Doc | null = null;
	readonly hsm: CanvasHSM;
	private _bridge: CanvasDocBridge | null = null;
	private _materialized = false;
	private _materialUnsubs: Unsubscriber[] = [];
	private _docChangedTimer: number | null = null;
	private _pendingDocChangeOrigin: "bridge" | "ingest" | "unknown" =
		"unknown";
	private _viewReconciler: (() => void) | null = null;
	private _localOnly = false;
	/** Manager hook: warm-slot accounting on lazy materialization. */
	onMaterialize: (() => void) | null = null;

	/**
	 * The vault-facing replica: views, disk ingestion, and export all read
	 * and write here, and the existing relay-canvas database persists it.
	 * HasProvider's ydoc is the provider-facing remoteDoc; the
	 * CanvasDocBridge is the sole conduit between the two. Access
	 * materializes a hibernated canvas — any code path that touches
	 * content transparently wakes it.
	 */
	get localDoc(): Y.Doc {
		this.materialize();
		return this._localDoc!;
	}

	private get _persistence(): IndexeddbPersistence {
		this.materialize();
		return this._persistenceInstance!;
	}

	get isMaterialized(): boolean {
		return this._materialized;
	}
	whenSyncedPromise: Dependency<void> | null = null;
	persistenceSynced: boolean = false;
	readyPromise?: Dependency<Canvas>;
	path: string;
	_tfile: TFile | null;
	name: string;
	userLock: boolean = false;
	destroyed: boolean = false;
	extension: string;
	basename: string;
	vault: Vault;
	stat: {
		ctime: number;
		mtime: number;
		size: number;
	};
	unsubscribes: Unsubscriber[] = [];
	private _awaitingUpdates: any;
	private _canvas: any;

	constructor(
		path: string,
		guid: string,
		loginManager: LoginManager,
		parent: SharedFolder,
	) {
		const s3rn = parent.relayId
			? new S3RemoteCanvas(parent.relayId, parent.guid, guid)
			: new S3Canvas(parent.guid, guid);
		super(guid, s3rn, parent.tokenStore, loginManager);
		this.timeProvider = parent.timeProvider;
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
		this.unsubscribes.push(
			this._parent.subscribe(this.path, (state) => {
				if (state.intent === "disconnected") {
					this.disconnect();
				}
			}),
		);

		this.setLoggers(`[Canvas](${this.path})`);

		this.hsm = new CanvasHSM({
			guid: this.guid,
			folderGuid: parent.guid,
			getPath: () => this.path,
			isMember: () => this.sharedFolder.syncStore.has(this.path),
			readDisk: async () => {
				try {
					const contents = await this.sharedFolder.read(this);
					return {
						contents,
						mtime: this.tfile?.stat.mtime ?? Date.now(),
					};
				} catch (e) {
					return null;
				}
			},
			exportData: () => Canvas.exportCanvasData(this.localDoc),
			formatData: formatCanvasData,
			getLocalSnapshot: () =>
				this._localDoc
					? snapshotFromDoc(this._localDoc).snapshot
					: null,
			onEffect: (effect) => this.executeEffect(effect),
			onTransition: (from, to, eventType) => {
				this.debug(`[hsm] ${from} -> ${to} (${eventType})`);
			},
		});

		this._tfile = null;
	}

	/**
	 * Bring the canvas from its cold shell to the working form: localDoc,
	 * IDB persistence, bridge, update observer, machine hydration, and the
	 * first-sync connect. Idempotent; runs implicitly on any localDoc or
	 * persistence access.
	 */
	materialize(): void {
		if (this._materialized || this.destroyed) return;
		this._materialized = true;

		this._localDoc = new Y.Doc();
		try {
			const key = `${this.sharedFolder.appId}-relay-canvas-${this.guid}`;
			this._persistenceInstance = new IndexeddbPersistence(
				key,
				this._localDoc,
				null,
				null,
				this.timeProvider,
			);
		} catch (e) {
			this.warn("Unable to open persistence.", this.guid);
			console.error(e);
			this._materialized = false;
			this._localDoc.destroy();
			this._localDoc = null;
			throw e;
		}

		this._bridge = new CanvasDocBridge(this._localDoc, this.ydoc, {
			// The localDoc's IDB replay is not local intent; the remoteDoc
			// converges from the server through the provider and reconcile().
			skipOutboundOrigin: (origin) => origin === this._persistenceInstance,
		});
		if (this._localOnly) {
			this._bridge.setLocalOnly(true);
		}

		const localDoc = this._localDoc;
		const onLocalDocUpdate = (_update: Uint8Array, origin: unknown) => {
			if (this.destroyed) return;
			if (origin === this._persistenceInstance) return;
			this.scheduleDocChanged(origin);
		};
		localDoc.on("update", onLocalDocUpdate);
		this._materialUnsubs.push(() => {
			localDoc.off("update", onLocalDocUpdate);
		});

		this.whenSynced()
			.then(() => {
				if (!this._materialized) return;
				this.updateStats();
				try {
					this._persistenceInstance?.set("path", this.path);
					this._persistenceInstance?.set(
						"relay",
						this.sharedFolder.relayId || "",
					);
					this._persistenceInstance?.set("appId", this.sharedFolder.appId);
					this._persistenceInstance?.set("s3rn", S3RN.encode(this.s3rn));
				} catch (e) {
					// pass
				}

				(async () => {
					const state = await this.sharedFolder.loadCanvasState(
						this.guid,
					);
					if (this.destroyed || !this._materialized) return;
					this.hsm.send({ type: "PERSISTENCE_LOADED", state });
				})().catch((e) => this.warn("canvas state load failed", e));

				(async () => {
					const serverSynced = await this.getServerSynced();
					if (!serverSynced) {
						const connected = await this.connect();
						if (!connected) return;
						await trackPromise(`canvasSync:${this.guid}`, this.onceProviderSynced());
						await this.markSynced();
					}
				})().catch((e) => this.warn("canvas provider sync failed", e));
			})
			.catch((e) => this.warn("canvas persistence sync failed", e));

		this.onMaterialize?.();
	}

	/**
	 * Release the working form: destroy the localDoc and its IDB
	 * connection, drop the bridge, and reset the machine to loading (which
	 * frees the resident LCA contents). Refuses while a view is attached,
	 * a download or flush is pending, a doc-change debounce is armed, or
	 * the machine is mid-decision — hibernation is only legal from a
	 * settled posture. The remoteDoc stays, matching document hibernation
	 * (MergeManager detaches but never destroys the provider doc).
	 */
	hibernate(): boolean {
		if (!this._materialized) return true;
		if (this.destroyed) return false;
		if (this.userLock) return false;
		if (this._docChangedTimer != null) return false;
		const snapshot = this.hsm.getSnapshot();
		if (snapshot.userLock || snapshot.downloadPending) return false;
		if (
			snapshot.statePath !== "idle.synced" &&
			snapshot.statePath !== "idle.diverged"
		) {
			return false;
		}

		this._materialized = false;
		this._materialUnsubs.forEach((unsubscribe) => unsubscribe());
		this._materialUnsubs = [];
		this._bridge?.destroy();
		this._bridge = null;
		if (this._persistenceInstance) {
			const p = this._persistenceInstance.destroy().catch(() => {});
			trackAsyncCleanup(p);
			this._persistenceInstance = null;
		}
		this._localDoc?.destroy();
		this._localDoc = null;
		// The memoized readiness promises are bound to the destroyed
		// persistence; the next materialize rebuilds them.
		this.whenSyncedPromise = null;
		this.readyPromise = undefined;
		this.persistenceSynced = false;
		this.hsm.send({ type: "LOAD" });
		return true;
	}

	/**
	 * Provider sync means the remoteDoc mirrors the server; converge the
	 * two replicas. Bridge-applied changes reach the machine through the
	 * localDoc update observer.
	 */
	protected handleProviderSynced(): void {
		this._bridge?.reconcile();
	}

	get isLocalOnly(): boolean {
		return this._localOnly;
	}

	/**
	 * Local-only gates the bridge in both directions; disk convergence
	 * continues untouched (replication policy lives in the bridge, never
	 * in the machine). Applies at materialization for cold canvases.
	 */
	setLocalOnly(value: boolean): void {
		this._localOnly = value;
		this._bridge?.setLocalOnly(value);
	}

	private scheduleDocChanged(origin: unknown): void {
		const kind =
			origin === CANVAS_BRIDGE_IN_ORIGIN
				? "bridge"
				: origin === this
					? "ingest"
					: "unknown";
		this._pendingDocChangeOrigin = kind;
		if (this._docChangedTimer !== null) {
			this.timeProvider.clearTimeout(this._docChangedTimer);
		}
		this._docChangedTimer = this.timeProvider.setTimeout(() => {
			this._docChangedTimer = null;
			this.hsm.send({
				type: "LOCAL_DOC_CHANGED",
				origin: this._pendingDocChangeOrigin,
			});
		}, 1000);
	}

	private executeEffect(effect: CanvasEffect): void {
		switch (effect.type) {
			case "WRITE_DISK": {
				const p = (async () => {
					await this.sharedFolder.flush(this, effect.contents);
					this.hsm.send({
						type: "FLUSH_COMPLETE",
						contents: effect.contents,
						hash: effect.hash,
						mtime: this.tfile?.stat.mtime ?? Date.now(),
					});
				})().catch((e) => {
					this.warn("canvas flush failed", e);
					this.hsm.send({ type: "FLUSH_FAILED", error: e });
				});
				trackPromise(`canvasFlush:${this.guid}`, p);
				return;
			}
			case "RECONCILE_VIEW": {
				try {
					this._viewReconciler?.();
				} catch (e) {
					this.warn("view reconcile failed", e);
				}
				return;
			}
			case "ENQUEUE_DOWNLOAD": {
				const p = this.sharedFolder.backgroundSync
					.enqueueCanvasDownload(this, false)
					.catch(() => {
						this.hsm.send({ type: "DOWNLOAD_FAILED" });
					});
				trackPromise(`canvasDownload:${this.guid}`, p);
				return;
			}
			case "PERSIST_STATE": {
				this.sharedFolder.saveCanvasState(this.guid, effect.state);
				return;
			}
			case "SURFACE_STATUS": {
				this.sharedFolder.notifyListeners();
				return;
			}
		}
	}

	public get yedges(): Y.Map<CanvasEdgeData> {
		return this.localDoc.getMap("edges");
	}

	public get ynodes(): Y.Map<CanvasNodeData> {
		return this.localDoc.getMap("nodes");
	}

	public textNode(node: CanvasNodeData): Y.Text {
		const ytext = this.localDoc.getText(node.id);
		if (ytext.toString() === "") {
			ytext.insert(0, node.text);
		}
		return ytext;
	}

	/** The vault-facing canvas data (the localDoc's export). */
	public exportData(): CanvasData {
		return Canvas.exportCanvasData(this.localDoc);
	}

	static exportCanvasData(ydoc: Y.Doc): CanvasData {
		const yedges = ydoc.getMap<CanvasEdgeData>("edges");
		const ynodes = ydoc.getMap<CanvasNodeData>("nodes");
		const edges = [];
		const nodes = [];
		for (const [, yedge] of yedges.entries()) {
			edges.push({ ...yedge });
		}
		for (const [, ynode] of ynodes.entries()) {
			const ytext = ydoc.getText(ynode.id);
			nodes.push({
				...ynode,
				...{ text: ytext.toString() || ynode.text },
			});
		}
		return { nodes: nodes, edges: edges };
	}

	static exportCanvasMapData(ydoc: Y.Doc): CanvasData {
		const yedges = ydoc.getMap<CanvasEdgeData>("edges");
		const ynodes = ydoc.getMap<CanvasNodeData>("nodes");
		const edges = [];
		const nodes = [];
		for (const [, yedge] of yedges.entries()) {
			edges.push({ ...yedge });
		}
		for (const [, ynode] of ynodes.entries()) {
			nodes.push({ ...ynode });
		}
		return { nodes: nodes, edges: edges };
	}

	async markSynced(): Promise<void> {
		await this._persistence.markServerSynced();
	}
	async getServerSynced(): Promise<boolean> {
		return this._persistence.getServerSynced();
	}

	async connect(): Promise<boolean> {
		if (this.sharedFolder.s3rn instanceof S3Folder) {
			// Local only
			return false;
		} else if (
			this.s3rn instanceof S3Canvas ||
			(this.s3rn instanceof S3RemoteCanvas &&
				this.sharedFolder.relayId !== undefined &&
				this.s3rn.relayId !== this.sharedFolder.relayId)
		) {
			// A local identity converts to remote; a remote identity minted
			// for a previous relay re-derives after the folder moves relays —
			// otherwise the canvas connects to the old relay's room forever.
			if (this.sharedFolder.relayId) {
				this.s3rn = new S3RemoteCanvas(
					this.sharedFolder.relayId,
					this.sharedFolder.guid,
					this.guid,
				);
			} else {
				this.s3rn = new S3Canvas(this.sharedFolder.guid, this.guid);
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
		return this._persistence.isReady(this.synced);
	}

	hasLocalDB(): boolean {
		return this._persistence.hasServerSync || this._persistence.hasUserData();
	}

	async awaitingUpdates(): Promise<boolean> {
		await this.whenSynced();
		await this.getServerSynced();
		if (this._awaitingUpdates !== undefined) {
			return this._awaitingUpdates;
		}
		this._awaitingUpdates = !this.hasLocalDB();
		return this._awaitingUpdates;
	}

	async whenReady(): Promise<Canvas> {
		if (this.destroyed) {
			return Promise.reject(
				new DocumentDestroyedError(this.guid, this.path),
			);
		}
		const promiseFn = async (): Promise<Canvas> => {
			const awaitingUpdates = await this.awaitingUpdates();
			if (awaitingUpdates) {
				// If this is a brand new shared folder, we want to wait for a connection before we start reserving new guids for local files.
				this.log("awaiting updates");
				this.connect();
				await trackPromise(`canvasConnected:${this.guid}`, this.onceConnected());
				this.log("connected");
				await trackPromise(`canvasReady:${this.guid}`, this.onceProviderSynced());
				this.log("idle.synced");
				return this;
			}
			return this;
		};
		this.readyPromise =
			this.readyPromise ||
			new Dependency<Canvas>(promiseFn, (): [boolean, Canvas] => {
				return [!this.destroyed && this.ready, this];
			}, this.timeProvider);
		return trackPromise(`canvas:whenReady:${this.guid}`, this.readyPromise.getPromise());
	}

	whenSynced(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			await this.sharedFolder.whenSynced();
			await this._persistence.whenSynced;
			this.persistenceSynced = true;
		};

		this.whenSyncedPromise =
			this.whenSyncedPromise ||
			new Dependency<void>(promiseFn, (): [boolean, void] => {
				return [this.persistenceSynced, undefined];
			}, this.timeProvider);
		return trackPromise(`canvas:whenSynced:${this.guid}`, this.whenSyncedPromise.getPromise());
	}

	/**
	 * A view took ownership of this canvas (and of its disk file). Safe to
	 * call repeatedly — Obsidian re-attaches views across file switches.
	 */
	acquireLock(): void {
		// P1 wake: a view opening is synchronous and unconditional.
		this.materialize();
		this.userLock = true;
		this.hsm.send({ type: "ACQUIRE_LOCK" });
	}

	/**
	 * Release lock on this canvas.
	 * Transitions HSM from active back to idle mode.
	 * Call this when editor closes.
	 */
	releaseLock(): void {
		this.userLock = false;

		const mergeManager = this.sharedFolder.mergeManager;
		if (mergeManager) {
			mergeManager.unload(this.guid);
		}
		this.hsm.send({ type: "RELEASE_LOCK" });
	}

	/**
	 * The RECONCILE_VIEW executor. CanvasPlugin registers the reconciler
	 * while its patches are installed; without one the effect is a no-op.
	 */
	setViewReconciler(fn: () => void): void {
		this._viewReconciler = fn;
	}

	clearViewReconciler(fn: () => void): void {
		if (this._viewReconciler === fn) {
			this._viewReconciler = null;
		}
	}

	public get sharedFolder(): SharedFolder {
		return this._parent;
	}
	public get tfile(): TFile | null {
		if (!this._tfile) {
			this._tfile = this._parent.getTFile(this);
		}
		return this._tfile;
	}

	static checkExtension(vpath: string): boolean {
		return vpath.endsWith(".canvas");
	}

	async markOrigin(origin: "local" | "remote"): Promise<void> {
		await this._persistence.setOrigin(origin);
	}

	async getOrigin(): Promise<"local" | "remote" | undefined> {
		return this._persistence.getOrigin();
	}

	async applyJSON(json: string) {
		if (json === "") return;
		const data = JSON.parse(json);
		return await this.applyData(data);
	}

	async importFromView(view: CanvasView) {
		if (view.file && view.file === this.tfile) {
			return await this.applyData(view.canvas.getData());
		}
	}

	async applyData(data: CanvasData) {
		const yedges = this.yedges;
		const ynodes = this.ynodes;
		const seen = new Set<string>();

		const changed_nodes = new Map<string, CanvasNodeData>();
		const deleted_nodes = new Set<string>();
		const changed_edges = new Map<string, CanvasEdgeData>();
		const deleted_edges = new Set<string>();
		const changed_text = new Map<string, string>();

		data.nodes.forEach((node: CanvasNodeData) => {
			seen.add(node.id);
			if (node.type === "text" && typeof node.text === "string") {
				const ytext = this.localDoc.getText(node.id);
				if (ytext.toString() !== node.text) {
					changed_text.set(node.id, node.text);
				}
			}
			const ynode = ynodes.get(node.id);
			if (!ynode) {
				changed_nodes.set(node.id, node);
			} else if (!areObjectsEqual(ynode, node)) {
				changed_nodes.set(node.id, node);
			}
		});
		for (const ynode_id of ynodes.keys()) {
			if (!seen.has(ynode_id)) {
				deleted_nodes.add(ynode_id);
			}
		}
		data.edges.forEach((edge: CanvasEdgeData) => {
			seen.add(edge.id);
			const yedge = yedges.get(edge.id);
			if (!yedge) {
				changed_edges.set(edge.id, edge);
			} else if (!areObjectsEqual(yedge, edge)) {
				changed_edges.set(edge.id, edge);
			}
		});
		for (const yedge_id of yedges.keys()) {
			if (!seen.has(yedge_id)) {
				deleted_edges.add(yedge_id);
			}
		}

		if (
			changed_nodes.size > 0 ||
			deleted_nodes.size > 0 ||
			changed_edges.size > 0 ||
			deleted_edges.size > 0 ||
			changed_text.size > 0
		) {
			Y.transact(
				this.localDoc,
				() => {
					for (const node of changed_nodes.values()) {
						this.ynodes.set(node.id, node);
					}
					for (const [node_id, text] of changed_text) {
						replaceYTextContent(this.localDoc.getText(node_id), text);
					}
					for (const node_id of deleted_nodes) {
						this.ynodes.delete(node_id);
					}
					for (const edge of changed_edges.values()) {
						this.yedges.set(edge.id, edge);
					}
					for (const edge_id of deleted_edges) {
						this.yedges.delete(edge_id);
					}
				},
				this,
			);
		}
	}

	move(newPath: string, sharedFolder: SharedFolder) {
		this.path = newPath;
		this._parent = sharedFolder;
		this.name = newPath.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.updateStats();
	}

	public get mimetype(): string {
		return getMimeType(this.path);
	}

	public get json(): string {
		const data = Canvas.exportCanvasData(this.localDoc);
		return formatCanvasData(data);
	}

	public async cleanup(): Promise<void> {}

	// Helper method to update file stats
	private updateStats(): void {
		this.stat.mtime = Date.now();
		this.stat.size = this.json.length;
	}

	destroy() {
		const destroyedError = new DocumentDestroyedError(this.guid, this.path);
		this.destroyed = true;
		// Optional chaining throughout: unit tests construct bare canvases
		// via Object.create(Canvas.prototype), skipping field initializers.
		if (this._docChangedTimer != null) {
			this.timeProvider.clearTimeout(this._docChangedTimer);
			this._docChangedTimer = null;
		}
		this.hsm?.destroy();
		this._bridge?.destroy();
		this._viewReconciler = null;
		this._materialUnsubs?.forEach((unsubscribe) => {
			unsubscribe();
		});
		this._materialUnsubs = [];
		this.unsubscribes.forEach((unsubscribe) => {
			unsubscribe();
		});
		this.whenSyncedPromise?.destroy(destroyedError);
		this.whenSyncedPromise = null as any;
		this.readyPromise?.destroy(destroyedError);
		this.readyPromise = null as any;
		if (this._persistenceInstance) {
			const p = this._persistenceInstance.destroy().catch(() => {});
			trackAsyncCleanup(p);
			this._persistenceInstance = null;
		}
		this._localDoc?.destroy();
		this._localDoc = null;
		super.destroy();
	}
}
