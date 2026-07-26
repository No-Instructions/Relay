"use strict";

import type { Api, ApiV0, User } from "../relay-plugin-api";
import type { LoginManager } from "./LoginManager";
import type { RelayUser } from "./Relay";
import type { RelayManager } from "./RelayManager";
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

export function createPublicApi(
	relayManager: RelayManager,
	loginManager: LoginManager,
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

	const api: Api = {
		v0: { identity: { users: users.view, currentUser: currentUser.view } },
	};

	return {
		api,
		detach: () => {
			users.detach();
			currentUser.detach();
		},
	};
}
