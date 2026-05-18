import type { TFile, Vault } from "obsidian";
import { HasProvider } from "./HasProvider";
import type { HasMimeType, IFile } from "./IFile";
import type { LoginManager } from "./LoginManager";
import { S3Canvas, S3Folder, S3RN, S3RemoteCanvas } from "./S3RN";
import * as Y from "yjs";
import type { SharedFolder } from "./SharedFolder";
import { getMimeType } from "./mimetypes";
import { IndexeddbPersistence } from "./storage/y-indexeddb";
import { Dependency } from "./promiseUtils";
import { trackAsyncCleanup } from "./reloadUtils";
import type { Unsubscriber } from "./observable/Observable";
import type {
	CanvasData,
	CanvasEdgeData,
	CanvasNodeData,
	CanvasView,
} from "./CanvasView";
import { areObjectsEqual } from "./areObjectsEqual";
import { trackPromise } from "./trackPromise";

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
	private _persistence: IndexeddbPersistence;
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
		try {
			const key = `${this.sharedFolder.appId}-relay-canvas-${this.guid}`;
			this._persistence = new IndexeddbPersistence(
				key,
				this.ydoc,
				null,
				null,
				this.timeProvider,
			);
		} catch (e) {
			this.warn("Unable to open persistence.", this.guid);
			console.error(e);
			throw e;
		}

		this.whenSynced()
			.then(() => {
				this.updateStats();
				try {
					this._persistence.set("path", this.path);
					this._persistence.set("relay", this.sharedFolder.relayId || "");
					this._persistence.set("appId", this.sharedFolder.appId);
					this._persistence.set("s3rn", S3RN.encode(this.s3rn));
				} catch (e) {
					// pass
				}

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

		this._tfile = null;
	}

	public get yedges(): Y.Map<CanvasEdgeData> {
		return this.ydoc.getMap("edges");
	}

	public get ynodes(): Y.Map<CanvasNodeData> {
		return this.ydoc.getMap("nodes");
	}

	public textNode(node: CanvasNodeData): Y.Text {
		const ytext = this.ydoc.getText(node.id);
		if (ytext.toString() === "") {
			ytext.insert(0, node.text);
		}
		return ytext;
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
		return { edges: edges, nodes: nodes };
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
		return { edges: edges, nodes: nodes };
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
		} else if (this.s3rn instanceof S3Canvas) {
			// convert to remote document
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
		const promiseFn = async (): Promise<Canvas> => {
			const awaitingUpdates = await this.awaitingUpdates();
			if (awaitingUpdates) {
				// If this is a brand new shared folder, we want to wait for a connection before we start reserving new guids for local files.
				this.log("awaiting updates");
				this.connect();
				await trackPromise(`canvasConnected:${this.guid}`, this.onceConnected());
				this.log("connected");
				await trackPromise(`canvasReady:${this.guid}`, this.onceProviderSynced());
				this.log("synced");
				return this;
			}
			return this;
		};
		this.readyPromise =
			this.readyPromise ||
			new Dependency<Canvas>(promiseFn, (): [boolean, Canvas] => {
				return [this.ready, this];
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
				const ytext = this.ydoc.getText(node.id);
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
				this.ydoc,
				() => {
					for (const node of changed_nodes.values()) {
						this.ynodes.set(node.id, node);
					}
					for (const [node_id, text] of changed_text) {
						replaceYTextContent(this.ydoc.getText(node_id), text);
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
		const data = Canvas.exportCanvasData(this.ydoc);
		return JSON.stringify(data);
	}

	public async cleanup(): Promise<void> {}

	// Helper method to update file stats
	private updateStats(): void {
		this.stat.mtime = Date.now();
		this.stat.size = this.json.length;
	}

	destroy() {
		this.destroyed = true;
		this.unsubscribes.forEach((unsubscribe) => {
			unsubscribe();
		});
		if (this._persistence) {
			const p = this._persistence.destroy().catch(() => {});
			trackAsyncCleanup(p);
		}
		super.destroy();
		this.whenSyncedPromise?.destroy();
		this.whenSyncedPromise = null as any;
		this.readyPromise?.destroy();
		this.readyPromise = null as any;
	}
}
