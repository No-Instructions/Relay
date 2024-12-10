import { Observable, type Unsubscriber } from "./observable/Observable";

export interface StorageAdapter<T> {
	loadData(): Promise<T | null>;
	saveData(data: T): Promise<void>;
}

export interface ISettingsStorage {
	getData<T>(): T;
	setData<T>(data: T): Promise<void>;
	updateData<T>(updater: (data: T) => T): Promise<void>;
}

export class ObsidianSettingsStorage implements ISettingsStorage {
	constructor(private plugin: StorageAdapter<any>) {}

	getData<T>(): T {
		return this.plugin.loadData() as T;
	}

	async setData<T>(data: T): Promise<void> {
		await this.plugin.saveData(data);
	}

	async updateData<T>(updater: (data: T) => T): Promise<void> {
		const current = this.getData<T>();
		const updated = updater(current);
		await this.setData(updated);
	}
}

export class MemorySettingsStorage implements ISettingsStorage {
	private data: any = null;

	getData<T>(): T {
		return this.data as T;
	}

	async setData<T>(data: T): Promise<void> {
		this.data = data;
	}

	async updateData<T>(updater: (data: T) => T): Promise<void> {
		const current = this.getData<T>();
		const updated = updater(current);
		await this.setData(updated);
	}
}

export class Settings<T> extends Observable<T> {
	private data: T;
	private _loaded = false;

	constructor(
		private storage: StorageAdapter<T>,
		private defaults: T,
	) {
		super();
		this.data = { ...defaults };
	}

	async load(): Promise<void> {
		const stored = await this.storage.loadData();
		this.data = {
			...this.defaults,
			...(stored || {}),
		};
		this._loaded = true;
		this.log("Loaded settings from disk:", this.data);
	}

	async save(): Promise<void> {
		if (!this._loaded) {
			this.warn("Attempted to save before loading settings from disk");
			return;
		}
		this.log("Saving settings to disk:", this.data);
		await this.storage.saveData(this.data);
	}

	get(): T {
		return this.data;
	}

	async update(updater: (current: T) => T): Promise<void> {
		if (!this._loaded) {
			this.warn("Attempted to update before loading settings from disk");
			return;
		}
		this.data = updater(this.data);
		await this.save();
		this.notifyListeners();
	}

	override notifyListeners() {
		for (const listener of this._listeners) {
			listener(this.data);
		}
	}
}

export class NamespacedSettings<
	T extends Record<string, any>,
