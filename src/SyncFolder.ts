"use strict";
import type { SharedFolder } from "./SharedFolder";
import { HasLogging } from "./debug";
import { type Vault, TFolder } from "obsidian";
import type { Unsubscriber } from "./observable/Observable";
import { uuidv4 } from "lib0/random";
import type { IFile } from "./IFile";
import { DestroyedError, isDestroyedError } from "./DestroyedError";

export function isSyncFolder(folder: IFile): folder is SyncFolder {
	return folder instanceof SyncFolder;
}

export class SyncFolder extends HasLogging implements IFile {
	private _parent: SharedFolder;
	private destroyed = false;
	name: string;
	synctime: number;
	vault: Vault;
	/** Whether the vault index holds a directory at this path. */
	get ready(): boolean {
		return (
			!this.destroyed &&
			!this._parent.destroyed &&
			this._parent.getAbstractFile(this.path) instanceof TFolder
		);
	}
	createPromise: Promise<TFolder> | null = null;
	connected: boolean = true;
	offFolderStatusListener: Unsubscriber;

	constructor(
		public path: string,
		public guid: string,
		parent: SharedFolder,
	) {
		super();
		this._parent = parent;
		this.name = this.path.split("/").pop() || "";
		this.vault = this._parent.vault;
		this.synctime = 0;
		this.setLoggers(`[SyncFolder](${this.path})`);
		if (!this.ready) {
			if (this._parent.isPendingDelete(path)) {
				this.warn("skipping folder creation for pending delete", path);
			} else {
				// Through the folder's disk boundary, which refuses a directory
				// the disk reaches through another spelling and accepts one
				// another writer finished first.
				const indexed = (): TFolder | null => {
					if (this.destroyed || parent.destroyed) {
						throw new DestroyedError("SyncFolder", path);
					}
					const folder = parent.getAbstractFile(path);
					return folder instanceof TFolder ? folder : null;
				};
				this.createPromise = parent
					.mkdir(path)
					.then(() => {
						const folder = indexed();
						if (!folder) throw new Error("the directory is not indexed after creation");
						return folder;
					})
					.catch((error: unknown) => {
						const folder = indexed();
						if (folder) return folder;
						throw error;
					});
			}
		}
		this.offFolderStatusListener = this._parent.subscribe(
			this.path,
			(state) => {
				if (state.intent === "disconnected") {
					this.disconnect();
				}
			},
		);
		void (async () => {
			if (this.createPromise) {
				await this.createPromise;
			}
			if (this.ready && this.sharedFolder === parent && this.path === path) {
				await parent.markUploaded(this);
			}
		})().catch((error: unknown) => {
			if (!isDestroyedError(error)) {
				this.warn("folder materialization failed", path, error);
			}
		});
		this.log("created");
	}

	static fromTFolder(sharedFolder: SharedFolder, tfolder: TFolder) {
		console.debug(
			"virtualpath for new syncfolder",
			sharedFolder.getVirtualPath(tfolder.path),
		);
		return new SyncFolder(
			sharedFolder.getVirtualPath(tfolder.path),
			uuidv4(),
			sharedFolder,
		);
	}

	disconnect() {
		this.connected = false;
	}

	move(newPath: string, sharedFolder: SharedFolder) {
		if (newPath === this.path) {
			return;
		}
		this._parent = sharedFolder;
		this.log("setting new path", newPath);
		this.path = newPath;
		this.name = newPath.split("/").pop() || "";
		this.setLoggers(`[SharedFolder](${this.path})`);
	}

	public get tfolder(): TFolder {
		const abstractFile = this.sharedFolder.getAbstractFile(this.path);
		if (abstractFile instanceof TFolder) {
			return abstractFile;
		}
		throw new Error("TFolder API used before file existed");
	}

	public get parent(): TFolder | null {
		return this.tfolder?.parent || null;
	}

	public get sharedFolder(): SharedFolder {
		return this._parent;
	}

	async connect(): Promise<boolean> {
		return (
			this.sharedFolder.shouldConnect &&
			this.sharedFolder.connect().then((connected) => {
				this.connected = true;
				return this.connected;
			})
		);
	}

	public async delete(): Promise<void> {
		return this.sharedFolder.trashFile(this.tfolder);
	}

	public cleanup() {}

	destroy() {
		this.destroyed = true;
		this.offFolderStatusListener?.();
		this.offFolderStatusListener = null as unknown as typeof this.offFolderStatusListener;
		this._parent = null as unknown as typeof this._parent;
	}
}
