"use strict";

import type { Unsubscriber, Subscriber } from "svelte/store";

export class Observable<T> {
	protected _listeners: Set<Subscriber<T>>;

	constructor() {
		this._listeners = new Set();
	}

	notifyListeners(): void {
		for (const listener of this._listeners) {
			listener(this as unknown as T);
		}
	}

	on(listener: () => void): void {
		this._listeners.add(listener);
	}

	subscribe(run: Subscriber<T>): Unsubscriber {
		this._listeners.add(run);
		run(this as unknown as T);
		return () => {
			this.unsubscribe(run);
		};
	}

	off(listener: () => void): void {
		this._listeners.delete(listener);
	}

	unsubscribe(run: (value: T) => unknown): void {
		this._listeners.delete(run);
	}
}
