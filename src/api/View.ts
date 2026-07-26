"use strict";

import type { Subscriber, Unsubscriber } from "../observable/Observable";
import { Delivery, type ViewHandle, type ViewSource } from "./Delivery";
import type { Copy } from "./ViewMap";

export type { ViewHandle, ViewSource };

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

	#detach(): void {
		this.#read = null;
		this.#releaseSource?.();
		this.#releaseSource = null;
	}
}

Object.freeze(View.prototype);
Object.freeze(View);
