import type { EventRef } from "obsidian";

/**
 * Relay's public plugin API: a read surface over the people involved in a
 * shared folder, for rendering an avatar beside a comment or a name on a
 * suggestion.
 *
 * A consumer holding the API can read the current set of known users, and the
 * current user, synchronously — and be notified when either changes. Identity
 * is global: a user id resolves the same way from anywhere.
 *
 * This file is standalone and compiles on its own. Copy it into your plugin or
 * reference it from a checkout. Its only import is `EventRef`, which the module
 * augmentation below needs in order to type the ready event, and which every
 * consuming plugin already has.
 *
 * Two ways to reach the same container:
 *
 * ```ts
 * // Loaded before Relay: wait for the event.
 * app.workspace.on("system3-relay:api-ready", (api) => {
 *   const v0 = api.v0;
 *   if (!v0) return;
 * });
 *
 * // Loaded after Relay: read it off the registry.
 * const relay = app.plugins.plugins["system3-relay"];
 * const v0 = relay?.api?.v0;
 * if (!v0) return;
 * ```
 *
 * The optional chain is the whole readiness check. Names here are unprefixed;
 * alias at your import when one meets a name of your own —
 * `import type { User as RelayUser }`. `Observable` is also RxJS's best known
 * export, so a consumer using both will alias one of them.
 */

/** Releases a subscription. */
export type Unsubscriber = () => void;

/**
 * A store you can read now or follow. Satisfies the Svelte store contract, so
 * `$store` works in a component and `subscribe` works from plain TypeScript.
 *
 * `subscribe` fires immediately with the current value, then on each change.
 * `.value` performs the same read without subscribing. Once Relay unloads a
 * store stops changing, but it keeps answering: `.value` and a subscription
 * that arrives afterwards both give the contents as of teardown.
 *
 * One subscription per function: subscribing the same function twice is a
 * single subscription that is delivered once per change, and either unsubscriber
 * releases it. Pass two functions for two independent subscriptions.
 *
 * A store is read-only, and the object is what it declares. There is nothing on
 * it that writes to it, stops it, or reaches what it reads from — not behind a
 * cast either. Every consumer is handed the same store, so anything that could
 * change one consumer's view would change everyone's.
 */
export interface Observable<T> {
	readonly value: T;
	subscribe(run: (value: T) => void): Unsubscriber;
	unsubscribe(run: (value: T) => void): void;
}

/**
 * A keyed store. It publishes itself, so `$users.get(id)` reads naturally in a
 * template and `users.value` is the map.
 *
 * `keys`, `values` and `entries` each return a fresh array, and the `map`
 * argument `forEach` passes its callback is a copy of the contents at the start
 * of the iteration. Writing to any of them changes nothing.
 */
export interface ObservableMap<K, V> extends Observable<ObservableMap<K, V>> {
	get(key: K): V | undefined;
	has(key: K): boolean;
	keys(): K[];
	values(): V[];
	entries(): [K, V][];
	forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void): void;
	readonly size: number;
}

/**
 * What a consumer needs to render a person: an id, a display name, and
 * optionally a picture and the colours Relay assigns for presence.
 */
export interface User {
	id: string;
	name: string;
	picture?: string;
	color?: string;
	colorLight?: string;
}

export interface ApiV0 {
	identity: {
		/** Every user Relay knows, keyed by id. */
		users: ObservableMap<string, User>;
		/** The signed-in user, or null when nobody is signed in. */
		currentUser: Observable<User | null>;
	};
}

/**
 * The container. It is stable; versions live inside it, and `api.v0` existing
 * is the version assertion. A new version arrives as a new key alongside the
 * existing one; a retired version's key is removed, and a consumer asking for
 * it receives `undefined` and degrades to whatever it does without Relay.
 */
export interface Api {
	v0: ApiV0;
}

declare module "obsidian" {
	interface Workspace {
		/**
		 * Fires once per load, as soon as the API is constructed, and once more
		 * each time Relay reloads.
		 *
		 * At that moment the stores are live and empty. They fill as the graph
		 * loads and emit as they do, so subscribe once and the contents arrive
		 * when they arrive — readiness is a property of the stores rather than
		 * of the event's timing.
		 *
		 * Use the most recent API. Release any you were holding: an API object
		 * is bound to the Relay instance that produced it, and one kept across a
		 * reload answers with the state frozen at teardown.
		 *
		 * A plugin that loads after Relay has already missed the event; it
		 * reads the container off the plugin registry instead.
		 */
		on(
			name: "system3-relay:api-ready",
			callback: (api: Api) => void,
		): EventRef;
		trigger(name: "system3-relay:api-ready", api: Api): void;
	}
}
