"use strict";

import type { Subscriber, Unsubscriber } from "../observable/Observable";
import { Delivery, type ViewHandle, type ViewSource } from "./Delivery";
import type { Copy } from "./ViewMap";

export type { ViewHandle, ViewSource };

/**
 * A read-only single-value store over another store's state, safe to hand
 * outside the plugin.
 *
 * What separates a view from the derived stores in `../observable/` is
 * lifecycle. A derived store attaches when something observes it and detaches
 * when the last observer leaves, so its lifetime follows its parent. A view
 * attaches when it is constructed and detaches when its owner says so. That is
 * what makes it safe to hand across a plugin boundary: whoever receives one may
 * hold it indefinitely, and the owner still decides when it stops tracking.
 *
 * A detached view keeps its last value, holds nothing upstream, and stays safe
 * to read and unsubscribe from in any order.
 *
 * Read-only is enforced at runtime, not by types. A view is one shared object
 * with many consumers, and `private` is a compile-time annotation a consumer
 * removes with a cast, so anything reachable on the object is a capability
 * every consumer holds over every other one. Hence: state lives in real private
 * fields, which no cast reaches; the instance is frozen, so nothing can be
 * added to it or its prototype swapped; detaching is a capability on the handle
 * `create` returns rather than a method here; and there is no `destroy` at all.
 * What is left is exactly what the store publishes — and what it publishes is a
 * copy of the value it holds, one per read and per delivery, so the state it
 * tracks stays its own.
 */
export class View<T> {
	#state: T;
	#read: (() => T) | null;
	#copy: Copy<T>;
	#releaseSource: Unsubscriber | null;
	#delivery: Delivery<T>;

	private constructor(
		source: ViewSource,
		read: () => T,
		copy: Copy<T>,
		observableName?: string,
	) {
		this.#read = read;
		this.#copy = copy;
		// Read eagerly and track from here on. The view is live before anyone
		// observes it, so `.value` answers straight away and a first subscriber is
		// not the thing that starts it working.
		this.#state = read();
		this.#delivery = new Delivery<T>(
			() => this.#copy(this.#state),
			observableName,
		);
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
	static create<V>(
		source: ViewSource,
		read: () => V,
		copy: Copy<V>,
		observableName?: string,
	): ViewHandle<View<V>> {
		const view = new View<V>(source, read, copy, observableName);
		return Object.freeze({
			view,
			detach: () => {
				view.#detach();
			},
		});
	}

	get value(): T {
		return this.#copy(this.#state);
	}

	subscribe(run: Subscriber<T>): Unsubscriber {
		return this.#delivery.subscribe(run);
	}

	unsubscribe(run: Subscriber<T>): void {
		this.#delivery.unsubscribe(run);
	}

	#refresh(): void {
		if (!this.#read) return;
		this.#state = this.#read();
		this.#delivery.notify();
	}

	/**
	 * Stop tracking the source.
	 *
	 * The view keeps answering — anything still holding it reads the value as of
	 * this moment — but it no longer follows the source, and dropping the read
	 * closure is what leaves a consumer holding a small inert object rather than
	 * a handle on the manager graph behind it. Subscribers are left in place:
	 * releasing them is theirs to do, and `unsubscribe` stays safe afterwards
	 * whichever side goes first.
	 */
	#detach(): void {
		this.#read = null;
		this.#releaseSource?.();
		this.#releaseSource = null;
	}
}

// The instance freeze stops at the instance; the prototype and the class object
// are shared by every view and reachable from one, the prototype through the
// object's own chain and the class through `constructor`. Writing a method on
// either would forge answers for every consumer at once, or change what the next
// `create` builds.
Object.freeze(View.prototype);
Object.freeze(View);
