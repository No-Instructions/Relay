"use strict";

import type { Subscriber, Unsubscriber } from "../observable/Observable";
import type { ObservableMap } from "../observable/ObservableMap";
import { Delivery, type ViewHandle, type ViewLifecycle } from "./Delivery";

export type Projection<K, S, U> = (value: S, key: K) => U | undefined;

function copyValue<V>(value: V): V {
	if (value === null || typeof value !== "object") return value;
	return { ...value } as V;
}

export class ViewMap<K, U, S> {
	#map: Map<K, U>;
	#source: ObservableMap<K, S> | null;
	#project: Projection<K, S, U> | null;
	#releaseSource: Unsubscriber | null;
	#delivery: Delivery<ViewMap<K, U, S>>;
	#lifecycle?: ViewLifecycle;

	private constructor(
		source: ObservableMap<K, S>,
		project: Projection<K, S, U>,
		observableName?: string,
		lifecycle?: ViewLifecycle,
	) {
		this.#source = source;
		this.#project = project;
		this.#map = this.#projectSource();
		this.#delivery = new Delivery<ViewMap<K, U, S>>(() => this, observableName);
		this.#lifecycle = lifecycle;
		this.#releaseSource = source.on(() => {
			this.#refresh();
		});
		Object.freeze(this);
	}

	static create<K2, U2, S2>(
		source: ObservableMap<K2, S2>,
		project: Projection<K2, NoInfer<S2>, U2>,
		observableName?: string,
		lifecycle?: ViewLifecycle,
	): ViewHandle<ViewMap<K2, U2, S2>> {
		const view = new ViewMap<K2, U2, S2>(
			source,
			project,
			observableName,
			lifecycle,
		);
		return Object.freeze({
			view,
			detach: () => {
				view.#detach();
			},
		});
	}

	get value(): ViewMap<K, U, S> {
		this.#assertAttached();
		return this;
	}

	get size(): number {
		this.#assertAttached();
		return this.#map.size;
	}

	get(key: K): U | undefined {
		this.#assertAttached();
		const value = this.#map.get(key);
		return value === undefined ? undefined : copyValue(value);
	}

	has(key: K): boolean {
		this.#assertAttached();
		return this.#map.has(key);
	}

	keys(): K[] {
		this.#assertAttached();
		return [...this.#map.keys()];
	}

	values(): U[] {
		this.#assertAttached();
		return [...this.#map.values()].map(copyValue);
	}

	entries(): [K, U][] {
		this.#assertAttached();
		return [...this.#map.entries()].map(
			([key, value]): [K, U] => [key, copyValue(value)],
		);
	}

	forEach(callbackfn: (value: U, key: K, map: Map<K, U>) => void): void {
		this.#assertAttached();
		const snapshot = new Map<K, U>();
		this.#map.forEach((value, key) => {
			snapshot.set(key, copyValue(value));
		});
		snapshot.forEach(callbackfn);
	}

	subscribe(run: Subscriber<ViewMap<K, U, S>>): Unsubscriber {
		this.#assertAttached();
		return this.#delivery.subscribe(run);
	}

	unsubscribe(run: Subscriber<ViewMap<K, U, S>>): void {
		this.#delivery.unsubscribe(run);
	}

	#assertAttached(): void {
		if (this.#lifecycle && !this.#lifecycle.attached) {
			throw new Error(this.#lifecycle.error);
		}
	}

	#projectSource(): Map<K, U> {
		const projected = new Map<K, U>();
		const source = this.#source;
		const project = this.#project;
		if (!source || !project) return projected;
		source.forEach((value, key) => {
			const publicValue = project(value, key);
			if (publicValue !== undefined) {
				projected.set(key, publicValue);
			}
		});
		return projected;
	}

	#refresh(): void {
		if (!this.#source) return;
		this.#map = this.#projectSource();
		this.#delivery.notify();
	}

	#detach(): void {
		this.#releaseSource?.();
		this.#releaseSource = null;
		this.#source = null;
		this.#project = null;
	}
}

Object.freeze(ViewMap.prototype);
Object.freeze(ViewMap);
