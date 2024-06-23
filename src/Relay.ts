import type { SharedFolder } from "./SharedFolder";

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
	folder?: SharedFolder;
	invitation?: RelayInvitation;

	update(update: unknown): Relay;
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

	update(update: unknown): RelayRole;
}

export interface RelayInvitation {
	id: string;
	role: Role;
	relay: Relay;
	key: string;

	update(update: unknown): RelayInvitation;
}
