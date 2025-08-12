"use strict";
import { SharedFolder } from "./SharedFolder";
import { HasLogging } from "./debug";
import { type Vault, TFolder } from "obsidian";
import type { Unsubscriber } from "./observable/Observable";
import type { RelayManager } from "./RelayManager";
import { uuidv4 } from "lib0/random";
import type { IFile } from "./IFile";

export function isSyncFolder(folder: IFile): folder is SyncFolder {
	return folder instanceof SyncFolder;
}

export class SyncFolder extends HasLogging implements IFile {
	private _parent: SharedFolder;
	_tfolder: TFolder | null = null;
	name: string;
	synctime: number;
	vault: Vault;
	ready: boolean = false;
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
		const fromVault = () => {
			const tfolder = this.vault.getAbstractFileByPath(
				this.sharedFolder.getPath(path),
			);
			if (tfolder instanceof TFolder) {
				this._tfolder = tfolder;
				this.ready = true;
				return true;
			}
			return false;
		};
		if (!fromVault()) {
			this.createPromise = this.vault.createFolder(
				this.sharedFolder.getPath(path),
			);
			this.createPromise
				.then((tfolder) => {
					this._tfolder = tfolder;
					this.ready = true;
				})
				.catch(() => {
					// folder exists, retry
					fromVault();
				});
		}
		this.synctime = 0;
		this.setLoggers(`[SyncFolder](${this.path})`);
		this.offFolderStatusListener = this._parent.subscribe(
			this.path,
			(state) => {
				if (state.intent === "disconnected") {
					this.disconnect();
				}
			},
		);
		(async () => {
			if (this.createPromise) {
				await this.createPromise;
			}
			parent.markUploaded(this);
		})();
		this.log("created");
	}

	static fromTFolder(sharedFolder: SharedFolder, tfolder: TFolder) {
		console.log(
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
		const abstractFile = this.vault.getAbstractFileByPath(
			this.sharedFolder.getPath(this.path),
		);
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
		return this.vault.delete(this.tfolder);
	}

	public cleanup() {}

	destroy() {
		this.offFolderStatusListener?.();
		this.offFolderStatusListener = null as any;
		this._parent = null as any;
		this._tfolder = null as any;
	}
}
