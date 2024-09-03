export class LocalStorage<T> implements Map<string, T> {
	private namespace: string;
	private seperator = "/";

	constructor(namespace: string) {
		this.namespace = namespace;
	}

	private fullKey(key: string): string {
		return `${this.namespace}${this.seperator}${key}`;
	}

	public get size(): number {
		return Object.keys(localStorage).filter((key: string) =>
			key.startsWith(this.namespace + this.seperator),
		).length;
	}

	public clear(): void {
		Object.keys(localStorage)
			.filter((key: string) => key.startsWith(this.namespace + this.seperator))
			.forEach((key: string) => localStorage.removeItem(key));
	}

	public delete(key: string): boolean {
		const storageKey = this.fullKey(key);
		const exists = localStorage.getItem(storageKey) !== null;
		localStorage.removeItem(storageKey);
		return exists;
	}

	public forEach(
		callbackfn: (value: T, key: string, map: Map<string, T>) => void,
		thisArg?: unknown,
	): void {
		Object.keys(localStorage)
			.filter((key: string) => key.startsWith(this.namespace + this.seperator))
			.forEach((key: string) => {
				const storageKey = key.split(`${this.namespace}${this.seperator}`)[1];
				const value = this.get(storageKey) as unknown as T;
				callbackfn.call(thisArg, value, storageKey, this);
			});
	}

	public get(key: string): T | undefined {
		const storageKey = this.fullKey(key);
		const item = localStorage.getItem(storageKey);
		return item ? JSON.parse(item) : undefined;
	}

	public has(key: string): boolean {
		const storageKey = this.fullKey(key);
		return localStorage.getItem(storageKey) !== null;
	}

	public set(key: string, value: T): this {
		const storageKey = this.fullKey(key);
		localStorage.setItem(storageKey, JSON.stringify(value));
		return this;
	}

	public keys(): IterableIterator<string> {
		const keys = Object.keys(localStorage)
			.filter((key: string) => key.startsWith(this.namespace + this.seperator))
			.map((key: string) => key.split(`${this.namespace}${this.seperator}`)[1]);
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
