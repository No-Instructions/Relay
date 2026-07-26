"use strict";

import { Observable } from "../observable/Observable";
import type { Subscriber, Unsubscriber } from "../observable/Observable";
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
 * A single-value store over another store's state, safe to hand outside the
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
 * `Observable` publishes itself — `notifyListeners` hands each listener the
 * sender, and the post office's whole delivery contract is sender to recipient.
 * A single-value store has to publish something else, so each subscriber is
 * registered with the base class as a trampoline closure that ignores the
 * sender and calls the subscriber with the current value.
 *
 * Registering through `super.subscribe`/`super.unsubscribe` rather than
 * hand-rolling delivery is what keeps two properties of the base class:
 *
 * - the first delivery is immediate, because the base sends with the post
 *   office's `immediate` flag, which runs the recipient synchronously;
 * - unsubscribing after teardown is safe in either order, because the base
 *   null-guards its listener set and reaches the post office through
 *   `peekInstance()`, which returns null rather than resurrecting a singleton.
 *
 * The base can only send while there is a post office, and a view outlives it:
 * subscribing after teardown gets its immediate delivery from here instead, so
 * that the value a detached view keeps is a value its subscribers actually
 * receive rather than one only `.value` will admit to.
 */
export class View<T> extends Observable<T> {
	private _value: T;
	private read: (() => T) | null;
	private releaseSource: Unsubscriber | null;
	private trampolines = new Map<Subscriber<T>, Subscriber<T>>();

	constructor(source: ViewSource, read: () => T, observableName?: string) {
		super(observableName);
		this.read = read;
		// Read eagerly and track from here on. The view is live before anyone
		// observes it, so `.value` answers straight away and a first subscriber
		// is not the thing that starts it working.
		this._value = read();
		this.releaseSource = source.on(() => {
			this.refresh();
		});
	}

	override get value(): T {
		return this._value;
	}

	private refresh(): void {
		if (!this.read) return;
		this._value = this.read();
		this.notifyListeners();
	}

	override subscribe(run: Subscriber<T>): Unsubscriber {
		// One trampoline per subscriber, reused if the same function subscribes
		// twice — the base holds listeners in a Set, so a repeat subscription is
		// already one entry there and must stay one here. The consequence is
		// worth stating: subscribing the same function twice is one
		// subscription, delivered once per change, and either unsubscriber
		// releases it. A caller wanting two independent subscriptions passes two
		// functions. Registering a fresh trampoline per call would give the base
		// two Set entries for one subscriber and deliver to it twice per change,
		// which is the worse of the two answers.
		let trampoline = this.trampolines.get(run);
		if (!trampoline) {
			trampoline = () => {
				run(this._value);
			};
			this.trampolines.set(run, trampoline);
		}
		super.subscribe(trampoline);
		if (PostOffice.isDestroyed()) {
			// The base delivers the first value through the post office, and the
			// post office is gone once the plugin has unloaded — so the base
			// registers the subscriber and tells it nothing, here or ever. That
			// is fine for a store whose life ends with the plugin's, and wrong
			// for one a consumer still holds: this view goes on answering with
			// the value frozen at teardown, and a subscriber that is never called
			// even once is left holding nothing at all rather than that value.
			// The first delivery stays unconditional; only the updates stop.
			run(this._value);
		}
		return () => {
			this.unsubscribe(run);
		};
	}

	override unsubscribe(run: Subscriber<T>): void {
		const trampoline = this.trampolines.get(run);
		// Nothing registered for this subscriber: either it never subscribed or
		// it already unsubscribed. Returning here rather than falling through to
		// the base also avoids cancelling the caller's pending mail from other
		// senders, which is what `PostOffice.cancel` would do.
		if (!trampoline) return;
		this.trampolines.delete(run);
		super.unsubscribe(trampoline);
	}

	/**
	 * Stop tracking the source.
	 *
	 * The view keeps answering — anything still holding it reads the value as of
	 * this moment — but it no longer follows the source. Subscribers are left in
	 * place: releasing them is theirs to do, and `unsubscribe` stays safe
	 * afterwards whichever side goes first.
	 */
	detach(): void {
		this.read = null;
		this.releaseSource?.();
		this.releaseSource = null;
	}

	override destroy(): void {
		// Releasing the source first: the base only knows about this view's own
		// listeners, so without this the hook registered on the source would
		// outlive the view.
		this.detach();
		this.trampolines.clear();
		super.destroy();
	}
}
