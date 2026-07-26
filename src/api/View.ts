"use strict";

import type { Subscriber, Unsubscriber } from "../observable/Observable";
import { Delivery, type ViewHandle, type ViewSource } from "./Delivery";

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

	private constructor(
		source: ViewSource,
		read: () => T,
		observableName?: string,
	) {
		this.#read = read;
		this.#state = read();
		this.#delivery = new Delivery<T>(
			() => copyValue(this.#state),
			observableName,
		);
		this.#releaseSource = source.on(() => {
			this.#refresh();
		});
		Object.freeze(this);
	}

	static create<V>(
		source: ViewSource,
		read: () => V,
		observableName?: string,
	): ViewHandle<View<V>> {
		const view = new View<V>(source, read, observableName);
		return Object.freeze({
			view,
			detach: () => {
				view.#detach();
			},
		});
	}

	get value(): T {
		return copyValue(this.#state);
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

	#detach(): void {
		this.#read = null;
		this.#releaseSource?.();
		this.#releaseSource = null;
	}
}

Object.freeze(View.prototype);
Object.freeze(View);
