"use strict";

import { curryLog } from "src/debug";
import type { Unsubscriber, Subscriber } from "svelte/store";

const observables = new Map<Observable<any>, () => void>();

export function auditTeardown(): void {
	for (const [, auditTeardown] of observables) {
		auditTeardown();
	}
	observables.clear();
}

export class Observable<T> {
	protected _listeners: Set<Subscriber<T>>;

	constructor() {
		const warn = curryLog("[Observable]", "warn");
		observables.set(this, () => {
			if (this._listeners.size > 0) {
				warn(
					`Missing tear down of ${this._listeners.size} listeners`,
					this,
					this._listeners
				);
			}
		});
		this._listeners = new Set();
	}

	notifyListeners(): void {
		for (const listener of this._listeners) {
			listener(this as unknown as T);
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
