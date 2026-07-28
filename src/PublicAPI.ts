"use strict";

import type { Api, ApiV0, User } from "../relay-plugin-api";
import type { LoginManager } from "./LoginManager";
import type { RelayUser } from "./Relay";
import type { RelayManager } from "./RelayManager";
import type { TextViewRegistry } from "./TextViewRegistry";
import type { User as SignedInUser } from "./User";
import { View } from "./api/View";
import { ViewMap } from "./api/ViewMap";

export type { Api, ApiV0, User };

type UserRecord = RelayUser | SignedInUser;

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

export interface PublicApiHandle {
	api: Api;
	detach: () => void;
}

/**
 * The registration entry point, built in its own scope. Declared at the top
 * level for the same reason as the copy helpers: a consumer keeps the api
 * for the rest of the session, and a closure created inside createPublicApi
 * would hold that call's entire context — the managers included — alive with
 * it. Detaching releases the registry, after which registering is inert: a
 * consumer calling into an unloaded Relay gets a no-op unsubscriber rather
 * than a throw, and the next api-ready event carries a live container.
 *
 * v0 stamps version 0 on the persisted record: the row outlives the code
 * that wrote it, and the version names the contract the registering plugin
 * called through.
 */
function createRegisterView(registry: TextViewRegistry) {
	let current: TextViewRegistry | null = registry;
	return {
		registerView: (pluginId: string, viewType: string) => {
			const target = current;
			if (!target) return () => undefined;
			return target.register(pluginId, viewType, 0);
		},
		detach: () => {
			current = null;
		},
	};
}

export function createPublicApi(
	relayManager: RelayManager,
	loginManager: LoginManager,
	textViewRegistry: TextViewRegistry,
): PublicApiHandle {
	const users = ViewMap.create(
		relayManager.users,
		toUser,
		"api.v0.identity.users",
	);

	const currentUser = View.create<User | null>(
		loginManager,
		() => toUser(loginManager.user) ?? null,
		"api.v0.identity.currentUser",
	);

	const registration = createRegisterView(textViewRegistry);

	const api: Api = {
		v0: {
			identity: { users: users.view, currentUser: currentUser.view },
			registerView: registration.registerView,
		},
	};

	return {
		api,
		detach: () => {
			users.detach();
			currentUser.detach();
			registration.detach();
		},
	};
}
