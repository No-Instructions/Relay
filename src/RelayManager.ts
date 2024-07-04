"use strict";

import { randomUUID } from "crypto";
import { SharedFolders, type SharedFolder } from "./SharedFolder";
import {
	type RelayRole,
	type Relay,
	type RelayInvitation,
	type Role,
} from "./Relay";
import PocketBase, { type ListResult, type RecordModel } from "pocketbase";
import { ObservableMap } from "./observable/ObservableMap";
import { curryLog } from "./debug";
import { customFetch } from "./customFetch";

declare const AUTH_URL: string;

interface UserDAO extends RecordModel {
	id: string;
	name: string;
}

interface RoleDAO extends RecordModel {
	id: string;
	name: string;
}

interface RelayDAO extends RecordModel {
	id: string;
	guid: string;
	name: string;
	path: string;
	user_limit: number;
	creator: string;
}

interface RelayDAOExpandingRelayInvitation extends RelayDAO {
	expand?: {
		relay_invitations_via_relay: RelayInvitationDAO;
	};
}

interface RelayRoleDAO extends RecordModel {
	id: string;
	user: string;
	role: string;
	relay: string;
}

interface RelayRoleDAOExpandingRelayRole extends RelayRoleDAO {
	expand?: {
		role?: RoleDAO;
		relay?: RelayDAO;
	};
}

interface RelayRoleDAOExpandingRelayUser extends RelayRoleDAO {
	expand?: {
		user?: UserDAO;
		relay?: RelayDAO;
	};
}

interface UserDAOExpandingRelayRoles extends RecordModel {
	id: string;
	name: string;
	expand?: {
		relay_roles_via_user?: RelayRoleDAOExpandingRelayRole[];
	};
}

interface RelayInvitationDAO extends RecordModel {
	id: string;
	role: string;
	relay: string;
	key: string;
}

interface RelayInvitationDAOExpandingRelay extends RelayInvitationDAO {
	expand?: {
		relay: RelayDAO;
	};
}

interface Collection<D, A> {
	collectionName: string;
	ingest(update: D): A;
	delete(id: string): void;
}

class RoleCollection implements Collection<RoleDAO, RoleDAO> {
	collectionName: string = "roles";
	roles: ObservableMap<string, RoleDAO>;

	constructor(roles: ObservableMap<string, RoleDAO>) {
		this.roles = roles;
	}

	ingest(update: UserDAO): UserDAO {
		console.log("[RoleCollection] Ingest", update);
		this.roles.set(update.id, update);
		return update;
	}

	delete(id: string) {
		this.roles.delete(id);
	}
}

class RelayCollection implements Collection<RelayDAO, Relay> {
	collectionName: string = "relays";
	relays: ObservableMap<string, Relay>;
	roles: ObservableMap<string, RoleDAO>;
	relayRoles: ObservableMap<string, RelayRole>;
	relayInvitations: ObservableMap<string, RelayInvitation>;
	sharedFolders: SharedFolders;
	user: UserDAO;

	constructor(
		relays: ObservableMap<string, Relay>,
		roles: ObservableMap<string, RoleDAO>,
		relayRoles: ObservableMap<string, RelayRole>,
		relayInvitations: ObservableMap<string, RelayInvitation>,
		sharedFolders: SharedFolders,
		user: UserDAO
	) {
		this.relays = relays;
		this.roles = roles;
		this.relayRoles = relayRoles;
		this.relayInvitations = relayInvitations;
		this.sharedFolders = sharedFolders;
		this.user = user;
	}

	ingest(update: RelayDAO): Relay {
		console.log("[RelayCollection] Ingest", update);
		const existingRelay = this.relays.get(update.id);
		if (existingRelay) {
			existingRelay.update(update);
			const folder = this.sharedFolders.find((folder) => {
				return folder.guid === update.guid;
			});
			if (folder) {
				existingRelay.folder = folder;
				existingRelay.path = folder.path;
			}
			this.relays.notifyListeners();
			return existingRelay;
		}
		const folder = this.sharedFolders.find((folder) => {
			return folder.guid === update.guid;
		});
		const relay = new RelayAuto(
			update,
			this.roles,
			this.relayRoles,
			this.relayInvitations,
			this.user,
			folder?.path,
			folder
		);
		this.relays.set(relay.id, relay);
		return relay;
	}

