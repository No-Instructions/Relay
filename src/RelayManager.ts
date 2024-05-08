"use strict";

import { randomUUID } from "crypto";
import { SharedFolders, type SharedFolder } from "./SharedFolder";
import {
	makeRelay,
	type RelayRole,
	type Relay,
	type RelayInvitation,
	type Role,
} from "./Relay";
import PocketBase from "pocketbase";
import { ObservableMap } from "./observable/ObservableMap";
import { curryLog } from "./debug";

interface RelayDAO {
	id: string;
	guid: string;
	name: string;
	path: string;
	user_limit: number;
}

interface RelayDAOExpandingRelayInvitation extends RelayDAO {
	expand: {
		relay_invitations_via_relay: RelayInvitationDAO;
	};
}

interface RoleDAO {
	id: string;
	name: string;
}

interface RelayRoleDAO {
	id: string;
	user: string;
	role: string;
	relay: string;
}

interface RelayRoleDAOExpandingRelayRole extends RelayRoleDAO {
	expand: {
		role: RoleDAO;
		relay: RelayDAO;
	};
}

interface RelayRoleDAOExpandingRelayUser extends RelayRoleDAO {
	expand: {
		user: UserDAO;
		relay: RelayDAO;
	};
}

interface UserDAOExpandingRelayRoles {
	id: string;
	name: string;
	expand: {
		relay_roles_via_user: RelayRoleDAOExpandingRelayRole[];
	};
}

interface RelayInvitationDAO {
	id: string;
	role: string;
	relay: string;
	key: string;
}

function toRelays(
	user: UserDAOExpandingRelayRoles,
	sharedFolders: SharedFolders
): Relay[] {
	const relays: Relay[] = [];
	try {
		user.expand.relay_roles_via_user.forEach((role) => {
			const folder = sharedFolders.find(
				(folder) => folder.guid === role.expand.relay.guid
			);
			relays.push(
				makeRelay(
					role.expand.relay.id,
					role.expand.relay.guid,
					role.expand.relay.name,
					folder?.path || role.expand.relay.path,
					role.expand.relay.user_limit,
					folder,
					undefined,
					role.expand.role.name as Role
				)
			);
		});
	} catch (e) {
		// User has no roles...
	}
	return relays;
}

function toRelayRoles(
	user: UserDAOExpandingRelayRoles,
	relays: Relay[]
): ObservableMap<string, RelayRole> {
	const roles: ObservableMap<string, RelayRole> = new ObservableMap<
		string,
		RelayRole
	>();
	user.expand.relay_roles_via_user.forEach((role) => {
		const relay = relays.find((relay) => relay.id === role.expand.relay.id);
		const id = role.id;
		if (!relay) {
			console.error("relay not found", role.expand.relay.id);
			return;
		}
		roles.set(id, {
			id,
			user: { id: user.id, name: user.name },
			role: role.expand.role.name as Role,
			relay: relay,
		});
	});
	return roles;
}

function toRelay(
	relay: RelayDAO,
	relayRoles: ObservableMap<string, RelayRole>,
	relayInvitations: ObservableMap<string, RelayInvitation>
): Relay {
	const role: Role = relayRoles.get(relay.id)?.role || ("Member" as Role);
	const relayInvitation = relayInvitations.find(
		(invite) => invite.relay.id === relay.id
	);
	return makeRelay(
		relay.id,
		relay.guid,
		relay.name,
		relay.path,
		relay.user_limit,
		undefined,
		relayInvitation,
		role
	);
}

interface UserDAO {
	id: string;
	name: string;
}

interface RoleDAO {
	id: string;
	name: string;
}

class RelayRoleAuto implements RelayRole {
	// Relay permissions are based on relay roles,
	// and subscriptions are based on the listing permission -- this means that
	// we don't receive the update for created relays, and the relay role will point to a missing entity.
	// This class makes a lazy accessor.
	users: ObservableMap<string, UserDAO>;
	roles: RoleDAO[];
	relays: ObservableMap<string, Relay>;
	relayRole: RelayRoleDAO;

	constructor(
		relayRole: RelayRoleDAO,
		relays: ObservableMap<string, Relay>,
		users: ObservableMap<string, UserDAO>,
		roles: RoleDAO[]
	) {
		this.users = users;
		this.roles = roles;
		this.relays = relays;
		this.relayRole = relayRole;
	}

	public get id() {
		return this.relayRole.id;
	}

	public get user(): UserDAO {
		const user = this.users.get(this.relayRole.user);
		if (!user) {
			throw new Error("invalid user");
		}
		return user;
	}

	public get role(): Role {
		return this.roles.find((role) => role.id === this.relayRole.role)
			?.name as Role;
	}

	public get relay(): Relay | undefined {
		const relay = this.relays.get(this.relayRole.relay);
		return relay;
	}
}

