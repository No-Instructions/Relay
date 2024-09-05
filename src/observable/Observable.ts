"use strict";

import { curryLog } from "src/debug";
import type { Unsubscriber, Subscriber } from "svelte/store";
import { PostOffice } from "./Postie";

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

export class Observable<T> implements IObservable<T> {
	protected _listeners: Set<Subscriber<T>>;

	constructor(public observableName?: string) {
		const warn = curryLog("[Observable]", "warn");
		observables.set(this, () => {
			if (this._listeners && this._listeners.size > 0) {
				warn(
					`Missing tear down of ${this._listeners.size} listeners`,
					this,
					this._listeners,
				);
			}
		});
		this._listeners = new Set();
	}

	notifyListeners(): void {
		for (const recipient of this._listeners) {
			PostOffice.getInstance().send(
				this as unknown as T & IObservable<T>,
				recipient,
			);
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
		PostOffice.getInstance().send(
			this as unknown as T & IObservable<T>,
			run,
			true,
		);
		return () => {
			this.unsubscribe(run);
		};
	}

	off(listener: () => void): void {
		this._listeners.delete(listener);
	}

	unsubscribe(run: Subscriber<T>): void {
		this._listeners.delete(run);
	}

	destroy() {
		this._listeners.clear();
		this._listeners = null as any;
	}
}
