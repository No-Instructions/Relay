"use strict";

import { HasLogging } from "../debug";
import { PostOffice } from "./Postie";

/** Callback to inform of a value updates. */
export type Subscriber<T> = (value: T) => void;

/** Unsubscribes from value updates. */
export type Unsubscriber = () => void;

const observables = new Map<Observable<any>, () => void>();

export function auditTeardown(): void {
	for (const [, auditTeardown] of observables) {
		auditTeardown();
	}
	observables.clear();
}

export interface IObservable<T> {
	on(listener: () => void): Unsubscriber;
	subscribe(run: Subscriber<T>): Unsubscriber;
	off(listener: () => void): void;
	unsubscribe(run: Subscriber<T>): void;
}

export class Observable<T> extends HasLogging implements IObservable<T> {
	protected _listeners: Set<Subscriber<T>>;
	protected unsubscribes: Unsubscriber[];
	protected destroyed: boolean = false;

	constructor(public observableName?: string) {
		super();
		observables.set(this, () => {
			if (this._listeners && this._listeners.size > 0) {
				this.warn(
					`Missing tear down of ${this._listeners.size} listeners on ${this.observableName}`,
				);
			}
		});
		this._listeners = new Set();
		this.unsubscribes = [];
	}

	/**
	 * The current value, read without subscribing. `subscribe` delivers exactly
	 * this — immediately on subscription, then again on every change.
	 *
	 * The base class publishes itself: `notifyListeners` hands each listener the
	 * sender, so a plain `Observable<T>`, and `ObservableMap`/`ObservableSet`
	 * which are observables of themselves, read back as themselves.
	 *
	 * A subclass that overrides `notifyListeners` or `subscribe` to deliver a
	 * separate value must override this accessor to return that same value, or
	 * `.value` and `subscribe` will disagree.
	 *
	 * The one place they part company is after the post office is destroyed:
	 * `.value` still answers, while `subscribe` registers the listener and
	 * delivers nothing, here or ever. Internally that is the end of the plugin's
	 * life and nothing is left to tell. A store meant to outlive it — one handed
	 * to another plugin, which keeps answering long after Relay unloads — owes
	 * its subscribers the immediate delivery anyway, and makes it itself; see
	 * `src/api/Delivery.ts`.
	 */
	get value(): T {
		return this as unknown as T;
	}

	notifyListeners(): void {
		if (PostOffice.isDestroyed()) return;
		const postie = PostOffice.getInstance();
		for (const recipient of this._listeners) {
			postie.send(this as unknown as T & IObservable<T>, recipient);
		}
	}

	on(listener: () => void): Unsubscriber {
		this._listeners.add(listener);
		return () => {
			this.off(listener);
		};
	}

	subscribe(run: Subscriber<T>): Unsubscriber {
		this._listeners.add(run);
		if (!PostOffice.isDestroyed()) {
			PostOffice.getInstance().send(
				this as unknown as T & IObservable<T>,
				run,
				true,
			);
		}
		return () => {
			this.unsubscribe(run);
		};
	}

	off(listener: () => void): void {
		// May be called during plugin teardown after destroy() nulled
		// _listeners — e.g. FolderNavigationDecorations holds off() closures
		// from SharedFolder.fset.on() and fires them in its own destroy.
		// If the SharedFolder was destroyed first, _listeners is null by
		// the time the closure runs. Match unsubscribe()'s null guard.
		this._listeners?.delete(listener);
		// Use peekInstance: getInstance() throws after PostOffice.destroy()
		// and auto-creates a fresh singleton if instance is null, which
		// would leak the entire mail graph through unbounded mailbox
		// accumulation when off() runs from async cleanup.
		PostOffice.peekInstance()?.cancel(listener);
	}

	unsubscribe(run: Subscriber<T>): void {
		if (this._listeners) {
			this._listeners.delete(run);
		}
		PostOffice.peekInstance()?.cancel(run);
	}

	destroy() {
		this.destroyed = true;
		observables.delete(this);
		if (this.unsubscribes) {
			this.unsubscribes.forEach((unsub) => {
				unsub();
			});
		}
		if (this._listeners) {
			const postie = PostOffice.peekInstance();
			if (postie) {
				for (const listener of this._listeners) {
					postie.cancel(listener);
				}
			}
			this._listeners.clear();
		}
		this._listeners = null as any;
	}
}
