/**
 * # SettingsStorage Module
 *
 * This module provides a centralized mechanism for components in the codebase
 * to access and manipulate settings stored in a central JSON file.
 *
 * The `SettingsStorage` allows components to:
 *
 * - Read and write settings in a namespaced way.
 * - Subscribe to updates and be notified when changes occur.
 * - Support complex path patterns for accessing nested settings.
 * - Write changes back to the centralized JSON file efficiently.
 *
 * ## Design Goals
 *
 * - **Centralized Settings Management**: Provide a central JSON storage for settings
 *   that can be accessed and modified by various components.
 *
 * - **Namespaced Access**: Allow components to access settings within a specific namespace,
 *   so they can operate on a subset of settings without interfering with others.
 *
 * - **Subscriptions**: Components can subscribe to changes in their namespace and be notified when updates occur.
 *
 * - **Flexible Path Pattern Language**: Provide a flexible path pattern language
 *   that allows for complex queries into the JSON structure, including wildcard and key/value matching within arrays.
 *
 * - **Developer Ergonomics**: The system should be easy and intuitive for developers to use,
 *   with clear APIs and predictable behavior.
 *
 * ## Path Pattern Language
 *
 * The path pattern language allows for specifying paths into the JSON settings object using:
 *
 * - **Slash (`/`) Notation**: Navigate nested properties by separating path segments with slashes `/`.
 * - **Array Item Matching (`[key=value]`)**: Match items within an array based on a specific key-value condition.
 * - **Wildcard Matching (`(pattern)`)**: Use wildcards to match property names using glob-style patterns.
 *
 * ### Syntax Elements
 *
 * - **Slash Notation**:
 *   - Used to navigate nested properties.
 *   - **Example**: `"user/settings"` navigates to `data["user"]["settings"]`.
 *
 * - **Array Item Matching**:
 *   - **Syntax**: `arrayPropertyName/[key=value]`
 *   - **Example**: `"folders/[id=123]"` matches the item in the `folders` array where `id` equals `"123"`.
 *
 * - **Wildcard Matching**:
 *   - **Syntax**: `(pattern)`
 *   - The wildcard `*` matches any sequence of characters.
 *   - **Example**: `"(enable*)"` matches all properties starting with `"enable"`, such as `"enableFeatureX"`, `"enableLogging"`, etc.
 *
 * ### Examples
 *
 * **Accessing a Specific Folder by ID**:
 *
 * ```typescript
 * const folderSettings = new NamespacedSettings(
 *   settings,
 *   "folders/[id=123]",
 *   defaultFolderSettings
 * );
 * ```
 *
 * **Accessing All Feature Flags Starting with `enable`**:
 *
 * ```typescript
 * const featureFlags = new NamespacedSettings(settings, "(enable*)", {});
 * ```
 *
 * **Accessing Nested Properties**:
 *
 * ```typescript
 * const userPreferences = new NamespacedSettings(
 *   settings,
 *   "users/[id=456]/preferences",
 *   defaultPreferences
 * );
 * ```
 *
 * **Subscribing to Updates in a Namespace**:
 *
 * ```typescript
 * folderSettings.subscribe((value) => {
 *   this.log("Folder settings updated:", value);
 * });
 * ```
 *
 * ## Implementation Details
 *
 * The `Settings` class manages the loading and saving of the settings data from a storage adapter.
 *
 * - **Settings<T>**:
 *   - Manages the settings data for type `T`.
 *   - Provides methods to load from and save to the storage adapter.
 *   - Notifies subscribers when the data changes.
 *
 * The `NamespacedSettings` class provides a namespaced view of the settings, supporting complex path patterns.
 *
 * - **NamespacedSettings<T, Parent>**:
 *   - Provides namespaced access to a subset of the settings data.
 *   - Supports pattern matching in paths for flexible data access.
 *   - Allows subscribing to changes within the namespace.
 *
 * ### Storage Adapters
 *
 * - **ObsidianSettingsStorage**: An adapter for Obsidian's storage system.
 * - **MemorySettingsStorage**: An in-memory adapter for testing or temporary storage.
 *
 * ### Error Handling
 *
 * - Errors are handled using the `SettingsError` class, providing informative error messages and the path where the error occurred.
 */

