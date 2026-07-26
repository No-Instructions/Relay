"use strict";

import type { Api, ApiV0, User } from "../relay-plugin-api";
import type { LoginManager } from "./LoginManager";
import type { RelayManager } from "./RelayManager";
import { View } from "./api/View";
import { ViewMap } from "./api/ViewMap";

// relay-plugin-api.d.ts holds the type declarations a consuming plugin copies
// into its own source or references from this repository. Re-export them here
// so plugin code and consumers compile against one definition and cannot drift
// apart. The dependency runs one way: implementation to declaration.
export type { Api, ApiV0, User };

/**
 * The fields the projection reads. Relay's own user records — the signed-in
 * user, and the directory records — each carry more than this, and more than
 * the public shape declares; both are matched structurally here rather than
 * imported, so this file names every field it touches on either side.
 *
 * `color` arrives two ways: the signed-in user carries an assigned pair, while
 * a directory record carries none.
 */
interface UserRecord {
	id?: string;
	name?: string;
	picture?: string;
	color?: string | { color?: string; light?: string };
	colorLight?: string;
}

/**
 * The only place the public shape is built. Source records hold more than
 * `User` declares — an email, a session token — so this names every field it
 * copies and never spreads the record: what a consumer receives is exactly the
 * declared shape, whatever else the record happens to hold.
 *
 * Projection and dropping are one operation. A record too incomplete to render
 * produces nothing: without an id and a name there is no person to show.
 */
function toUser(record: UserRecord | undefined): User | undefined {
	if (!record) return undefined;
	const id = record.id?.trim();
	const name = record.name?.trim();
	if (!id || !name) return undefined;
	const color =
		typeof record.color === "string" ? record.color : record.color?.color;
	const colorLight =
		record.colorLight ??
		(typeof record.color === "string" ? undefined : record.color?.light);
	return {
		id,
		name,
		...(record.picture ? { picture: record.picture } : {}),
		...(color ? { color } : {}),
		...(colorLight ? { colorLight } : {}),
	};
}

/** The API plus the handle Relay keeps for teardown. */
export interface PublicApiHandle {
	/** The object handed to consumers. */
	api: Api;
	/** Detaches the views from their sources. */
	detach: () => void;
}

/**
 * Builds the container.
 *
 * `PublicAPI` projects and owns the views; populating and refreshing the
 * directory belongs to `RelayManager`, and the signed-in user belongs to
 * `LoginManager`. When the directory is empty, the API reports it as empty.
 *
 * Viewing rather than handing out Relay's own stores gives the public shape its
 * own identity, holds the projection to the declared fields, and gives Relay a
 * store it owns and detaches on unload while the rest of the plugin continues
 * teardown against the live ones.
 */
export function createPublicApi(
	relayManager: RelayManager,
	loginManager: LoginManager,
): PublicApiHandle {
	const users = new ViewMap(
		relayManager.users,
		toUser,
		"api.v0.identity.users",
	);

	// The signed-in user is the login manager's to know, and it is the source
	// that changes — it notifies on login and on logout — so the view recomputes
	// exactly when the answer can differ. Its record carries the assigned
	// colours a directory record does not. Nobody signed in reads as null: that
	// is the declared public value for the absence of a current user, so the
	// projection producing nothing lands there.
	const currentUser = new View<User | null>(
		loginManager,
		() => toUser(loginManager.user) ?? null,
		"api.v0.identity.currentUser",
	);

	const api: Api = { v0: { identity: { users, currentUser } } };

	return {
		api,
		detach: () => {
			users.detach();
			currentUser.detach();
		},
	};
}