> extends Observable<T> {
	private path: string[];
	private pattern?: {
		type: "arrayMatch" | "wildcard";
		key?: string;
		value?: string;
		wildcardPattern?: string;
	};
	private unsub?: Unsubscriber;
	private destroyed = false;
	private lastKnown?: T;

	constructor(
		public settings: Settings<any>,
		namespace: string,
		private defaultValue: T,
	) {
		super();

		const arrayMatch = namespace.match(/^(.+?)\.\[(\w+)=(.+)\]$/);
		const wildcardMatch = namespace.match(/^(.+?)\.\((.+?)\)$/);
		const currentLevelWildcard = namespace.match(/^\((.+?)\)$/);

		if (arrayMatch) {
			const [, basePath, key, value] = arrayMatch;
			this.path = basePath
				.replace(/\/$/, "")
				.split(/[./]/)
				.filter((p) => p);
			this.pattern = { type: "arrayMatch", key, value };

			if (!this.getNestedValue(this.settings.get())) {
				this.settings.update((current) => {
					const result = { ...current };
					let nested = result;

					this.path.slice(0, -1).forEach((key) => {
						nested[key] = nested[key] || {};
						nested = nested[key];
					});

					const lastKey = this.path[this.path.length - 1];
					nested[lastKey] = nested[lastKey] || [];

					return result;
				});
			}

			if (!this.exists()) {
				this.set({
					...defaultValue,
					[key]: value,
				} as T);
			}
		} else if (wildcardMatch || currentLevelWildcard) {
			const [, basePath, pattern] = wildcardMatch || [
				null,
				"",
				currentLevelWildcard?.[1] ?? "",
			];
			this.path = basePath
				.replace(/\/$/, "")
				.split(/[./]/)
				.filter((p) => p);
			this.pattern = {
				type: "wildcard",
				wildcardPattern: pattern
					.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
					.replace("\\*", ".*"),
			};
		} else {
			this.path = namespace
				.replace(/\/$/, "")
				.split(/[./]/)
				.filter((p) => p);
			if (!this.exists()) {
				this.set(defaultValue);
			}
		}

		this.lastKnown = this.getNestedValue(this.settings.get());
		this.unsub = this.settings.subscribe(() => {
			const newValue = this.getNestedValue(this.settings.get());

			if (this.lastKnown === undefined && newValue === undefined) {
				return;
			}

			if (JSON.stringify(this.lastKnown) !== JSON.stringify(newValue)) {
				this.lastKnown = newValue;
				this.notifyListeners();
			}
		});
	}

	destroy() {
		if (this.unsub) {
			this.unsub();
			this.unsub = undefined;
		}
		this.destroyed = true;
		this._listeners.clear();
	}

	get(): T {
		const data = this.settings.get();
		if (!data) {
			return this.defaultValue;
		}

		if (this.pattern?.type === "wildcard") {
			const base =
				this.path.reduce((current, key) => current?.[key], data) || {};
			const regex = new RegExp(`^${this.pattern.wildcardPattern}$`);

			const filtered = Object.entries(base)
				.filter(([key]) => regex.test(key))
				.reduce(
					(obj, [key, value]) => {
						obj[key] = value;
						return obj;
					},
					{} as Record<string, any>,
				);
			return filtered as T;
		}

		if (this.pattern?.type === "arrayMatch") {
			const rawValue = this.getNestedValue(data);
			return rawValue ?? this.defaultValue;
		}

		return this.stripPatternFields(
			this.getNestedValue(data) ?? this.defaultValue,
		);
	}

	private stripPatternFields<R>(obj: R): R {
		if (!obj || typeof obj !== "object") {
			return obj;
		}

		if (Array.isArray(obj)) {
			return obj.map((item) => {
				if (this.pattern?.type === "arrayMatch" && typeof item === "object") {
					const { [this.pattern.key!]: _, ...rest } = item;
					return rest;
				}
				return item;
			}) as R;
		}

		return obj;
	}

	async set(value: T): Promise<void> {
		await this.settings.update((data) => {
			if (this.pattern?.type === "wildcard") {
				const result = { ...data };
				let current = result;

				this.path.forEach((key) => {
					current[key] = current[key] || {};
					current = current[key];
				});

				const regex = new RegExp(`^${this.pattern.wildcardPattern}$`);
				Object.entries(value).forEach(([key, val]) => {
					if (regex.test(key)) {
						current[key] = val;
					}
				});

				return result;
			}

			return this.setNestedValue(data, value);
		});
	}

	async update(updater: (current: T) => T): Promise<void> {
		const current = this.get();
		const updated = updater(current);
		await this.set(updated);
	}

	private getNestedValue(obj: Record<string, any>): T | undefined {
		const base = this.path.reduce((current, key) => current?.[key], obj);

		if (this.pattern?.type === "arrayMatch") {
			if (Array.isArray(base)) {
				const item = base.find(
					(item) => item[this.pattern!.key!] === this.pattern!.value,
				);
				if (item) {
					const { [this.pattern.key!]: _, ...rest } = item;
					return rest as T;
				}
				return undefined;
			}
			return undefined;
		}

		return base as T | undefined;
	}

	private setNestedValue(
		obj: Record<string, any>,
		value: T,
	): Record<string, any> {
		const result = { ...obj };
		let current = result;

		this.path.slice(0, -1).forEach((key) => {
			current[key] = current[key] || {};
			current = current[key];
		});

		if (this.pattern?.type === "arrayMatch") {
			const lastKey = this.path[this.path.length - 1];
			current[lastKey] = current[lastKey] || [];
			const array = current[lastKey];

			const index = array.findIndex(
				(item: any) => item[this.pattern!.key!] === this.pattern!.value,
			);

			if (index >= 0) {
				array[index] = {
					[this.pattern.key!]: this.pattern.value,
					...value,
				};
			} else {
				array.push({
					[this.pattern.key!]: this.pattern.value,
					...value,
				});
			}
		} else {
			const lastKey = this.path[this.path.length - 1];
			current[lastKey] = value;
		}

		return result;
	}

	getParent<P extends Record<string, any>>(): NamespacedSettings<P> {
		const parentPath = this.path.slice(0, -1).join("/");
		return new NamespacedSettings<P>(this.settings, parentPath, {} as P);
	}

	getChild<
		C extends Record<string, any>,
		R extends NamespacedSettings<C> = NamespacedSettings<C>,
	>(
		childPath: string,
		factory?: (settings: Settings<any>, path: string, defaults: C) => R,
	): R {
		const fullPath = [...this.path, childPath].join("/");
		if (factory) {
			return factory(this.settings, fullPath, {} as C);
		}
		return new NamespacedSettings<C>(this.settings, fullPath, {} as C) as R;
	}

	getPath(): string {
		return this.path.join("/");
	}

	exists(): boolean {
		const data = this.settings.get();
		return this.getNestedValue(data) !== undefined;
	}

	async delete(): Promise<void> {
		await this.settings.update((data) => {
			const result = { ...data };
			let current = result;

			for (const key of this.path.slice(0, -1)) {
				if (!current[key]) return result;
				current = current[key];
			}

			const lastKey = this.path[this.path.length - 1];

			if (
				this.pattern?.type === "arrayMatch" &&
				Array.isArray(current[lastKey])
			) {
				current[lastKey] = current[lastKey].filter(
					(item: any) => item[this.pattern!.key!] !== this.pattern!.value,
				);
			} else {
				delete current[lastKey];
			}

			return result;
		});
	}

	subscribe(run: (value: T) => void): Unsubscriber {
		this._listeners.add(run);
		run(this.get());
		return () => {
			this._listeners.delete(run);
		};
	}

	override notifyListeners() {
		const value = this.get();
		for (const listener of this._listeners) {
			listener(value);
		}
	}
}
