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
 * A move made on this client where either path, or both, is shared. Relay
 * publishes the moves it tracks; the server may not have one yet. Paths are
 * vault paths. A folder move
 * reports the folder, then each descendant in that descendant's own vault
 * `rename` callback.
 */
export interface LocalMove {
	oldPath: string;
	newPath: string;
	kind: "file" | "folder";
}

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
	registerTextView(pluginId: string, viewType: string): void;
	/** Idempotently remove a persisted text-file view registration. */
	unregisterTextView(pluginId: string, viewType: string): void;
	/**
	 * Whether a vault path is inside a shared folder. Its presence means
	 * `system3-relay:v0:local-move` is available.
	 */
	isSharedPath(path: string): boolean;
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
		/**
		 * Fires during the vault `rename` event for each move made on this
		 * client that touches a shared path, where the moved file is already
		 * at `newPath`. It does not fire for moves Relay applies from other
		 * clients, for moves Relay rejects and restores, or for renaming a
		 * shared folder itself. Any other rename where `isSharedPath` holds
		 * for either path fires it.
		 */
		on(
			name: "system3-relay:v0:local-move",
			callback: (event: LocalMove) => void,
		): EventRef;
		trigger(name: "system3-relay:v0:local-move", event: LocalMove): void;
	}
}
