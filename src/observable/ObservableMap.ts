"use strict";

import type { Unsubscriber } from "svelte/store";
import { Observable } from "./Observable";
import type { Subscriber } from "./Observable";

/** Delta subscriber: called with the map and the keys changed since its last delivery. */
export type MapChangeSubscriber<K, V> = (
	map: ObservableMap<K, V>,
	changed: ReadonlySet<K>,
) => void;

export class ObservableMap<K, V> extends Observable<ObservableMap<K, V>> {
	protected _map: Map<K, V>;
	protected _derivedMaps: WeakMap<
		(value: V, key: K) => boolean,
		DerivedMap<K, V>
	>;
	private derivedMapRefCounts = new WeakMap<DerivedMap<K, V>, number>();
	private activeDerivedMaps = new Set<DerivedMap<K, V>>();
	// One changed-key buffer per delta subscriber, drained at delivery. The
	// PostOffice coalesces notifications within its window, so a burst of
	// sets reaches each subscriber as one delivery carrying the union.
	private changeBuffers = new Map<
		Subscriber<ObservableMap<K, V>>,
		Set<K>
	>();

	constructor(public observableName?: string) {
		super();
		this._map = new Map();
		this._derivedMaps = new WeakMap();
	}

	private recordChange(key: K): void {
		for (const buffer of this.changeBuffers.values()) {
			buffer.add(key);
		}
	}

	set(key: K, value: V): ObservableMap<K, V> {
		this._map.set(key, value);
		this.recordChange(key);
		this.notifyListeners();
		return this;
	}

	delete(key: K): boolean {
		const result = this._map.delete(key);
		if (result) {
			this.recordChange(key);
			this.notifyListeners();
		}
		return result;
	}

	clear(): void {
		if (this.changeBuffers.size > 0) {
			for (const key of this._map.keys()) {
				this.recordChange(key);
			}
		}
		this._map.clear();
		this.notifyListeners();
	}

	/**
	 * Subscribe to change deltas: each delivery carries the set of keys
	 * whose entries were set or deleted since this subscriber's previous
	 * delivery. The initial delivery carries every current key, so a fresh
	 * subscriber paints from scratch; an empty delta is not delivered.
	 *
	 * Deltas track the mutating methods (`set`, `delete`, `clear`) only: a
	 * notification published through a raw `notifyListeners()` — including
	 * a derived map's wholesale replacement — carries no keys and is
	 * suppressed, so delta subscriptions are for maps mutated exclusively
	 * through those methods. A callback must not mutate the map it
	 * subscribes to: the PostOffice collapses same-sender re-entrant mail
	 * into the in-flight delivery, so a key recorded during the callback
	 * would wait for the next unrelated mutation to be delivered.
	 */
	subscribeChanges(run: MapChangeSubscriber<K, V>): Unsubscriber {
		const wrapper: Subscriber<ObservableMap<K, V>> = (map) => {
			const buffer = this.changeBuffers.get(wrapper);
			if (!buffer || buffer.size === 0) return;
			this.changeBuffers.set(wrapper, new Set());
			run(map, buffer);
		};
		this.changeBuffers.set(wrapper, new Set(this._map.keys()));
		const unsubscribe = this.subscribe(wrapper);
		return () => {
			this.changeBuffers.delete(wrapper);
			unsubscribe();
		};
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

		// Eagerly populate the map so .values() works without subscribing
		this.parentCallback(this.parentMap);
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
		this.parentCallback = null as unknown as typeof this.parentCallback;
	}
}
