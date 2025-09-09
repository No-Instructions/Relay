"use strict";

import { Observable } from "./Observable";

export class ObservableSet<T> extends Observable<ObservableSet<T>> {
	protected _set: Set<T>;

	constructor() {
		super();
		this._set = new Set();
	}

	add(item: T): ObservableSet<T> {
		const sizeBefore = this._set.size;
		this._set.add(item);
		if (this._set.size > sizeBefore) {
			this.notifyListeners();
		}
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

	map<ReturnType>(callbackfn: (value: T) => ReturnType): ReturnType[] {
		return this.items().map(callbackfn);
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

	filter(predicate: (value: T) => boolean): T[] {
		const filtered: T[] = [];
		for (const value of this._set) {
			if (predicate(value)) {
				filtered.push(value);
			}
		}
		return filtered;
	}
}