class RelayInvitationAuto implements RelayInvitation {
	relayInvitation: RelayInvitationDAO;
	roles: RoleDAO[];
	relays: ObservableMap<string, Relay>;

	constructor(
		relayInvitation: RelayInvitationDAO,
		relays: ObservableMap<string, Relay>,
		roles: RoleDAO[]
	) {
		this.relayInvitation = relayInvitation;
		this.roles = roles;
		this.relays = relays;
	}

	public get key() {
		return this.relayInvitation.key;
	}

	public get id() {
		return this.relayInvitation.id;
	}

	public get role(): Role {
		return this.roles.find((role) => role.id === this.relayInvitation.role)
			?.name as Role;
	}

	public get relayId(): string {
		return this.relayInvitation.relay;
	}

	public get relay(): Relay {
		const relay = this.relays.get(this.relayInvitation.relay);
		if (!relay) {
			throw new Error("invalid invitation");
		}
		return relay;
	}
}

export class RelayManager {
	relays: ObservableMap<string, Relay>;
	relayset: ObservableMap<string, Relay>;
	relayRoles: ObservableMap<string, RelayRole>;
	relayInvitations: ObservableMap<string, RelayInvitation>;
	users: ObservableMap<string, UserDAO>;
	sharedFolders: SharedFolders;
	roles: RoleDAO[];
	user: UserDAO;
	_offSharedFolders: () => void = () => {};
	_log: (message: string, ...args: unknown[]) => void;
	private pb: PocketBase;

	constructor(sharedFolders: SharedFolders) {
		this._log = curryLog("[RelayManager]");
		this.relays = new ObservableMap<string, Relay>();
		this.relayInvitations = new ObservableMap<string, RelayInvitation>();
		this.relayset = new ObservableMap<string, Relay>();
		this.roles = [
			{ name: "Owner", id: "2arnubkcv7jpce8" },
			{ name: "Member", id: "x6lllh2qsf9lxk6" },
		];
		this.relayRoles = new ObservableMap<string, RelayRole>();
		this.sharedFolders = sharedFolders;
		this.pb = new PocketBase("https://auth.dnup.org");
		this.user = this.pb.authStore.model as UserDAO;
		this.users = new ObservableMap<string, UserDAO>();
		this.users.set(this.user.id, this.user);
		this.subscribe();
		this.update();
	}

	private log(message: string, ...args: unknown[]) {
		this._log(message, ...args);
	}

	async getRelayInvitationKey(relay: Relay): Promise<string> {
		const relayInvitation = this.relayInvitations.find((invite) => {
			return invite.relay.id === relay.id;
		});
		if (relayInvitation?.key) {
			return relayInvitation.key;
		}
		return this.pb
			.collection("relay_invitations")
			.getList<RelayInvitationDAO>()
			.then((invitations) => {
				const invite = invitations["items"].find((invite) => {
					return invite.relay === relay.id;
				});
				if (invite) {
					const newInvitation = new RelayInvitationAuto(
						invite,
						this.relays,
						this.roles
					);
					this.relayInvitations.set(newInvitation.id, newInvitation);
					return invite.key;
				}
				return "";
			});
	}

	async subscribe() {
		this._offSharedFolders = this.sharedFolders.subscribe((folders) => {
			this.relays.forEach((relay) => {
				if (relay.folder) {
					return;
				}
				const folder = folders.find(
					(folder) => folder.guid === relay.guid
				);
				if (folder) {
					relay.folder = folder;
					relay.path = folder.path;
				}
			});
		});
		this.pb
			.collection("relays")
			.subscribe<RelayDAOExpandingRelayInvitation>(
				"*",
				(e) => {
					this.log("[Event]: relays", e.action, e.record);
					if (e.action === "delete") {
						this.relays.delete(e.record.id);
						return;
					}
					const relay = toRelay(
						e.record,
						this.relayRoles,
						this.relayInvitations
					);
					this.relays.set(e.record.id, relay);
					if (e.record.expand.relay_invitations_via_relay) {
						const newInvitation = new RelayInvitationAuto(
							e.record.expand.relay_invitations_via_relay,
							this.relays,
							this.roles
						);
						this.relayInvitations.set(
							newInvitation.id,
							newInvitation
						);
					}
				},
				{
					expand: ["relay_invitations_via_relay"],
				}
			);
		this.pb
			.collection("relay_invitations")
			.subscribe<RelayInvitationDAO>("*", (e) => {
				this.log("[Event]: relay_invitations", e.action, e.record);
				if (e.action === "delete") {
					this.relayInvitations.delete(e.record.id);
					return;
				}
				const newInvitation = new RelayInvitationAuto(
					e.record,
					this.relays,
					this.roles
				);
				this.relayInvitations.set(newInvitation.id, newInvitation);
			});
		this.pb
			.collection("relay_roles")
			.subscribe<RelayRoleDAOExpandingRelayUser>(
				"*",
				(e) => {
					console.log("event: relay_roles", e.action, e.record);
					if (e.action === "delete") {
						this.relayRoles.delete(e.record.id);
						return;
					}
					try {
						const makeRole = () => {
							this.users.set(
								e.record.expand.user.id,
								e.record.expand.user
							);
							const role = new RelayRoleAuto(
								e.record,
								this.relays,
								this.users,
								this.roles
							);
							this.relayRoles.set(e.record.id, role);
							return role;
						};
						const role = makeRole();

						if (role.relay === undefined) {
							this.pb
								.collection("relays")
								.getOne<RelayDAO>(e.record.relay)
								.then((relayRecord) => {
									const relay = toRelay(
										relayRecord,
										this.relayRoles,
										this.relayInvitations
									);
									this.relays.set(relay.id, relay);
									makeRole();
								});
						}
					} catch (e) {
						console.error(e);
					}
				},
				{
					expand: ["user", "relay"],
				}
			);
	}

