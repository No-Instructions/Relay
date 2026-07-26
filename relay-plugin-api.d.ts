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

export interface ApiV0 {
	identity: {
		users: ObservableMap<string, User>;
		currentUser: Observable<User | null>;
	};
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
