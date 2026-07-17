const keyIndexes = new WeakMap<Storage, Map<string, Set<string>>>();

export class LocalStorage<T> implements Map<string, T> {
	private namespace: string;
	private seperator = "/";
	private storage: Storage;
	private keyIndex: Set<string>;

	constructor(namespace: string) {
		this.namespace = namespace;
		this.storage = localStorage;

		let storageIndexes = keyIndexes.get(this.storage);
		if (!storageIndexes) {
			storageIndexes = new Map();
			keyIndexes.set(this.storage, storageIndexes);
		}

		const existingIndex = storageIndexes.get(this.namespace);
		if (existingIndex) {
			this.keyIndex = existingIndex;
		} else {
			const prefix = this.namespace + this.seperator;
			this.keyIndex = new Set(
				Object.keys(this.storage).filter((key) => key.startsWith(prefix)),
			);
			storageIndexes.set(this.namespace, this.keyIndex);
		}
	}

	private fullKey(key: string): string {
		return `${this.namespace}${this.seperator}${key}`;
	}

	public get size(): number {
		return this.keyIndex.size;
	}

	public clear(): void {
		Array.from(this.keyIndex).forEach((key) => {
			this.storage.removeItem(key);
			this.keyIndex.delete(key);
		});
	}

	public delete(key: string): boolean {
		const storageKey = this.fullKey(key);
		const exists = this.storage.getItem(storageKey) !== null;
		this.storage.removeItem(storageKey);
		this.keyIndex.delete(storageKey);
		return exists;
	}

	public forEach(
		callbackfn: (value: T, key: string, map: Map<string, T>) => void,
		thisArg?: unknown,
	): void {
		Array.from(this.keyIndex).forEach((key) => {
			const storageKey = key.split(`${this.namespace}${this.seperator}`)[1];
			const value = this.get(storageKey) as unknown as T;
			callbackfn.call(thisArg, value, storageKey, this);
		});
	}

	public get(key: string): T | undefined {
		const storageKey = this.fullKey(key);
		const item = this.storage.getItem(storageKey);
		return item ? JSON.parse(item) : undefined;
	}

	public has(key: string): boolean {
		const storageKey = this.fullKey(key);
		return this.storage.getItem(storageKey) !== null;
	}

	public set(key: string, value: T): this {
		const storageKey = this.fullKey(key);
		this.storage.setItem(storageKey, JSON.stringify(value));
		this.keyIndex.add(storageKey);
		return this;
	}

	public keys(): IterableIterator<string> {
		const keys = Array.from(this.keyIndex).map(
			(key: string) => key.split(`${this.namespace}${this.seperator}`)[1],
		);
		return keys.values();
	}

	public values(): IterableIterator<T> {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const values = Array.from(this.keys()).map((key) => this.get(key)!);
		return values.values();
	}

	public entries(): IterableIterator<[string, T]> {
		const entries = Array.from(this.keys()).map(
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			(key) => [key, this.get(key)!] as [string, T],
		);
		return entries.values();
	}

	[Symbol.iterator](): IterableIterator<[string, T]> {
		return this.entries();
	}

	get [Symbol.toStringTag](): string {
		return "LocalStorage";
	}
}
