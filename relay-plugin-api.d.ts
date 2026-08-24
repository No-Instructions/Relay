export interface User {
	id: string;
	name: string;
	picture?: string;
	color?: string;
}

export type RelayEvent<T> = {
	action: "create" | "update" | "delete";
	record: T;
};

/**
 * Relay's data-only plugin boundary.
 *
 * Workspace event delivery is ordered, synchronous, and non-replayed. Events
 * carry full records and consumers must tolerate duplicate delivery. Resolve
 * the API, take snapshots, and install event listeners in one synchronous
 * block, with no await between those operations.
 */
export interface ApiV0 {
	getUsers(): User[];
	getCurrentUser(): User | null;
	/**
	 * Idempotently register a text-file view type. Registrations persist across
	 * Relay reloads and are pruned when the consumer's view type definitively
	 * disappears from Obsidian's view registry.
	 */
	registerView(pluginId: string, viewType: string): void;
	/** Idempotently remove a persisted text-file view registration. */
	unregisterView(pluginId: string, viewType: string): void;
}

/**
 * Resolve this object again from `app.plugins.plugins["system3-relay"]?.api`
 * whenever `system3-relay:api-ready` fires. Calls through an object retained
 * past Relay's unload throw a terminal lifecycle error. Across Relay absence,
 * consumers retain their last-known state and reconcile it from fresh
 * snapshots at the next readiness signal.
 */
export interface Api {
	v0: ApiV0;
}

declare module "obsidian" {
	interface Workspace {
		on(name: "system3-relay:api-ready", callback: () => void): EventRef;
		trigger(name: "system3-relay:api-ready"): void;
		on(
			name: "system3-relay:v0:users",
			callback: (event: RelayEvent<User>) => void,
		): EventRef;
		trigger(name: "system3-relay:v0:users", event: RelayEvent<User>): void;
		on(
			name: "system3-relay:v0:current-user",
			callback: (event: RelayEvent<User | null>) => void,
		): EventRef;
		trigger(
			name: "system3-relay:v0:current-user",
			event: RelayEvent<User | null>,
		): void;
	}
}
