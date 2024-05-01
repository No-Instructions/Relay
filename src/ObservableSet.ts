"use strict";
export class ObservableSet<T> {
	protected _set: Set<T>;
	private _listeners: Set<() => void>;

	constructor() {
		this._set = new Set();
		this._listeners = new Set();
	}

	protected notifyListeners(): void {
		for (const listener of this._listeners) {
			listener();
		}
	}

	on(listener: () => void): void {
		this._listeners.add(listener);
	}

	off(listener: () => void): void {
		this._listeners.delete(listener);
	}

	add(item: T): ObservableSet<T> {
		this._set.add(item);
		this.notifyListeners();
		return this;
	}

	delete(item: T): boolean {
		const result = this._set.delete(item);
		if (result) {
			this.notifyListeners();
		}
		return result;
	}

	clear(): void {
		this._set.clear();
		this.notifyListeners();
	}

	has(item: T): boolean {
		return this._set.has(item);
	}

	items(): T[] {
		return [...this._set];
	}

	get size(): number {
		return this._set.size;
	}

	forEach(callbackfn: (value: T, index: number, array: T[]) => void): void {
		this.items().forEach(callbackfn);
	}

	find(predicate: (value: T) => boolean): T | undefined {
		return this.items().find(predicate);
	}

	some(predicate: (item: T) => boolean): boolean {
		for (const item of this._set) {
			if (predicate(item)) {
				return true;
			}
		}
		return false;
	}
}
