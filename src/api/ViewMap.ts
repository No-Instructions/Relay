"use strict";

import type { Subscriber, Unsubscriber } from "../observable/Observable";
import type { ObservableMap } from "../observable/ObservableMap";
import { Delivery, type ViewHandle } from "./Delivery";

/**
 * Maps one source entry to its public value.
 *
 * Projection and dropping are one operation: returning `undefined` means the
 * entry produces no valid public value and is absent from the view.
 */
export type Projection<K, S, U> = (value: S, key: K) => U | undefined;

/**
 * A read-only keyed store over another map's entries, safe to hand outside the
 * plugin.
 *
 * What separates a view from the derived stores in `../observable/` is
 * lifecycle. A derived store attaches when something observes it and detaches
 * when the last observer leaves, so its lifetime follows its parent. A view
 * attaches when it is constructed and detaches when its owner says so. That is
 * what makes it safe to hand across a plugin boundary: whoever receives one may
 * hold it indefinitely, and the owner still decides when it stops tracking.
 *
 * A detached view keeps its last contents, holds nothing upstream, and stays
 * safe to read and unsubscribe from in any order.
 *
 * This is not an `ObservableMap`. A map a consumer can write to is not a view
 * of anything: `set`, `delete` and `clear` would rewrite the shared projection
 * and announce the forged contents to every other consumer as a real change,
 * and `filter` would grow a derived map on it per predicate. Inheriting the
 * read accessors is not worth inheriting those, so the seven reads and the
 * backing map live here and the delivery machinery lives in `Delivery`.
 * Everything the map keeps is in real private fields and the instance is
 * frozen, so read-only holds against a cast rather than only against the
 * compiler. Detaching is a capability on the handle `create` returns, because a
 * consumer calling it would freeze the directory for every other consumer with
 * no error and no recovery; there is no `destroy` at all.
 *
 * `S` is the source entry type. It is only ever inferred from the source map —
 * the public shape of the store is `K` and `U`.
 */
export class ViewMap<K, U, S> {
	#map: Map<K, U>;
	#source: ObservableMap<K, S> | null;
	#project: Projection<K, S, U> | null;
	#releaseSource: Unsubscriber | null;
	#delivery: Delivery<ViewMap<K, U, S>>;

	private constructor(
		source: ObservableMap<K, S>,
		project: Projection<K, S, U>,
		observableName?: string,
	) {
		this.#source = source;
		this.#project = project;
		// Projected eagerly and tracked from here on. The view is live before
		// anyone observes it, so `get`, `values` and `size` answer straight away
		// and a first subscriber is not the thing that starts it working.
		this.#map = this.#projectSource();
		this.#delivery = new Delivery<ViewMap<K, U, S>>(() => this, observableName);
		this.#releaseSource = source.on(() => {
			this.#refresh();
		});
		Object.freeze(this);
	}

	/**
	 * Builds a view and returns it alongside the only control over it.
	 *
	 * A static factory rather than a public constructor because the two results
	 * have to go to different places: `view` is handed to consumers, `detach`
	 * stays with Relay. Reachable from a handed-out view through its constructor,
	 * which is harmless — it builds a new view over a source the caller already
	 * has and grants nothing over an existing one.
	 */
	static create<K2, U2, S2>(
		source: ObservableMap<K2, S2>,
		// `NoInfer` pins the source entry type to the map: a projection whose
		// parameter is merely compatible (a wider structural shape, say) is
		// checked against `S2` rather than allowed to redefine it.
		project: Projection<K2, NoInfer<S2>, U2>,
		observableName?: string,
	): ViewHandle<ViewMap<K2, U2, S2>> {
		const view = new ViewMap<K2, U2, S2>(source, project, observableName);
		return Object.freeze({
			view,
			detach: () => {
				view.#detach();
			},
		});
	}

	/** A keyed store publishes itself, so `$users.get(id)` reads in a template. */
	get value(): ViewMap<K, U, S> {
		return this;
	}

	get size(): number {
		return this.#map.size;
	}

	get(key: K): U | undefined {
		return this.#map.get(key);
	}

	has(key: K): boolean {
		return this.#map.has(key);
	}

	keys(): K[] {
		return [...this.#map.keys()];
	}

	values(): U[] {
		return [...this.#map.values()];
	}

	entries(): [K, U][] {
		return [...this.#map.entries()];
	}

	forEach(callbackfn: (value: U, key: K, map: Map<K, U>) => void): void {
		// The third argument a `Map` hands its callback is the map being iterated.
		// Passing the backing store would be a writable handle on the projection —
		// the same hole as a `set` method, reached through an argument — so the
		// iteration runs over a copy and the callback receives that instead.
		const snapshot = new Map(this.#map);
		snapshot.forEach(callbackfn);
	}

	subscribe(run: Subscriber<ViewMap<K, U, S>>): Unsubscriber {
		return this.#delivery.subscribe(run);
	}

	unsubscribe(run: Subscriber<ViewMap<K, U, S>>): void {
		this.#delivery.unsubscribe(run);
	}

	#projectSource(): Map<K, U> {
		const projected = new Map<K, U>();
		const source = this.#source;
		const project = this.#project;
		if (!source || !project) return projected;
		source.forEach((value, key) => {
			const publicValue = project(value, key);
			if (publicValue !== undefined) {
				projected.set(key, publicValue);
			}
		});
		return projected;
	}

	#refresh(): void {
		if (!this.#source) return;
		// Rebuilt into a fresh map rather than patched in place: the source
		// notifies that it changed, not how, and a whole reprojection is the only
		// answer that covers an entry appearing, changing, and going away.
		this.#map = this.#projectSource();
		this.#delivery.notify();
	}

	/**
	 * Stop tracking the source.
	 *
	 * The view keeps answering — anything still holding it reads the entries as
	 * of this moment — but it no longer follows the source, and dropping the
	 * source and the projection is what leaves a consumer holding a small inert
	 * object rather than a handle on Relay's own user directory. Subscribers are
	 * left in place: releasing them is theirs to do, and `unsubscribe` stays safe
	 * afterwards whichever side goes first.
	 */
	#detach(): void {
		this.#releaseSource?.();
		this.#releaseSource = null;
		this.#source = null;
		this.#project = null;
	}
}

// A consumer cannot add to a frozen instance, but without this it could still
// replace a method for everyone by writing through the shared prototype.
Object.freeze(ViewMap.prototype);
