import type { EventRef } from "obsidian";

export type Unsubscriber = () => void;

export interface Observable<T> {
	readonly value: T;
	subscribe(run: (value: T) => void): Unsubscriber;
	unsubscribe(run: (value: T) => void): void;
}

export interface ObservableMap<K, V> extends Observable<ObservableMap<K, V>> {
	get(key: K): V | undefined;
	has(key: K): boolean;
	keys(): K[];
	values(): V[];
	entries(): [K, V][];
	forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void): void;
	readonly size: number;
}

export interface User {
	id: string;
	name: string;
	picture?: string;
	color?: string;
}

/**
 * A view Relay drives live edits into.
 *
 * The registered view type must resolve to a view extending Obsidian's
 * `TextFileView`, and `setViewData` must round-trip through `getViewData`:
 * Relay pushes merged document text in through `setViewData` and reads local
 * edits back out through `getViewData`, so a view that renders a projection
 * it cannot reproduce as text will lose edits.
 */
export interface LiveTextViewV0 {
	getViewType(): string;
	getViewData(): string;
	setViewData(data: string, clear: boolean): void;
}

export interface ApiV0 {
	identity: {
		users: ObservableMap<string, User>;
		currentUser: Observable<User | null>;
	};
	/**
	 * Register a {@link LiveTextViewV0} view type for live editing.
	 *
	 * The registration is persisted, so a leaf of this view type restored on
	 * a cold start attaches before the registering plugin has loaded. It is
	 * removed by the returned {@link Unsubscriber}, or dropped at startup
	 * once the view type no longer resolves in the app's view registry
	 * (the registering plugin was disabled or uninstalled). Re-registering
	 * the same pair is idempotent, so registering on every load is the
	 * expected pattern.
	 */
	registerView(pluginId: string, viewType: string): Unsubscriber;
}

export interface Api {
	v0: ApiV0;
}

declare module "obsidian" {
	interface Workspace {
		on(
			name: "system3-relay:api-ready",
			callback: (api: Api) => void,
		): EventRef;
		trigger(name: "system3-relay:api-ready", api: Api): void;
	}
}
