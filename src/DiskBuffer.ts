import { TFile, Vault } from "obsidian";

export class DiskBuffer implements TFile {
	path: string;
	name: string;
	extension: string;
	basename: string;
	parent: null = null;
	stat: {
		ctime: number;
		mtime: number;
		size: number;
	};

	constructor(
		public vault: Vault,
		path: string,
		public contents: string,
	) {
		this.path = path;
		this.name = path.split("/").pop() || "";
		this.extension = this.name.includes(".")
			? this.name.split(".").pop() || ""
			: "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.stat = {
			ctime: Date.now(),
			mtime: Date.now(),
			size: 0,
		};
	}

	delete(): Promise<void> {
		return Promise.resolve();
	}

	rename(newPath: string): Promise<void> {
		this.path = newPath;
		this.name = newPath.split("/").pop() || "";
		this.extension = this.name.includes(".")
			? this.name.split(".").pop() || ""
			: "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		return Promise.resolve();
	}

	getBasePath(): string {
		return this.path.substring(0, this.path.lastIndexOf("/"));
	}
}
export class DiskBufferStore {
	private dbName = "RelayDiskBuffer";
	private storeName = "diskBuffers";
	private dbPromise: Promise<IDBDatabase> | null = null;

	private async getDB(): Promise<IDBDatabase> {
		if (!this.dbPromise) {
			this.dbPromise = this.openDB();
		}
		return this.dbPromise;
	}

	private async openDB(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, 1);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result);
			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				db.createObjectStore(this.storeName, { keyPath: "guid" });
			};
		});
	}

	async saveDiskBuffer(guid: string, contents: string): Promise<void> {
		const db = await this.getDB();
		return new Promise((resolve, reject) => {
			try {
				const transaction = db.transaction(this.storeName, "readwrite");
				const store = transaction.objectStore(this.storeName);
				const request = store.put({ guid, contents });
				request.onerror = () => reject(request.error);
				request.onsuccess = () => resolve();
			} catch (e) {
				reject(e);
			}
		});
	}

	async loadDiskBuffer(guid: string): Promise<string | null> {
		const db = await this.getDB();
		return new Promise((resolve, reject) => {
			try {
				const transaction = db.transaction(this.storeName, "readonly");
				const store = transaction.objectStore(this.storeName);
				const request = store.get(guid);
				request.onerror = () => reject(request.error);
				request.onsuccess = () =>
					resolve(request.result ? request.result.contents : null);
			} catch (e) {
				reject(e);
			}
		});
	}

	async removeDiskBuffer(guid: string): Promise<void> {
		const db = await this.getDB();
		return new Promise((resolve, reject) => {
			try {
				const transaction = db.transaction(this.storeName, "readwrite");
				const store = transaction.objectStore(this.storeName);
				const request = store.delete(guid);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => resolve();
			} catch (e) {
				reject(e);
			}
		});
	}
}
