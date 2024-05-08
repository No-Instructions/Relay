import { randomUUID } from "crypto";
import type { SharedFolder } from "./SharedFolder";

type RelayType = "personal" | "team";
export type Role = "Owner" | "Member";

// A relay is a shared folder "constructor"
// It is a centralized concept, whereas each user can mount the relay into their own vault as a shared folder.
// The relay has a single owner and a limit on the number of users.
// A relay can have billing information associated with it.
// The billing information can be complex, but the subscription manager will also control user_limit and type.
export interface Relay {
	id: string;
	guid: string;
	name: string;
	path?: string;
	user_limit: number;
	role: Role;
	owner: boolean;
	folder?: SharedFolder;
	invitation?: RelayInvitation;
}

export interface RelayRoleUser {
	id: string;
	name: string;
}

export interface RelayRole {
	id: string;
	user: RelayRoleUser;
	role: Role;
	relay?: Relay;
}

export interface RelayInvitation {
	id: string;
	role: Role;
	relay: Relay;
	key: string;
}

export function newRelay() {
	return {
		guid: randomUUID(),
		type: "personal" as RelayType,
		user_limit: 2,
		name: "New Relay",
		path: "-New Relay",
		role: "Owner" as Role,
		owner: true,
	};
}

export function makeRelay(
	id: string,
	guid: string,
	name: string,
	path: string | undefined,
	user_limit: number,
	folder?: SharedFolder,
	invitation?: RelayInvitation,
	role: Role = "Owner" as Role
): Relay {
	return {
		id: id,
		guid: guid,
		name: name,
		user_limit: user_limit,
		role: role,
		owner: role === "Owner",
		path: path,
		folder: folder,
		invitation: invitation,
	};
}
