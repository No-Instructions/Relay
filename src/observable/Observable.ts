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
		if (this._listeners) {
			this._listeners.delete(run);
		}
	}

	destroy() {
		this.destroyed = true;
		if (this.unsubscribes) {
			this.unsubscribes.forEach((unsub) => {
				unsub();
			});
		}
		this._listeners?.clear();
		this._listeners = null as any;
	}
}
