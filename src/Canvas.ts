import type { TFile, Vault } from "obsidian";
import { HasProvider } from "./HasProvider";
import type { HasMimeType, IFile } from "./IFile";
import type { LoginManager } from "./LoginManager";
import { S3Canvas, S3Folder, S3RN, S3RemoteCanvas } from "./S3RN";
import * as Y from "yjs";
import type { SharedFolder } from "./SharedFolder";
import { getMimeType } from "./mimetypes";
import { IndexeddbPersistence } from "y-indexeddb";
import * as idb from "lib0/indexeddb";
import { Dependency } from "./promiseUtils";
import type { Unsubscriber } from "./observable/Observable";
import type {
	CanvasData,
	CanvasEdgeData,
	CanvasNodeData,
	CanvasView,
} from "./CanvasView";
import { areObjectsEqual } from "./areObjectsEqual";
import { flags } from "./flagManager";

export function isCanvas(file?: IFile): file is Canvas {
	return file instanceof Canvas;
}

export class Canvas extends HasProvider implements IFile, HasMimeType {
	_dbsize?: number;
	private _parent: SharedFolder;
	private _persistence: IndexeddbPersistence;
	whenSyncedPromise: Dependency<void> | null = null;
	persistenceSynced: boolean = false;
	readyPromise?: Dependency<Canvas>;
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
			this._persistence = new IndexeddbPersistence(key, this.ydoc);
		} catch (e) {
			this.warn("Unable to open persistence.", this.guid);
			console.error(e);
			throw e;
		}

		this.whenSynced().then(() => {
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
					await this.onceProviderSynced();
					await this.markSynced();
				}
				this.sharedFolder.markUploaded(this);
			})();
		});

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

	_serverSynced?: boolean;
	async markSynced(): Promise<void> {
		this._serverSynced = true;
		await this._persistence.set("serverSync", 1);
	}
	async getServerSynced(): Promise<boolean> {
		if (this._serverSynced !== undefined) {
			return this._serverSynced;
		}
		const serverSync = await this._persistence.get("serverSync");
		if (serverSync === 1) {
			this._serverSynced = true;
			return this._serverSynced;
		}
		return false;
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

	async count(): Promise<number> {
		// XXX this is to workaround the y-indexeddb not counting records until after the synced event
		if (this._persistence.db === null) {
			throw new Error("database not ready yet");
		}
		if (this._dbsize) {
			return this._dbsize;
		}
		if (this._persistence._dbsize > 3) {
			this._dbsize = this._persistence._dbsize;
			return this._dbsize;
		}
		const [updatesStore] = idb.transact(
			this._persistence.db,
			["updates"],
			"readonly",
		);
		const cnt = await idb.count(updatesStore);
		this._dbsize = cnt;
		return this._dbsize;
	}

	public get dbsize() {
		if (!this._dbsize) {
			throw new Error("dbsize accessed before count");
		}
		return this._persistence._dbsize === 0 && this._dbsize
			? this._dbsize
			: this._persistence._dbsize;
	}

	public get ready(): boolean {
		const persistenceSynced = this._persistence.synced;
		return (
			persistenceSynced &&
			(this.synced || !!this._serverSynced || this._origin === "local")
		);
	}

	hasLocalDB() {
		return (
			!!this._serverSynced ||
			this._persistence._dbsize > 3 ||
			!!(this._dbsize && this._dbsize > 3)
		);
	}

	async awaitingUpdates(): Promise<boolean> {
		await this.whenSynced();
		await this.getServerSynced();
		if (!this._awaitingUpdates) {
			return false;
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
			new Dependency<Canvas>(promiseFn, (): [boolean, Canvas] => {
				return [this.ready, this];
			});
		return this.readyPromise.getPromise();
	}

	whenSynced(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			await this.sharedFolder.whenSynced();
			// Check if already synced first
			if (this._persistence.synced && !this.persistenceSynced) {
				await this.count();
				this.persistenceSynced = true;
				return Promise.resolve();
			}

			return new Promise<void>((resolve) => {
				if (this.persistenceSynced) {
					resolve();
				}
				this._persistence.once("synced", async () => {
					await this.count();
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

	public get sharedFolder(): SharedFolder {
		return this._parent;
	}

	static checkExtension(vpath: string): boolean {
		return vpath.endsWith(".canvas") && flags().enableCanvasSync;
	}

	private _origin?: string;

	async markOrigin(origin: "local" | "remote"): Promise<void> {
		this._origin = origin;
		await this._persistence.set("origin", origin);
	}

	async getOrigin(): Promise<"local" | "remote" | undefined> {
		if (this._origin !== undefined) {
			return this._origin as "local" | "remote";
		}
		this._origin = await this._persistence.get("origin");
		return this._origin as "local" | "remote" | undefined;
	}

	async applyJSON(json: string) {
		const data = JSON.parse(json);
		return await this.applyData(data);
	}

	async importFromView(view: CanvasView) {
		if (
			view.file &&
			this.sharedFolder.getVirtualPath(view.file.path) === this.path
		) {
			return await this.applyData(view.canvas.getData());
		} else {
			console.warn("tried to apply updates from another file", this.path);
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

		data.nodes.forEach((node: CanvasNodeData) => {
			seen.add(node.id);
			const ynode = ynodes.get(node.id);
			if (!ynode) {
				changed_nodes.set(node.id, node);
				this.textNode(node);
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
			deleted_edges.size > 0
		) {
			Y.transact(
				this.ydoc,
				() => {
					for (const node of changed_nodes.values()) {
						this.ynodes.set(node.id, node);
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

	move(newPath: string) {
		this.path = newPath;
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
		this.unsubscribes.forEach((unsubscribe) => {
			unsubscribe();
		});
		super.destroy();
		this.ydoc.destroy();
		this.whenSyncedPromise?.destroy();
		this.whenSyncedPromise = null as any;
		this.readyPromise?.destroy();
		this.readyPromise = null as any;
	}
}