	delete(id: string) {
		this.relays.delete(id);
	}
}

class RelayRolesCollection implements Collection<RelayRoleDAO, RelayRole> {
	collectionName: string = "relay_roles";
	relayRoles: ObservableMap<string, RelayRole>;
	relays: ObservableMap<string, Relay>;
	users: ObservableMap<string, UserDAO>;
	roles: ObservableMap<string, RoleDAO>;

	constructor(
		relayRoles: ObservableMap<string, RelayRole>,
		relays: ObservableMap<string, Relay>,
		users: ObservableMap<string, UserDAO>,
		roles: ObservableMap<string, RoleDAO>
	) {
		this.relayRoles = relayRoles;
		this.relays = relays;
		this.users = users;
		this.roles = roles;
	}

	ingest(update: RelayRoleDAO): RelayRole {
		console.log("[RelayRoleCollection] Ingest", update);
		const existingRole = this.relayRoles.get(update.id);
		if (existingRole) {
			existingRole.update(update);
			this.relayRoles.notifyListeners();
			return existingRole;
		}
		const role = new RelayRoleAuto(
			update,
			this.relays,
			this.users,
			this.roles
		);
		this.relayRoles.set(role.id, role);
		return role;
	}

	delete(id: string) {
		const relayRole = this.relayRoles.get(id);
		if (!relayRole) {
			return;
		}
		const relay = relayRole.relay;
		if (relay) {
			// XXX this isn't a full implementation of cascade...
			// Relay invitations will still exist.
			this.relays.delete(relay.id);
		}
		this.relayRoles.delete(id);
	}
}

class RelayInvitationsCollection
	implements Collection<RelayInvitationDAO, RelayInvitation>
{
	collectionName: string = "relay_invitations";
	relayInvitations: ObservableMap<string, RelayInvitation>;
	relays: ObservableMap<string, Relay>;
	roles: ObservableMap<string, RoleDAO>;

	constructor(
		relayInvitations: ObservableMap<string, RelayInvitation>,
		relays: ObservableMap<string, Relay>,
		roles: ObservableMap<string, RoleDAO>
	) {
		this.relayInvitations = relayInvitations;
		this.relays = relays;
		this.roles = roles;
	}

	ingest(update: RelayInvitationDAO): RelayInvitation {
		console.log("[RelayInvitationCollection] Ingest", update);
		const existingInvitation = this.relayInvitations.get(update.id);
		if (existingInvitation) {
			existingInvitation.update(update);
			this.relayInvitations.notifyListeners();
			return existingInvitation;
		}
		const invitation = new RelayInvitationAuto(
			update,
			this.relays,
			this.roles
		);
		this.relayInvitations.set(invitation.id, invitation);
		return invitation;
	}

	delete(id: string) {
		this.relayInvitations.delete(id);
	}
}

class UserCollection implements Collection<UserDAO, UserDAO> {
	collectionName: string = "users";
	users: ObservableMap<string, UserDAO>;

	constructor(users: ObservableMap<string, UserDAO>) {
		this.users = users;
	}

	ingest(update: UserDAO): UserDAO {
		console.log("[UserCollection] Ingest", update);
		this.users.set(update.id, update);
		return update;
	}

	delete(id: string) {
		this.users.delete(id);
	}
}

class Store {
	collections: Map<string, Collection<unknown, unknown>>;

	constructor(collections: Collection<unknown, unknown>[]) {
		this.collections = new Map();
		for (const collection of collections) {
			this.collections.set(collection.collectionName, collection);
		}
	}

	ingestPage<T>(
		result?: ListResult<RecordModel>
	): (T | undefined)[] | undefined {
		return this.ingestBatch(result?.items);
	}

	ingestBatch<T>(records?: RecordModel[]): (T | undefined)[] | undefined {
		if (!records) {
			return;
		}
		return records.map((record) => {
			return this.ingest(record);
		});
	}

	ingest<T>(record?: RecordModel): T | undefined {
		if (!record) {
			console.warn("No record to ingest");
			return;
		}
		let result;
		const collection = this.collections.get(record.collectionName);
		if (collection) {
			result = collection.ingest(record) as T;
		} else {
			console.warn("No collection found for record", record);
		}
		if (record.expand) {
			for (const [, value] of Object.entries(record.expand)) {
				if (Array.isArray(value)) {
					this.ingestBatch(value);
				} else {
					this.ingest(value);
				}
			}
		}
		return result;
	}

