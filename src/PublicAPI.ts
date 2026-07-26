"use strict";

import type { Api, ApiV0, User } from "../relay-plugin-api";
import type { LoginManager } from "./LoginManager";
import type { RelayUser } from "./Relay";
import type { RelayManager } from "./RelayManager";
import type { User as SignedInUser } from "./User";
import { View } from "./api/View";
import { ViewMap } from "./api/ViewMap";

// relay-plugin-api.d.ts holds the type declarations a consuming plugin copies
// into its own source or references from this repository. Re-export them here
// so plugin code and consumers compile against one definition and cannot drift
// apart. The dependency runs one way: implementation to declaration.
export type { Api, ApiV0, User };

/**
 * What the projection reads: Relay's two concrete user records, named rather
 * than restated.
 *
 * Restating their shape here would not check anything. A hand-written record of
 * optional fields is satisfied by any object at all, including one that had
 * renamed or dropped every field this file reads — the projection would keep
 * compiling, find nothing it recognises in any record, and the API would go
 * permanently and silently empty. Naming the real types makes that a build
 * failure at the field reads below instead.
 *
 * The two differ in what they carry: only the signed-in record has the assigned
 * presence colours, and the directory records come from the server without
 * them.
 */
type UserRecord = RelayUser | SignedInUser;

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
	// The assigned pair is one field on the signed-in record and absent from a
	// directory record; the public shape splits it in two, the same split the
	// rest of the plugin makes when it publishes presence.
	const color = "color" in record ? record.color : undefined;
	return {
		id,
		name,
		...(record.picture ? { picture: record.picture } : {}),
		...(color?.color ? { color: color.color } : {}),
		...(color?.light ? { colorLight: color.light } : {}),
	};
}

/**
 * What a read hands back for one entry.
 *
 * A view holds one projected value per entry and is read by every consumer, so
 * a read returns a copy of it and each caller holds a user of its own. The
 * public shape is flat — five strings — so a shallow copy is a whole one.
 */
function copyUser(user: User): User {
	return { ...user };
}

/**
 * The same, for the store that publishes one user or nobody.
 *
 * Declared here rather than written inline where the view is built, because a
 * closure written there would capture that scope — the login manager included —
 * and a view holds its copy function for as long as a consumer holds the view,
 * detached or not. A top-level function captures nothing.
 */
function copyCurrentUser(user: User | null): User | null {
	return user ? copyUser(user) : null;
}

/** The API plus the handle Relay keeps for teardown. */
export interface PublicApiHandle {
	/** The object handed to consumers. */
	api: Api;
	/**
	 * Detaches the views from their sources.
	 *
	 * Relay's only control over the stores it hands out, and deliberately not
	 * reachable from them: one consumer detaching the shared directory would
	 * freeze it for every other consumer, permanently and with no error.
	 */
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
	const users = ViewMap.create(
		relayManager.users,
		toUser,
		copyUser,
		"api.v0.identity.users",
	);

	// The signed-in user is the login manager's to know, and the view recomputes
	// when the login manager notifies: on sign in and on sign out.
	//
	// One thing it does not notify on: refreshing the session token rebuilds the
	// record in place. Of the fields read here only the assigned colours can
	// come back different, because the record picks them at random each time it
	// is built, so a consumer can hold a stale colour until the next sign in or
	// sign out. Both halves of that live with the login manager and the record
	// rather than here, and a notification on refresh would announce a colour
	// change nobody made to every existing subscriber, so this view reports what
	// its source publishes and no more.
	//
	// The signed-in record carries the assigned colours a directory record does
	// not. Nobody signed in reads as null: that is the declared public value for
	// the absence of a current user, so the projection producing nothing lands
	// there.
	const currentUser = View.create<User | null>(
		loginManager,
		() => toUser(loginManager.user) ?? null,
		copyCurrentUser,
		"api.v0.identity.currentUser",
	);

	// The annotation is the acceptance test for the whole surface: it makes the
	// compiler check that what the views publish satisfies the declared shape,
	// in the one direction the declaration file's independence allows.
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
