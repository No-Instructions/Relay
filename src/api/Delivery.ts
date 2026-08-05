"use strict";

import type { IObservable, Subscriber, Unsubscriber } from "../observable/Observable";
import { PostOffice } from "../observable/Postie";

export interface ViewSource {
	on(listener: () => void): Unsubscriber;
}

export interface ViewHandle<V> {
	readonly view: V;
	readonly detach: () => void;
}

export interface ViewLifecycle {
	attached: boolean;
	error: string;
}

export class Delivery<P> {
	#listeners = new Set<Subscriber<P>>();
	#trampolines = new Map<Subscriber<P>, Subscriber<P>>();
	#publish: () => P;

	constructor(
		publish: () => P,
		public readonly observableName?: string,
	) {
		this.#publish = publish;
	}

	subscribe(run: Subscriber<P>): Unsubscriber {
		let trampoline = this.#trampolines.get(run);
		if (!trampoline) {
			trampoline = () => {
				run(this.#publish());
			};
			this.#trampolines.set(run, trampoline);
		}
		this.#listeners.add(trampoline);
		if (PostOffice.isDestroyed()) {
			run(this.#publish());
		} else {
			PostOffice.getInstance().send(
				this as unknown as P & IObservable<P>,
				trampoline,
				true,
			);
		}
		return () => {
			this.unsubscribe(run);
		};
	}

	unsubscribe(run: Subscriber<P>): void {
		const trampoline = this.#trampolines.get(run);
		if (!trampoline) return;
		this.#trampolines.delete(run);
		this.#listeners.delete(trampoline);
		PostOffice.peekInstance()?.cancel(trampoline);
	}

	notify(): void {
		if (PostOffice.isDestroyed()) return;
		const postie = PostOffice.getInstance();
		for (const recipient of this.#listeners) {
			postie.send(this as unknown as P & IObservable<P>, recipient);
		}
	}
}