	delete(record: RecordModel) {
		const collection = this.collections.get(record.collectionName);
		if (collection) {
			collection.delete(record.id);
		}
	}
}

class RelayRoleAuto implements RelayRole {
	// Relay permissions are based on relay roles,
	// and subscriptions are based on the listing permission -- this means that
	// we don't receive the update for created relays, and the relay role will point to a missing entity.
	// This class makes a lazy accessor.
	users: ObservableMap<string, UserDAO>;
	roles: ObservableMap<string, RoleDAO>;
	relays: ObservableMap<string, Relay>;
	relayRole: RelayRoleDAO;

	constructor(
		relayRole: RelayRoleDAO,
		relays: ObservableMap<string, Relay>,
		users: ObservableMap<string, UserDAO>,
		roles: ObservableMap<string, RoleDAO>
	) {
		this.users = users;
		this.roles = roles;
		this.relays = relays;
		this.relayRole = relayRole;
	}

	update(relayRole: RelayRoleDAO) {
		this.relayRole = relayRole;
		return this;
	}

	public get id() {
		return this.relayRole.id;
	}

	public get userId() {
		return this.relayRole.user;
	}

	public get user(): UserDAO {
		const user = this.users.get(this.relayRole.user);
		if (!user) {
			throw new Error(`Unable to find user: ${this.relayRole.user}`);
		}
		return user;
	}

	public get role(): Role {
		return this.roles.get(this.relayRole.role)?.name as Role;
	}

	public get relay(): Relay | undefined {
		const relay = this.relays.get(this.relayRole.relay);
		return relay;
	}
}

class RelayInvitationAuto implements RelayInvitation {
	relayInvitation: RelayInvitationDAO;
	roles: ObservableMap<string, RoleDAO>;
	relays: ObservableMap<string, Relay>;

	constructor(
		relayInvitation: RelayInvitationDAO,
		relays: ObservableMap<string, Relay>,
		roles: ObservableMap<string, RoleDAO>
	) {
		this.relayInvitation = relayInvitation;
		this.roles = roles;
		this.relays = relays;
	}

	update(relayInvitation: RelayInvitationDAO) {
		this.relayInvitation = relayInvitation;
		return this;
	}

	public get key() {
		return this.relayInvitation.key;
	}

	public get id() {
		return this.relayInvitation.id;
	}

