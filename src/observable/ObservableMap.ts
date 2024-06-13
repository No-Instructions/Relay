"use strict";

import { Observable } from "./Observable";

export class ObservableMap<K, V> extends Observable<ObservableMap<K, V>> {
	protected _map: Map<K, V>;

	constructor() {
		super();
		this._map = new Map();
	}

	set(key: K, value: V): ObservableMap<K, V> {
		this._map.set(key, value);
		this.notifyListeners();
		return this;
	}

	delete(key: K): boolean {
		const result = this._map.delete(key);
		if (result) {
			this.notifyListeners();
		}
		return result;
	}

	clear(): void {
		this._map.clear();
		this.notifyListeners();
	}

	has(key: K): boolean {
		return this._map.has(key);
	}

	get(key: K): V | undefined {
		return this._map.get(key);
	}

	keys(): K[] {
		return [...this._map.keys()];
	}

	values(): V[] {
		return [...this._map.values()];
	}

	entries(): [K, V][] {
		return [...this._map.entries()];
	}

	get size(): number {
		return this._map.size;
	}

	forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void): void {
		this._map.forEach(callbackfn);
	}

	find(predicate: (value: V, key: K) => boolean): V | undefined {
		for (const [key, value] of this._map) {
			if (predicate(value, key)) {
				return value;
			}
		}
		return undefined;
	}

	some(predicate: (value: V, key: K) => boolean): boolean {
		for (const [key, value] of this._map) {
			if (predicate(value, key)) {
				return true;
			}
		}
		return false;
	}

	filter(predicate: (value: V, key: K) => boolean): V[] {
		const filtered: V[] = [];
		for (const [key, value] of this._map) {
			if (predicate(value, key)) {
				filtered.push(value);
			}
		}
		return filtered;
	}
}
