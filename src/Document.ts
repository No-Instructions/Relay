"use strict";
import * as Y from "yjs";
import { IndexeddbPersistence, fetchUpdates } from "y-indexeddb";
import { HasProvider } from "./HasProvider";
import { SharedFolder } from "./SharedFolder";
import { YText } from "yjs/dist/src/internals";
import { curryLog } from "./debug";
import { LoginManager } from "./LoginManager";

export class Document extends HasProvider {
	guid: string;
	loginManager: LoginManager;
	private _parent: SharedFolder;
	private _persistence: IndexeddbPersistence;
	ydoc: Y.Doc;
	path: string;
	_locallyRaised: boolean;

	constructor(
		path: string,
		guid: string,
		loginManager: LoginManager,
		parent: SharedFolder
	) {
		super();
		this.loginManager = loginManager;
		this._parent = parent;
		this.ydoc = new Y.Doc();
		this.guid = guid;
		this.path = path;
		this.log = curryLog(`[SharedDoc](${this.path})`);

		this._persistence = new IndexeddbPersistence(this.guid, this.ydoc);

		this.ydoc.on(
			"update",
			(update: Uint8Array, origin: any, doc: Y.Doc) => {
				this.log(`Update from origin`, origin, update);
			}
		);
	}

	public get ytext(): YText {
		return this.ydoc.getText("contents");
	}

	public get text(): string {
		return this.ytext.toString();
	}

	public async whenReady(): Promise<Document> {
		const dependencies = [];
		if (!this._persistence.synced) {
			dependencies.push(this.whenSynced());
		}
		if (!this._provider) {
			dependencies.push(this.withProvider());
		}
		return Promise.all(dependencies).then((_) => {
			return this;
		});
	}

	whenSynced(): Promise<void> {
		if (this._persistence.synced) {
			return new Promise((resolve) => {
				resolve();
			});
		}
		return new Promise((resolve) => {
			this._persistence.once("synced", resolve);
		});
	}

	private async _countUpdates(): Promise<number> {
		return new Promise((resolve, reject) => {
			try {
				fetchUpdates(this._persistence).then((db) => {
					const countRequest = db.count();

					countRequest.onsuccess = () => {
						resolve(countRequest.result); // Resolve with the count
					};

					countRequest.onerror = (event: Event) => {
						console.error("Count request failed");
						reject(new Error("Count request failed"));
					};
				});
			} catch (e) {
				console.error("Failed to count rows:", e);
				reject(e);
			}
		});
	}

	async locallyRaised(): Promise<boolean> {
		// XXX: Might be able to use _persistence.once("synced", ...) instead
		if (this._locallyRaised !== undefined) {
			return this._locallyRaised;
		}
		const nUpdates = await this._countUpdates();
		this._locallyRaised = nUpdates < 3;
		return this._locallyRaised;
	}

	destroy() {
		if (this._provider) {
			this._provider.destroy();
		}
		if (this._persistence) {
			this._persistence.destroy();
		}
	}
}
