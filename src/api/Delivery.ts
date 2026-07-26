"use strict";

import type { IObservable, Subscriber, Unsubscriber } from "../observable/Observable";
import { PostOffice } from "../observable/Postie";

/**
 * What a view needs from the store it watches: a change hook it can release
 * again. Narrow on purpose — it makes any observable a source regardless of
 * what that observable publishes to its own subscribers.
 */
export interface ViewSource {
	on(listener: () => void): Unsubscriber;
}

/**
 * What building a view produces: the object handed to consumers, and the only
 * control over it.
 *
 * Detaching is deliberately not a method on the view. A view is handed across a
 * plugin boundary, where anything reachable on the object is reachable by
 * whoever holds it — and one consumer detaching the shared store would freeze
 * the contents for every other consumer, permanently and with no error. The
 * capability lives here instead, on an object only Relay is given.
 */
export interface ViewHandle<V> {
	readonly view: V;
	readonly detach: () => void;
}

/**
 * Subscriber bookkeeping and delivery for one view.
 *
 * The views do not extend `Observable`. They need four things from it — a
 * listener set, the post office fan-out, the immediate first delivery, and an
 * unsubscribe that stays safe after teardown — and inheriting them would also
 * inherit `notifyListeners`, `destroy`, `on`/`off` and the logging surface onto
 * an object that is handed to other plugins. Those four things live here, in a
 * private field of the view, so the view's own surface is exactly what it
 * publishes.
 *
 * Delivery is trampolined. The post office's contract is sender to recipient —
 * `send(sender, recipient)` ends in `recipient(sender)` — so a store that
 * publishes anything other than the object doing the sending has to register a
 * closure that ignores the sender and passes the published value on. That is
 * what `publish` is for: a single-value view publishes its value, a map view
 * publishes the map.
 *
 * The trampoline is memoized per subscriber, which fixes the meaning of
 * subscribing the same function twice: it is one registration, delivered once
 * per change, released by either unsubscriber. A caller wanting two independent
 * subscriptions passes two functions.
 *
 * Memoization also buys the guard in `unsubscribe`. Handing an unrecognised
 * function to `PostOffice.cancel` would drop that function's pending mail from
 * every other sender, so an unknown subscriber is dropped here rather than
 * passed on.
 */
export class Delivery<P> {
	#listeners = new Set<Subscriber<P>>();
	#trampolines = new Map<Subscriber<P>, Subscriber<P>>();
	#publish: () => P;

	constructor(
		publish: () => P,
		/** Read by the post office's diagnostics; never handed out. */
		public readonly observableName?: string,
	) {
		this.#publish = publish;
	}

	subscribe(run: Subscriber<P>): Unsubscriber {
		let trampoline = this.#trampolines.get(run);
		if (!trampoline) {
			trampoline = () => {
				run(this.#publish());
			};
			this.#trampolines.set(run, trampoline);
		}
		this.#listeners.add(trampoline);
		if (PostOffice.isDestroyed()) {
			// The first delivery normally comes from the post office, and the post
			// office is gone once the plugin has unloaded — which would leave this
			// subscriber registered and told nothing, here or ever. That is fine for
			// a store whose life ends with the plugin's, and wrong for one a
			// consumer still holds: the view goes on answering with the state frozen
			// at teardown, and a subscriber that is never called even once is left
			// holding nothing at all rather than that state. The first delivery
			// stays unconditional; only the updates stop.
			run(this.#publish());
		} else {
			// `immediate` runs the recipient synchronously, so a subscriber has the
			// current value before `subscribe` returns.
			PostOffice.getInstance().send(
				this as unknown as P & IObservable<P>,
				trampoline,
				true,
			);
		}
		return () => {
			this.unsubscribe(run);
		};
	}

	unsubscribe(run: Subscriber<P>): void {
		const trampoline = this.#trampolines.get(run);
		// Nothing registered for this subscriber: either it never subscribed or it
		// already unsubscribed. Returning here rather than cancelling anyway is
		// what keeps a stranger's pending mail from other senders intact.
		if (!trampoline) return;
		this.#trampolines.delete(run);
		this.#listeners.delete(trampoline);
		// peekInstance rather than getInstance: after teardown the former returns
		// null while the latter throws and, worse, would resurrect the singleton.
		PostOffice.peekInstance()?.cancel(trampoline);
	}

	notify(): void {
		if (PostOffice.isDestroyed()) return;
		const postie = PostOffice.getInstance();
		for (const recipient of this.#listeners) {
			postie.send(this as unknown as P & IObservable<P>, recipient);
		}
	}
}