	public get role(): Role {
		return this.roles.get(this.relayInvitation.role)?.name as Role;
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

class RelayAuto implements Relay {
	relayRoles: ObservableMap<string, RelayRole>;
	relayInvitations: ObservableMap<string, RelayInvitation>;
	roles: ObservableMap<string, RoleDAO>;
	relay: RelayDAO;
	user: UserDAO;
	path?: string;
	folder?: SharedFolder;

	constructor(
		relay: RelayDAO,
		roles: ObservableMap<string, RoleDAO>,
		relayRoles: ObservableMap<string, RelayRole>,
		relayInvitations: ObservableMap<string, RelayInvitation>,
		user: UserDAO,
		path?: string,
		folder?: SharedFolder
	) {
		this.relayRoles = relayRoles;
		this.roles = roles;
		this.relayInvitations = relayInvitations;
		this.relay = relay;
		this.user = user;
		this.folder = folder;
		this.path = path;
	}

	update(update: RelayDAO) {
		this.relay = update;
		return this;
	}

	public get id() {
		return this.relay.id;
	}

	public get guid() {
		return this.relay.guid;
	}

	public get name() {
		return this.relay.name;
	}

	public set name(value: string) {
		this.relay.name = value;
	}

	public get user_limit() {
		return this.relay.user_limit;
	}

	public get role(): Role {
		const isCreator = this.relay.creator === this.user.id;
		const role = this.relayRoles.find(
			(role) =>
				role.relay?.id === this.relay.id &&
				role.user.id === this.user.id
		)?.role;
		if (role) {
			return role;
		}
		console.warn("couldn't find role", this.relay.id, this.user, isCreator);
		return isCreator ? "Owner" : "Member";
	}

	public get owner() {
		return this.role === "Owner";
	}

	public get invitation() {
		return this.relayInvitations.find(
			(invite) => invite.relay.id === this.relay.id
		);
	}
}

export class RelayManager {
	relays: ObservableMap<string, Relay>;
	relayRoles: ObservableMap<string, RelayRole>;
	relayInvitations: ObservableMap<string, RelayInvitation>;
	users: ObservableMap<string, UserDAO>;
	roles: ObservableMap<string, RoleDAO>;
	user?: UserDAO;
	store?: Store;
	_offSharedFolders: () => void = () => {};
	_log: (message: string, ...args: unknown[]) => void;
	private pb: PocketBase;

	constructor(sharedFolders: SharedFolders) {
		this.sharedFolders = sharedFolders;
		this._log = curryLog("[RelayManager]");

		this.pb = new PocketBase(AUTH_URL);
		this.pb.beforeSend = (url, options) => {
			this._log(url, options);
			return { url, options };
		};

		// Build the NodeLists
		this.users = new ObservableMap<string, UserDAO>();
		this.relays = new ObservableMap<string, Relay>();
		this.relayInvitations = new ObservableMap<string, RelayInvitation>();
		this.relayRoles = new ObservableMap<string, RelayRole>();
		this.roles = [
			{ name: "Owner", id: "2arnubkcv7jpce8" },
			{ name: "Member", id: "x6lllh2qsf9lxk6" },
		];

		// XXX this is so akward that the class behaves poorly if a user is unset.
		this.setUser();

		if (!this.user) {
			return;
		}

		this.buildGraph();
		this.subscribe();
		this.update();
	}

	buildGraph() {
		if (!this.user) {
			return;
		}
		if (this.store) {
			return;
		}
		// Build the AdapterGraph
		const roleCollection = new RoleCollection(this.roles);
		const userCollection = new UserCollection(this.users);
		const relayCollection = new RelayCollection(
			this.relays,
			this.roles,
			this.relayRoles,
			this.relayInvitations,
			this.sharedFolders,
			this.user
		);
		const relayRolesCollection = new RelayRolesCollection(
			this.relayRoles,
			this.relays,
			this.users,
			this.roles
		);
		const relayInvitationsCollection = new RelayInvitationsCollection(
			this.relayInvitations,
			this.relays,
			this.roles
		);
		this.store = new Store([
			roleCollection,
			userCollection,
			relayCollection,
			relayRolesCollection,
			relayInvitationsCollection,
		]);
	}

	private log(message: string, ...args: unknown[]) {
		this._log(message, ...args);
	}

	setUser() {
		this.user = this.pb.authStore.model as UserDAO;
		console.warn("User", this.user);
		if (this.user) {
			this.users.set(this.user.id, this.user);
		}
	}

	login() {
		this.setUser();
		this.buildGraph();
		this.subscribe();
		this.update();
	}

	logout() {
		this.relays.clear();
		this.relayRoles.clear();
		this.relayInvitations.clear();
		this.users.clear();
		this.user = undefined;
		this.store = undefined;
		this.unsubscribe();
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
			.getList<RelayInvitationDAO>(0, 200, {
				fetch: customFetch,
			})
			.then((invitations) => {
				invitations.items.forEach((invite) => {
					this.store?.ingest(invite);
				});
				const invite = this.relayInvitations.find((invite) => {
					return invite.relay.id === relay.id;
				});
				if (invite) {
					return invite.key;
				}
				return "";
			});
	}

	async subscribe() {
		if (
			!this.pb.authStore.isValid ||
			this.pb.authStore.model?.id === undefined
		) {
			console.warn("auth store invalid");
			return;
		}

		if (!this._offSharedFolders) {
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
		}
		this.pb
			.collection("relays")
			.subscribe<RelayDAOExpandingRelayInvitation>(
				"*",
				(e) => {
					this.log("[Event]: relays", e.action, e.record);
					if (e.action === "delete") {
						this.store?.delete(e.record);
						return;
					}
					this.store?.ingest(e.record);
				},
				{
					expand: ["relay_invitations_via_relay"],
					fetch: customFetch,
				}
			);
		this.pb
			.collection("relay_invitations")
			.subscribe<RelayInvitationDAOExpandingRelay>(
				"*",
				(e) => {
					this.log("[Event]: relay_invitations", e.action, e.record);
					if (e.action === "delete") {
						this.store?.delete(e.record);
						return;
					}
					this.store?.ingest(e.record);
				},
				{
					expand: ["relay"],
					fetch: customFetch,
				}
			);
		this.pb
			.collection("relay_roles")
			.subscribe<RelayRoleDAOExpandingRelayUser>(
				"*",
				(e) => {
					this.log("event: relay_roles", e.action, e.record);
					if (e.action === "delete") {
						this.store?.delete(e.record);
						return;
					}
					this.store?.ingest(e.record);
				},
				{
					expand: ["user", "relay"],
					fetch: customFetch,
				}
			);
	}

	async update() {
		if (
			!this.pb.authStore.isValid ||
			this.pb.authStore.model?.id === undefined
		) {
			console.warn("auth store invalid");
			return;
		}

		this.pb
			.collection("users")
			.getOne<UserDAOExpandingRelayRoles>(this.pb.authStore.model.id, {
				expand: "relay_roles_via_user,relay_roles_via_user.relay,relay_roles_via_user.role",
				fetch: customFetch,
			})
			.then((user) => {
				this.store?.ingest(user);
			});

		this.pb
			.collection("relay_roles")
			.getFullList<RelayRoleDAOExpandingRelayUser>({
				expand: "user",
				fetch: customFetch,
			})
			.then((roles) => {
				roles.forEach((record) => {
					this.store?.ingest(record);
				});
			});
		this.pb
			.collection("relay_invitations")
			.getFullList<RelayInvitationDAO>({
				fetch: customFetch,
			})
			.then((relayInvitations) => {
				relayInvitations.forEach((record) => {
					this.store?.ingest(record);
				});
			});
	}

	async acceptInvitation(shareKey: string): Promise<Relay> {
		return new Promise((resolve) => {
			this.pb
				.send("/api/accept-invitation", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						key: shareKey,
					}),
					fetch: customFetch,
				})
				.then((response: RelayDAO) => {
					this.log("[InviteAccept]", response);
					// Maybe we should return roles as well
					this.pb
						.collection("relay_roles")
						.getFullList<RelayRoleDAOExpandingRelayUser>({
							expand: "user",
							fetch: customFetch,
						})
						.then((roles) => {
							this.store?.ingestBatch(roles);
							const relay = this.store?.ingest<Relay>(response);
							if (!relay) {
								throw new Error("Failed to accept invitation");
							}
							resolve(relay);
						});
				});
		});
	}

	createRelay(name: string): Promise<Relay> {
		return new Promise<Relay>((resolve) => {
			const guid = randomUUID();
			this.pb
				.collection("relays")
				.create<RelayDAO>(
					{
						guid: guid,
						name: name,
						path: null,
					},

					{ fetch: customFetch }
				)
				.then((record) => {
					if (!this.user) {
						return;
					}
					const relay = new RelayAuto(
						record,
						this.roles,
						this.relayRoles,
						this.relayInvitations,
						this.user
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
				.update<RelayDAO>(
					relay.id,
					{
						name: relay.name.trim(),
					},
					{ fetch: customFetch }
				)
				.then((record) => {
					this.store?.ingest(record);
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
		this.pb.collection("relays").delete(relay.id, { fetch: customFetch });
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

	async leaveRelay(relay: Relay): Promise<void> {
		this.unmountRelay(relay);
		const role = this.relayRoles.find((role) => {
			return (
				role.user.id === this.user?.id && role.relay?.id === relay.id
			);
		});
		if (role) {
			await this.pb
				.collection("relay_roles")
				.delete(role.id, { fetch: customFetch })
				.then((deleted: boolean) => {
					if (deleted) {
						this.relayRoles.delete(role.id);
					}
				});
		}
	}

	async kick(relay_role: RelayRole) {
		return this.pb.collection("relay_roles").delete(relay_role.id);
	}

	unsubscribe() {
		if (this.pb) {
			this.pb.collection("relays").unsubscribe();
			this.pb.collection("relay_roles").unsubscribe();
			this.pb.collection("relay_invitations").unsubscribe();
		}
	}

	destroy(): void {
		if (this._offSharedFolders) {
			this._offSharedFolders();
		}
		this.unsubscribe();
		this.pb.cancelAllRequests();
	}
}
