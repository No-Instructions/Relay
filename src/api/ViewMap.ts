"use strict";

import type { Unsubscriber } from "../observable/Observable";
import { ObservableMap } from "../observable/ObservableMap";

/**
 * Maps one source entry to its public value.
 *
 * Projection and dropping are one operation: returning `undefined` means the
 * entry produces no valid public value and is absent from the view.
 */
export type Projection<K, S, U> = (value: S, key: K) => U | undefined;

/**
 * A keyed store over another map's entries, safe to hand outside the plugin.
 *
 * What separates a view from the derived stores in `../observable/` is
 * lifecycle. A derived store attaches when something observes it and detaches
 * when the last observer leaves, so its lifetime follows its parent. A view
 * attaches when it is constructed and detaches when its owner says so. That is
 * what makes it safe to hand across a plugin boundary: whoever receives one may
 * hold it indefinitely, and the owner still decides when it stops tracking.
 *
 * A detached view keeps its last contents, holds nothing upstream, and stays
 * safe to read and unsubscribe from in any order.
 *
 * A map store publishes itself, which is what the base class already does, so
 * subscription is inherited whole: the first delivery is immediate, and
 * unsubscribing after teardown is safe in either order because the base
 * null-guards its listener set and reaches the post office through
 * `peekInstance()`.
 *
 * `S` is the source entry type. It is only ever inferred from the source map —
 * the public shape of the store is `K` and `U`.
 */
export class ViewMap<K, U, S> extends ObservableMap<K, U> {
	private source: ObservableMap<K, S> | null;
	private project: Projection<K, S, U> | null;
	private releaseSource: Unsubscriber | null;

	constructor(
		source: ObservableMap<K, S>,
		// `NoInfer` pins the source entry type to the map: a projection whose
		// parameter is merely compatible (a wider structural shape, say) is
		// checked against `S` rather than allowed to redefine it.
		project: Projection<K, NoInfer<S>, U>,
		observableName?: string,
	) {
		super(observableName);
		this.source = source;
		this.project = project;
		// Projected eagerly and tracked from here on. The view is live before
		// anyone observes it, so `get`, `values` and `size` answer straight away
		// and a first subscriber is not the thing that starts it working.
		this._map = this.projectSource();
		this.releaseSource = source.on(() => {
			this.refresh();
		});
	}

	private projectSource(): Map<K, U> {
		const projected = new Map<K, U>();
		const source = this.source;
		const project = this.project;
		if (!source || !project) return projected;
		source.forEach((value, key) => {
			const publicValue = project(value, key);
			if (publicValue !== undefined) {
				projected.set(key, publicValue);
			}
		});
		return projected;
	}

	private refresh(): void {
		if (!this.source) return;
		// Rebuilt into a fresh map rather than patched in place: the source
		// notifies that it changed, not how, and a whole reprojection is the only
		// answer that covers an entry appearing, changing, and going away.
		this._map = this.projectSource();
		this.notifyListeners();
	}

	/**
	 * Stop tracking the source.
	 *
	 * The view keeps answering — anything still holding it reads the entries as
	 * of this moment — but it no longer follows the source. Subscribers are left
	 * in place: releasing them is theirs to do, and `unsubscribe` stays safe
	 * afterwards whichever side goes first.
	 */
	detach(): void {
		this.releaseSource?.();
		this.releaseSource = null;
		this.source = null;
		this.project = null;
	}

	override destroy(): void {
		// Releasing the source first: the base only knows about this view's own
		// listeners, so without this the hook registered on the source would
		// outlive the view.
		this.detach();
		super.destroy();
	}
}
