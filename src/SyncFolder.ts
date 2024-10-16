"use strict";
import { SharedFolder } from "./SharedFolder";
import { HasLogging } from "./debug";
import { type Vault, TFolder } from "obsidian";
import type { Unsubscriber } from "./observable/Observable";
import type { RelayManager } from "./RelayManager";
import { uuidv4 } from "lib0/random";
import type { IFile } from "./IFile";

export class SyncFolder extends HasLogging implements IFile {
	private _parent: SharedFolder;
	_tfolder: TFolder | null = null;
	name: string;
	synctime: number;
	vault: Vault;
	ready: boolean = false;
	connected: boolean = true;
	offFolderStatusListener: Unsubscriber;

	constructor(
		public path: string,
		public guid: string,
		private relayManager: RelayManager,
		parent: SharedFolder,
	) {
		super();
		this._parent = parent;
		this.name = this.path.split("/").pop() || "";
		this.vault = this._parent.vault;
		const tfolder = this.vault.getAbstractFileByPath(
			this.sharedFolder.getPath(path),
		);
		if (tfolder instanceof TFolder) {
			this._tfolder = tfolder;
		} else {
			this.vault.createFolder(this.sharedFolder.getPath(path));
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
		this.log("created");
	}

	static fromTFolder(
		relayManager: RelayManager,
		sharedFolder: SharedFolder,
		tfolder: TFolder,
	) {
		console.log(
			"virtualpath for new syncfolder",
			sharedFolder.getVirtualPath(tfolder.path),
		);
		return new SyncFolder(
			sharedFolder.getVirtualPath(tfolder.path),
			uuidv4(),
			relayManager,
			sharedFolder,
		);
	}

	disconnect() {
		this.connected = false;
	}

	move(newPath: string) {
		if (newPath === this.path) {
			return;
		}
		this.warn("setting new path", newPath);
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

	public async rename(newPath: string): Promise<void> {
		this.move(newPath);
	}

	public async delete(): Promise<void> {
		return this.vault.delete(this.tfolder);
	}

	destroy() {
		this.offFolderStatusListener?.();
		this.offFolderStatusListener = null as any;
		this._parent = null as any;
		this.relayManager = null as any;
		this._tfolder = null as any;
	}
}
