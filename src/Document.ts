"use strict";
import * as Y from "yjs";
import { IndexeddbPersistence, fetchUpdates } from "y-indexeddb";
import { HasProvider } from "./HasProvider";
import { SharedFolder } from "./SharedFolder";
import { YText } from "yjs/dist/src/internals";
import { curryLog } from "./debug";
import { LoginManager } from "./LoginManager";

export class Document extends HasProvider {
	private _parent: SharedFolder;
	private _persistence: IndexeddbPersistence;
	_hasKnownPeers?: boolean;
	path: string;

	constructor(
		path: string,
		guid: string,
		loginManager: LoginManager,
		parent: SharedFolder
	) {
		super(guid, parent.tokenStore, loginManager);
		this._parent = parent;
		this.path = path;
		this.log = curryLog(`[SharedDoc](${this.path})`);

		this._persistence = new IndexeddbPersistence(this.guid, this.ydoc);

		this.ydoc.on(
			"update",
			(update: Uint8Array, origin: unknown, doc: Y.Doc) => {
				//this.log(`Update from origin`, origin, update);
			}
		);
	}

	move(newPath: string) {
		// XXX: Maybe a document should reference a TFile instead of a path...
		this.path = newPath;
		this.log = curryLog(`[SharedDoc](${this.path})`);
	}

	public get sharedFolder(): SharedFolder {
		return this._parent;
	}

	public get ytext(): YText {
		return this.ydoc.getText("contents");
	}

	public get text(): string {
		return this.ytext.toString();
	}

	connect(): Promise<boolean> {
		return this.sharedFolder.connect().then((connected) => {
			return super.connect();
		});
	}

	public async whenReady(): Promise<Document> {
		const dependencies = [];
		if (!this._persistence.synced) {
			dependencies.push(this.whenSynced());
		}
		if (!this._provider) {
			dependencies.push(this.withActiveProvider());
		}
		return Promise.all(dependencies).then((_) => {
			return this;
		});
	}

	whenSynced(): Promise<void> {
		if (this._persistence.synced) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this._persistence.once("synced", resolve);
		});
	}

	hasKnownPeers(): Promise<boolean> {
		if (this._hasKnownPeers !== undefined) {
			return Promise.resolve(this._hasKnownPeers);
		}
		return this.whenSynced().then(async () => {
			await fetchUpdates(this._persistence);
			this._hasKnownPeers = this._persistence._dbsize > 3;
			return this._hasKnownPeers;
		});
	}

	destroy() {
		if (this._persistence) {
			this._persistence.destroy();
		}
		super.destroy();
	}
}
