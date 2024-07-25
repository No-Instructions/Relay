"use strict";

import type { Subscriber, Unsubscriber } from "svelte/store";
import { Observable, type IObservable } from "./Observable";

export class ObservableMap<K, V> extends Observable<ObservableMap<K, V>> {
	protected _map: Map<K, V>;

	constructor(public observableName?: string) {
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

	get<T = V>(key: K): T | undefined {
		return this._map.get(key) as T;
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

	filter(predicate: (value: V, key: K) => boolean): ObservableMap<K, V> {
		return new DerivedMap<K, V>(this, predicate);
	}
}

class DerivedMap<K, V> extends ObservableMap<K, V> {
	private unsub?: Unsubscriber;

	constructor(
		private parentMap: ObservableMap<K, V>,
		private predicate: (value: V, key: K) => boolean
	) {
		super();
		this.sub();
		this.observableName =
			parentMap.observableName + "(filter: " + predicate.toString() + ")";
	}

	private sub(): void {
		if (this.unsub) {
			return;
		}
		this.unsub = this.parentMap.subscribe(() => {
			const newMap = new Map<K, V>();
			this.parentMap.forEach((value, key) => {
				if (this.predicate(value, key)) {
					newMap.set(key, value);
				}
			});
			this._map = newMap;
			this.notifyListeners();
		});
	}

	subscribe(run: (value: ObservableMap<K, V>) => unknown): Unsubscriber {
		this.sub();
		super.subscribe(run);
		return () => {
			this.unsubscribe(run);
		};
	}

	unsubscribe(run: (value: ObservableMap<K, V>) => unknown): void {
		super.unsubscribe(run);
		if ([...this._listeners.values()].length === 0 && this.unsub) {
			this.unsub();
			this.unsub = undefined;
		}
	}
}
