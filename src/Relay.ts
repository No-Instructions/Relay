export type Role = "Owner" | "Member";

interface Identified {
	id: string;
}
interface Updatable<T> {
	update(update: unknown): T;
}

export interface RemoteSharedFolder
	extends Identified,
		Updatable<RemoteSharedFolder> {
	id: string;
	guid: string;
	name: string;
	private: boolean;
	relay: Relay;
}

export interface Relay extends Identified, Updatable<Relay> {
	id: string;
	guid: string;
	name: string;
	user_limit: number;
	role: Role;
	owner: boolean;
	invitation?: RelayInvitation;
}

export interface RelayRoleUser extends Identified {
	id: string;
	name: string;
}

export interface RelayRole extends Identified, Updatable<RelayRole> {
	id: string;
	user: RelayRoleUser;
	userId: string;
	role: Role;
	relay: Relay;
}

export interface RelayInvitation extends Updatable<RelayInvitation> {
	id: string;
	role: Role;
	relay: Relay;
	key: string;
}
