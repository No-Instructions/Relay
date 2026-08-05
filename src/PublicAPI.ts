"use strict";

import type { Api, ApiV0, RelayEvent, User } from "../relay-plugin-api";
import type { LoginManager } from "./LoginManager";
import type { RelayUser } from "./Relay";
import type { RelayManager } from "./RelayManager";
import type { TextViewRegistry } from "./TextViewRegistry";
import type { User as SignedInUser } from "./User";

export type { Api, ApiV0, RelayEvent, User };

export const API_UNLOADED_ERROR =
	'Relay plugin unloaded; resolve app.plugins.plugins["system3-relay"]?.api after the next system3-relay:api-ready signal';

type UserRecord = RelayUser | SignedInUser;
type WorkspaceEvents = {
	trigger(name: "system3-relay:v0:users", event: RelayEvent<User>): void;
	trigger(
		name: "system3-relay:v0:current-user",
		event: RelayEvent<User | null>,
	): void;
};

function toUser(record: UserRecord | undefined): User | undefined {
	if (!record) return undefined;
	const id = record.id?.trim();
	const name = record.name?.trim();
	if (!id || !name) return undefined;
	const color = "color" in record ? record.color : undefined;
	return {
		id,
		name,
		...(record.picture ? { picture: record.picture } : {}),
		...(color?.color ? { color: color.color } : {}),
	};
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function usersEqual(left: User, right: User): boolean {
	return (
		left.id === right.id &&
		left.name === right.name &&
		left.picture === right.picture &&
		left.color === right.color
	);
}

function currentUsersEqual(left: User | null, right: User | null): boolean {
	if (left === null || right === null) return left === right;
	return usersEqual(left, right);
}

interface ApiState {
	attached: boolean;
	users: User[];
	currentUser: User | null;
	registry: TextViewRegistry | null;
}

function requireAttached(state: ApiState): void {
	if (!state.attached) throw new Error(API_UNLOADED_ERROR);
}

function createApi(state: ApiState): Api {
	const v0: ApiV0 = {
		getUsers: () => {
			requireAttached(state);
			return clone(state.users);
		},
		getCurrentUser: () => {
			requireAttached(state);
			return clone(state.currentUser);
		},
		registerView: (pluginId, viewType) => {
			requireAttached(state);
			state.registry!.register(pluginId, viewType, 0);
		},
		unregisterView: (pluginId, viewType) => {
			requireAttached(state);
			state.registry!.unregister(pluginId, viewType);
		},
	};
	return { v0 };
}

export interface PublicApiHandle {
	api: Api;
	detach: () => void;
}

/** Publish the API before notifying consumers to resolve it from the plugin. */
export function publishPublicApi(
	plugin: { api?: Api },
	workspace: { trigger(name: "system3-relay:api-ready"): void },
	api: Api,
): void {
	plugin.api = api;
	workspace.trigger("system3-relay:api-ready");
}

export function createPublicApi(
	relayManager: RelayManager,
	loginManager: LoginManager,
	textViewRegistry: TextViewRegistry,
	workspace: WorkspaceEvents,
): PublicApiHandle {
	const readUsers = (): User[] =>
		relayManager.users.values().flatMap((record) => {
			const user = toUser(record);
			return user ? [user] : [];
		});
	const readCurrentUser = (): User | null => toUser(loginManager.user) ?? null;
	const state: ApiState = {
		attached: true,
		users: readUsers(),
		currentUser: readCurrentUser(),
		registry: textViewRegistry,
	};

	let usersQueued = false;
	let currentUserQueued = false;
	const flushUsers = () => {
		usersQueued = false;
		if (!state.attached) return;
		const next = readUsers();
		const before = new Map(state.users.map((user) => [user.id, user]));
		const after = new Map(next.map((user) => [user.id, user]));
		state.users = next;
		for (const [id, record] of after) {
			const previous = before.get(id);
			if (!previous || !usersEqual(previous, record)) {
				workspace.trigger("system3-relay:v0:users", {
					action: previous ? "update" : "create",
					record: clone(record),
				});
			}
		}
		for (const [id, record] of before) {
			if (!after.has(id)) {
				workspace.trigger("system3-relay:v0:users", {
					action: "delete",
					record: clone(record),
				});
			}
		}
	};
	const flushCurrentUser = () => {
		currentUserQueued = false;
		if (!state.attached) return;
		const next = readCurrentUser();
		if (currentUsersEqual(next, state.currentUser)) return;
		state.currentUser = next;
		workspace.trigger("system3-relay:v0:current-user", {
			action: "update",
			record: clone(next),
		});
	};
	const queueUsers = () => {
		if (!state.attached || usersQueued) return;
		usersQueued = true;
		queueMicrotask(flushUsers);
	};
	const queueCurrentUser = () => {
		if (!state.attached || currentUserQueued) return;
		currentUserQueued = true;
		queueMicrotask(flushCurrentUser);
	};
	const stopUsers = relayManager.users.on(queueUsers);
	const stopCurrentUser = loginManager.on(queueCurrentUser);

	return {
		api: createApi(state),
		detach: () => {
			if (!state.attached) return;
			state.attached = false;
			stopUsers();
			stopCurrentUser();
			state.registry = null;
		},
	};
}
