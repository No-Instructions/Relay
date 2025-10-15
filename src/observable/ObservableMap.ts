"use strict";

import type { Unsubscriber } from "svelte/store";
import { Observable } from "./Observable";
import type { Subscriber } from "./Observable";

export class ObservableMap<K, V> extends Observable<ObservableMap<K, V>> {
	protected _map: Map<K, V>;
	protected _derivedMaps: WeakMap<
		(value: V, key: K) => boolean,
		DerivedMap<K, V>
	>;
	private derivedMapRefCounts = new WeakMap<DerivedMap<K, V>, number>();
	private activeDerivedMaps = new Set<DerivedMap<K, V>>();

	constructor(public observableName?: string) {
		super();
		this._map = new Map();
		this._derivedMaps = new WeakMap();
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

	// Override subscribe to track derived map subscriptions
	subscribe(run: Subscriber<ObservableMap<K, V>>): Unsubscriber {
		// Check if this subscriber is from a derived map
		let derivedMap: DerivedMap<K, V> | null = null;
		for (const dm of this.activeDerivedMaps) {
			if (dm && dm.parentCallback === run) {
				derivedMap = dm;
				break;
			}
		}

		if (derivedMap) {
			const current = this.derivedMapRefCounts.get(derivedMap) || 0;
			this.derivedMapRefCounts.set(derivedMap, current + 1);
		}

		const parentUnsubscribe = super.subscribe(run);

		return () => {
			if (derivedMap) {
				const current = this.derivedMapRefCounts.get(derivedMap) || 0;
				const newCount = current - 1;

				if (newCount <= 0) {
					// Remove from active set and ref counts - WeakMap handles its own GC
					this.derivedMapRefCounts.delete(derivedMap);
					this.activeDerivedMaps.delete(derivedMap);
					derivedMap.destroy();
				} else {
					this.derivedMapRefCounts.set(derivedMap, newCount);
				}
			}
			parentUnsubscribe();
		};
	}

	// Override unsubscribe to handle direct unsubscribe calls
	unsubscribe(run: Subscriber<ObservableMap<K, V>>): void {
		// Find and handle derived map cleanup
		for (const dm of this.activeDerivedMaps) {
			if (dm && dm.parentCallback === run) {
				const current = this.derivedMapRefCounts.get(dm) || 0;
				const newCount = current - 1;

				if (newCount <= 0) {
					// Remove from active set and ref counts - WeakMap handles its own GC
					this.derivedMapRefCounts.delete(dm);
					this.activeDerivedMaps.delete(dm);
					dm.destroy();
				} else {
					this.derivedMapRefCounts.set(dm, newCount);
				}
				break;
			}
		}

		super.unsubscribe(run);
	}

	filter(predicate: (value: V, key: K) => boolean): ObservableMap<K, V> {
		const existing = this._derivedMaps.get(predicate);
		if (existing) {
			return existing;
		}

		const derivedMap = new DerivedMap<K, V>(this, predicate);
		this._derivedMaps.set(predicate, derivedMap);
		this.derivedMapRefCounts.set(derivedMap, 0);
		this.activeDerivedMaps.add(derivedMap);

		return derivedMap;
	}
}

class DerivedMap<K, V> extends ObservableMap<K, V> {
	private unsub?: Unsubscriber;
	public parentCallback: Subscriber<ObservableMap<K, V>>;

	constructor(
		private parentMap: ObservableMap<K, V>,
		private predicate: (value: V, key: K) => boolean,
	) {
		super();

		// Create stable callback reference for parent tracking
		this.parentCallback = () => {
			const newMap = new Map<K, V>();
			this.parentMap.forEach((value, key) => {
				if (this.predicate(value, key)) {
					newMap.set(key, value);
				}
			});
			this._map = newMap;
			this.notifyListeners();
		};

		this.observableName =
			parentMap.observableName + "(filter: " + predicate.toString() + ")";
	}

	private sub(): void {
		if (this.unsub) {
			return;
		}
		// Parent will automatically track this subscription
		this.unsub = this.parentMap.subscribe(this.parentCallback);
	}

	subscribe(run: (value: ObservableMap<K, V>) => unknown): Unsubscriber {
		this.sub();
		return super.subscribe(run);
	}

	unsubscribe(run: (value: ObservableMap<K, V>) => unknown): void {
		super.unsubscribe(run);
		if (this._listeners.size === 0 && this.unsub) {
			this.unsub();
			this.unsub = undefined;
		}
	}

	destroy(): void {
		if (this.destroyed) return;
		
		this.destroyed = true;
		
		if (this.unsub) {
			this.unsub();
			this.unsub = undefined;
		}
		this._listeners?.clear();
		this.parentCallback = null as any;
	}
}
