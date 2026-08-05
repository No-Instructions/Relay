"use strict";

import type { Subscriber, Unsubscriber } from "../observable/Observable";
import {
	Delivery,
	type ViewHandle,
	type ViewLifecycle,
	type ViewSource,
} from "./Delivery";

export type { ViewHandle, ViewSource };

function copyValue<V>(value: V): V {
	if (value === null || typeof value !== "object") return value;
	return { ...value } as V;
}

export class View<T> {
	#state: T;
	#read: (() => T) | null;
	#releaseSource: Unsubscriber | null;
	#delivery: Delivery<T>;
	#lifecycle?: ViewLifecycle;

	private constructor(
		source: ViewSource,
		read: () => T,
		observableName?: string,
		lifecycle?: ViewLifecycle,
	) {
		this.#read = read;
		this.#state = read();
		this.#delivery = new Delivery<T>(
			() => copyValue(this.#state),
			observableName,
		);
		this.#lifecycle = lifecycle;
		this.#releaseSource = source.on(() => {
			this.#refresh();
		});
		Object.freeze(this);
	}

	static create<V>(
		source: ViewSource,
		read: () => V,
		observableName?: string,
		lifecycle?: ViewLifecycle,
	): ViewHandle<View<V>> {
		const view = new View<V>(source, read, observableName, lifecycle);
		return Object.freeze({
			view,
			detach: () => {
				view.#detach();
			},
		});
	}

	get value(): T {
		this.#assertAttached();
		return copyValue(this.#state);
	}

	subscribe(run: Subscriber<T>): Unsubscriber {
		this.#assertAttached();
		return this.#delivery.subscribe(run);
	}

	unsubscribe(run: Subscriber<T>): void {
		this.#delivery.unsubscribe(run);
	}

	#assertAttached(): void {
		if (this.#lifecycle && !this.#lifecycle.attached) {
			throw new Error(this.#lifecycle.error);
		}
	}

	#refresh(): void {
		if (!this.#read) return;
		this.#state = this.#read();
		this.#delivery.notify();
	}

	#detach(): void {
		this.#read = null;
		this.#releaseSource?.();
		this.#releaseSource = null;
	}
}

Object.freeze(View.prototype);
Object.freeze(View);