import { Observable, type Unsubscriber } from "./observable/Observable";

export type PathSegment = string | number;
export type Path = PathSegment[];

export interface BasePattern {
	readonly type: string;
	readonly level: number;
}

export interface ArrayMatchPattern extends BasePattern {
	readonly type: "arrayMatch";
	readonly key: string;
	readonly value: string;
}

export interface WildcardPattern extends BasePattern {
	readonly type: "wildcard";
	readonly wildcardPattern: string;
}

export type PathPattern = ArrayMatchPattern | WildcardPattern;

export class SettingsError extends Error {
	constructor(
		message: string,
		public readonly path?: string,
	) {
		super(message);
		this.name = "SettingsError";
	}
}

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
		private readonly storage: StorageAdapter<T>,
		private readonly defaults: T,
	) {
		super("Settings");
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
		const updated = updater(this.data);
		const stored = await this.storage.loadData();
		if (JSON.stringify(updated) === JSON.stringify(stored)) {
			this.debug("updated matches disk, no change");
			return;
		}
		this.data = updated;
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
	Parent extends Record<string, any> = Record<string, any>,
> extends Observable<T> {
	private readonly path: string[];
	private readonly basePath: string[];
	private readonly patterns: PathPattern[] = [];
	private unsub?: Unsubscriber;
	private lastKnown?: T;

	constructor(
		public readonly settings: Settings<any>,
		namespace: string,
	) {
		super(`NamespacedSettings[${namespace}]`);
		this.validatePath(namespace);
		[this.path, this.basePath, this.patterns] = this.processPath(namespace);
		this.lastKnown = this.getNestedValue(this.settings.get());
		this.setupSubscription();
	}

	private isWildcardPattern(pattern: PathPattern): pattern is WildcardPattern {
		return pattern.type === "wildcard";
	}

	private validatePath(path: string): void {
		if (!path) {
			throw new SettingsError("Path cannot be empty");
		}
		if (path.startsWith("/") || path.endsWith("/")) {
			throw new SettingsError(`Invalid path format: ${path}`);
		}
	}

	private createPatternRegex(pattern: string): string {
		return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", ".*");
	}

	private setupSubscription(): void {
		this.unsub = this.settings.subscribe(() => {
			const newValue = this.getNestedValue(this.settings.get());
			if (this.lastKnown === undefined && newValue === undefined) return;
			if (JSON.stringify(this.lastKnown) !== JSON.stringify(newValue)) {
				this.lastKnown = newValue;
				this.notifyListeners();
			}
		});
	}

	private hasArrayPatterns(): boolean {
		return this.patterns.some((p) => p.type === "arrayMatch");
	}

	destroy() {
		if (this.destroyed) return;

		if (this.unsub) {
			this.unsub();
			this.unsub = undefined;
		}

		this._listeners.clear();
		this.destroyed = true;
	}

	get(): T {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		const data = this.settings.get();
		if (!data) {
			return {} as T;
		}

		const wildcardPattern = this.patterns.find(this.isWildcardPattern);
		if (wildcardPattern && this.path.length === 1) {
			const regex = new RegExp(`^${wildcardPattern.wildcardPattern}$`);
			const filtered = Object.entries(data)
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

		const value = this.getNestedValue(data);
		if (value === undefined) {
			return {} as T;
		}

		return value;
	}

	async set(value: T): Promise<void> {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		if (value === undefined) {
			throw new SettingsError("Cannot set undefined value", this.getPath());
		}

		try {
			await this.settings.update((data) => {
				const wildcardPattern = this.patterns.find(this.isWildcardPattern);
				if (wildcardPattern) {
					if (this.path.length === 1) {
						const regex = new RegExp(`^${wildcardPattern.wildcardPattern}$`);
						const result = { ...data };
						Object.entries(value).forEach(([key, val]) => {
							if (regex.test(key)) {
								result[key] = val;
							}
						});
						return result;
					}

					const result = { ...data };
					let current = result;

					this.path.forEach((key) => {
						current[key] = current[key] || {};
						current = current[key];
					});

					const regex = new RegExp(`^${wildcardPattern.wildcardPattern}$`);
					Object.entries(value).forEach(([key, val]) => {
						if (regex.test(key)) {
							current[key] = val;
						}
					});

					return result;
				}

				return this.setNestedValue(data, value);
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			throw new SettingsError(
				`Failed to set value at path ${this.getPath()}: ${errorMessage}`,
				this.getPath(),
			);
		}
	}

	async update(updater: (current: T) => T, force = false): Promise<void> {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		const current = this.get();
		const updated = updater(current);

		if (!force && JSON.stringify(current) === JSON.stringify(updated)) {
			return;
		}

		await this.set(updated);
	}

	async flush(): Promise<void> {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		await this.update((current) => current, true);
	}

	private processPath(namespace: string): [string[], string[], PathPattern[]] {
		const segments = namespace.split("/").filter((p) => p);
		const path: string[] = [];
		const basePath: string[] = [];
		const patterns: PathPattern[] = [];

		segments.forEach((segment, index) => {
			const arrayMatch = segment.match(/^\[(\w+)=(.+)\]$/);
			const wildcardMatch = segment.match(/^\((.+?)\)$/);

			if (arrayMatch) {
				const [, key, value] = arrayMatch;
				// For array patterns, use the previous segment or the prefix before [
				const baseKey = index > 0 ? basePath[index - 1] : segment.split("[")[0];
				patterns.push({
					type: "arrayMatch",
					key,
					value,
					level: index,
				});
				path.push(segment);
				basePath.push(baseKey);
			} else if (wildcardMatch) {
				const [, pattern] = wildcardMatch;
				patterns.push({
					type: "wildcard",
					wildcardPattern: this.createPatternRegex(pattern),
					level: index,
				});
				path.push(segment);
				basePath.push(segment);
			} else {
				path.push(segment);
				basePath.push(segment);
			}
		});

		return [path, basePath, patterns];
	}

	private getNestedValue(obj: Record<string, any>): T | undefined {
		let current = obj;

		// Special case: if we have a wildcard pattern at this level
		const wildcardPattern = this.patterns.find(this.isWildcardPattern);
		if (wildcardPattern && this.path.length === 1) {
			const regex = new RegExp(`^${wildcardPattern.wildcardPattern}$`);
			// Filter the object entries based on the wildcard pattern
			const filtered = Object.entries(current)
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

		// Special case: if the first pattern is an array match
		const firstPattern = this.patterns[0];
		if (firstPattern?.type === "arrayMatch") {
			const baseKey = this.basePath[0];
			if (!Array.isArray(current[baseKey])) return undefined;

			const matchedItem = current[baseKey].find(
				(item: Record<string, any>) =>
					item[firstPattern.key] === firstPattern.value,
			);

			if (!matchedItem) return undefined;

			// Handle remaining path after array pattern
			const remainingPath = this.basePath.slice(firstPattern.level + 1);
			if (remainingPath.length > 0) {
				let result = matchedItem;
				for (const key of remainingPath) {
					if (!result || typeof result !== "object") return undefined;
					result = result[key];
				}
				return result as T;
			}

			return matchedItem as T;
		}

		// Handle regular nested paths
		for (let i = 0; i < this.basePath.length; i++) {
			if (!current) return undefined;
			current = current[this.basePath[i]];
		}

		return current as T;
	}

	private setNestedValue(
		obj: Record<string, any>,
		value: T,
	): Record<string, any> {
		const result = { ...obj };

		// Handle array pattern matching
		const arrayPattern = this.patterns.find((p) => p.type === "arrayMatch") as
			| ArrayMatchPattern
			| undefined;
		if (arrayPattern) {
			const baseKey = this.basePath[0];
			if (!result[baseKey]) {
				result[baseKey] = [];
			}

			const index = result[baseKey].findIndex(
				(item: Record<string, any>) =>
					item[arrayPattern.key] === arrayPattern.value,
			);

			// Get the remaining path after the array pattern
			const remainingPath = this.basePath.slice(arrayPattern.level + 1);

			if (index >= 0) {
				// Update existing item
				if (remainingPath.length > 0) {
					// Handle nested properties in array item
					let current = result[baseKey][index];
					for (let i = 0; i < remainingPath.length - 1; i++) {
						const key = remainingPath[i];
						current[key] = current[key] || {};
						current = current[key];
					}
					const lastKey = remainingPath[remainingPath.length - 1];
					current[lastKey] = value;
				} else {
					// Update root level of array item
					result[baseKey][index] = {
						...result[baseKey][index],
						...value,
						[arrayPattern.key]: arrayPattern.value,
					};
				}
			} else {
				// Add new item
				if (remainingPath.length > 0) {
					// Handle nested properties in new array item
					const newItem: Record<string, any> = {
						[arrayPattern.key]: arrayPattern.value,
					};
					let current: Record<string, any> = newItem;
					for (let i = 0; i < remainingPath.length - 1; i++) {
						const key = remainingPath[i];
						current[key] = {};
						current = current[key];
					}
					const lastKey = remainingPath[remainingPath.length - 1];
					current[lastKey] = value;
					result[baseKey].push(newItem);
				} else {
					// Add new item at root level
					result[baseKey].push({
						...value,
						[arrayPattern.key]: arrayPattern.value,
					});
				}
			}
			return result;
		}

		// Handle regular nested paths
		let current = result;
		for (let i = 0; i < this.basePath.length - 1; i++) {
			const baseKey = this.basePath[i];
			current[baseKey] = current[baseKey] || {};
			current = current[baseKey];
		}

		const lastKey = this.basePath[this.basePath.length - 1];
		current[lastKey] = value;

		return result;
	}

	getParent(): NamespacedSettings<Parent> {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		const parentPath = this.path.slice(0, -1).join("/");
		return new NamespacedSettings<Parent>(this.settings, parentPath);
	}

	getChild<
		C extends Record<string, any>,
		R extends NamespacedSettings<C> = NamespacedSettings<C>,
	>(
		childPath: string,
		factory?: (settings: Settings<any>, path: string) => R,
	): R {
		const fullPath = [...this.path, childPath].join("/");
		if (factory) {
			return factory(this.settings, fullPath);
		}
		this.log("getChild", this.path, childPath, fullPath, this.patterns);
		return new NamespacedSettings<C>(this.settings, fullPath) as R;
	}

	getPath(): string {
		return this.path.join("/");
	}

	exists(): boolean {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		const data = this.settings.get();
		return this.getNestedValue(data) !== undefined;
	}

	async delete(): Promise<void> {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		await this.settings.update((data) => {
			const result = { ...data };

			// Handle array pattern matching
			const arrayPattern = this.patterns.find(
				(p) => p.type === "arrayMatch",
			) as ArrayMatchPattern | undefined;

			if (arrayPattern) {
				const baseKey = this.basePath[0];
				if (Array.isArray(result[baseKey])) {
					result[baseKey] = result[baseKey].filter(
						(item: Record<string, any>) =>
							item[arrayPattern.key] !== arrayPattern.value,
					);

					if (result[baseKey].length === 0) {
						delete result[baseKey];
					}
				}
				return result;
			}

			// Handle regular paths
			let current = result;
			const keys = this.basePath.slice(0, -1);

			for (const key of keys) {
				if (!current[key]) return result;
				current = current[key];
			}

			const lastKey = this.basePath[this.basePath.length - 1];
			delete current[lastKey];

			return result;
		});
	}

	subscribe(run: (value: T) => void): Unsubscriber {
		if (this.destroyed) {
			throw new SettingsError("Cannot use destroyed settings", this.getPath());
		}

		this._listeners.add(run);
		run(this.get());
		return () => {
			this._listeners.delete(run);
		};
	}

	override notifyListeners() {
		if (this.destroyed) {
			return;
		}

		const value = this.get();
		for (const listener of this._listeners) {
			listener(value);
		}
	}
}