	async update() {
		if (
			!this.pb.authStore.isValid ||
			this.pb.authStore.model?.id === undefined
		) {
			return;
		}

		await this.pb
			.collection("users")
			.getOne<UserDAOExpandingRelayRoles>(this.pb.authStore.model.id, {
				expand: "relay_roles_via_user,relay_roles_via_user.relay,relay_roles_via_user.role",
			})
			.then((user) => {
				const relays = toRelays(user, this.sharedFolders);
				for (const relay of relays) {
					this.relays.set(relay.id, relay);
				}
				this.relayRoles = toRelayRoles(user, [...this.relays.values()]);
			});

		await this.pb
			.collection("relay_roles")
			.getList<RelayRoleDAOExpandingRelayUser>(0, 200, {
				expand: "user",
			})
			.then((roles) => {
				roles.items.forEach((record) => {
					this.users.set(record.expand.user.id, record.expand.user);
					const role = new RelayRoleAuto(
						record,
						this.relays,
						this.users,
						this.roles
					);
					this.relayRoles.set(role.id, role);
				});
			});
		await this.pb
			.collection("relay_invitations")
			.getList<RelayInvitationDAO>()
			.then((relayInvitations) => {
				relayInvitations.items.forEach((record) => {
					const relayInvitation = new RelayInvitationAuto(
						record,
						this.relays,
						this.roles
					);
					this.relayInvitations.set(
						relayInvitation.id,
						relayInvitation
					);
				});
			});
	}

	async acceptInvitation(shareKey: string) {
		return this.pb
			.send("/api/accept-invitation", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					key: shareKey,
				}),
			})
			.then((response) => {
				this.log("[InviteAccept]", response);
				return response;
			});
	}

	createRelay(name: string): Promise<Relay> {
		return new Promise<Relay>((resolve) => {
			const guid = randomUUID();
			this.pb
				.collection("relays")
				.create({
					guid: guid,
					name: name,
					path: null,
				})
				.then((record) => {
					const relay = makeRelay(
						record.id,
						guid,
						name,
						undefined,
						2
					);
					this.relays.set(relay.id, relay);
					resolve(relay);
				});
		});
	}

	updateRelay(relay: Relay): Promise<Relay> {
		return new Promise<Relay>((resolve) => {
			this.pb
				.collection("relays")
				.update<RelayDAO>(relay.id, {
					name: relay.name,
				})
				.then((record) => {
					const updatedRelay = toRelay(
						record,
						this.relayRoles,
						this.relayInvitations
					);
					updatedRelay.folder = relay.folder;
					updatedRelay.path = relay.path;
					this.relays.set(relay.id, updatedRelay);
					resolve(relay);
				});
		});
	}

	mountRelay(relay: Relay, sharedFolder: SharedFolder) {
		relay.path = sharedFolder.path;
		relay.folder = sharedFolder;
		this.relays.set(relay.id, relay);
		this.relayRoles.notifyListeners(); // XXX
	}

	destroyRelay(relay: Relay): boolean {
		this.pb.collection("relays").delete(relay.id);
		if (relay.folder) {
			this.sharedFolders.delete(relay.folder);
		}
		return this.relays.delete(relay.id);
	}

	unmountRelay(relay: Relay): Relay {
		if (relay.folder) {
			this.sharedFolders.delete(relay.folder);
		}
		relay.folder = undefined;
		this.relays.set(relay.id, relay);
		this.relays.notifyListeners();
		this.relayRoles.notifyListeners();
		return relay;
	}

	destroy(): void {
		this._offSharedFolders();
		this.pb.collection("relays").unsubscribe();
		this.pb.collection("relay_roles").unsubscribe();
		this.pb.collection("relay_invitations").unsubscribe();
	}
}
