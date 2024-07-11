"use strict";

import { v4 as uuid } from "uuid";
import {
	type RelayRole,
	type Relay,
	type RelayInvitation,
	type Role,
	type RemoteSharedFolder as RemoteFolder,
} from "./Relay";
import PocketBase, { type ListResult, type RecordModel } from "pocketbase";
import { ObservableMap } from "./observable/ObservableMap";
import { curryLog } from "./debug";
import { customFetch } from "./customFetch";
import type { SharedFolder } from "./SharedFolder";

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

interface RemoteFolderDAO extends RecordModel {
	id: string;
	guid: string;
	name: string;
	creator: string;
	relay: string;
	private: boolean;
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
	clear(): void;
	get(id: string): A | undefined;
	ingest(update: D): A;
	delete(id: string): void;
}

class RoleCollection implements Collection<RoleDAO, RoleDAO> {
	collectionName: string = "roles";
	roles: ObservableMap<string, RoleDAO>;

	constructor(roles: ObservableMap<string, RoleDAO>) {
		this.roles = roles;
	}

	clear() {
		this.roles.clear();
	}

	get(id: string) {
		return this.roles.get(id);
	}

	ingest(update: UserDAO): UserDAO {
		this.roles.set(update.id, update);
		return update;
	}

	delete(id: string) {
		this.roles.delete(id);
	}
}

class Auto {
	public get aggregate_root(): string | undefined {
		return;
	}

	public get acl(): string | undefined {
		return;
	}
}

class RemoteFolderAuto extends Auto implements RemoteFolder {
	constructor(
		private remoteFolder: RemoteFolderDAO,
		private relays: ObservableMap<string, Relay>
	) {
		super();
	}

	update(update: RemoteFolderDAO): RemoteFolder {
		this.remoteFolder = update;
		return this;
	}

	public get id() {
		return this.remoteFolder.id;
	}

	public get guid() {
		return this.remoteFolder.guid;
	}

	public get name() {
		return this.remoteFolder.name;
	}

	public get private() {
		return this.remoteFolder.private;
	}

	public get relay(): Relay {
		const relay = this.relays.get(this.remoteFolder.relay);
		if (!relay) {
			throw new Error("invalid remote folder");
		}
		return relay;
	}

	public get aggregate_root() {
		return this.remoteFolder.relay;
	}
}

class RemoteFolderCollection
	implements Collection<RemoteFolderDAO, RemoteFolder>
{
	collectionName: string = "shared_folders";

	constructor(
		public remoteFolders: ObservableMap<string, RemoteFolder>,
		private relays: ObservableMap<string, Relay>
	) {}

	clear() {
		this.remoteFolders.clear();
	}

	get(id: string) {
		return this.remoteFolders.get(id);
	}

	ingest(update: RemoteFolderDAO): RemoteFolder {
		const existingFolder = this.remoteFolders.get(update.id);
		if (existingFolder) {
			existingFolder.update(update);
			this.remoteFolders.notifyListeners();
			return existingFolder;
		}
		const folder = new RemoteFolderAuto(update, this.relays);
		this.remoteFolders.set(update.id, folder);
		return folder;
	}

	delete(id: string) {
		this.remoteFolders.delete(id);
	}
}

class RelayCollection implements Collection<RelayDAO, Relay> {
	collectionName: string = "relays";
	relays: ObservableMap<string, Relay>;
	roles: ObservableMap<string, RoleDAO>;
	relayRoles: ObservableMap<string, RelayRole>;
	relayInvitations: ObservableMap<string, RelayInvitation>;
	remoteFolders: ObservableMap<string, RemoteFolder>;
	user: UserDAO;

	constructor(
		relays: ObservableMap<string, Relay>,
		roles: ObservableMap<string, RoleDAO>,
		relayRoles: ObservableMap<string, RelayRole>,
		relayInvitations: ObservableMap<string, RelayInvitation>,
		remoteFolders: ObservableMap<string, RemoteFolder>,
		user: UserDAO
	) {
		this.relays = relays;
		this.roles = roles;
		this.relayRoles = relayRoles;
		this.relayInvitations = relayInvitations;
		this.remoteFolders = remoteFolders;
		this.user = user;
	}

	clear() {
		this.relays.clear();
	}

	get(id: string) {
		return this.relays.get(id);
	}

	ingest(update: RelayDAO): Relay {
		const existingRelay = this.relays.get(update.id);
		if (existingRelay) {
			existingRelay.update(update);
			this.relays.notifyListeners();
			return existingRelay;
		}
		const relay = new RelayAuto(
			update,
			this.roles,
			this.relayRoles,
			this.relayInvitations,
			this.remoteFolders,
			this.user
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

	clear() {
		this.relayRoles.clear();
	}

	get(id: string) {
		return this.relayRoles.get(id);
	}

	ingest(update: RelayRoleDAO): RelayRole {
		const existingRole = this.relayRoles.get<RelayRoleAuto>(update.id);
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
		const relayRole = this.relayRoles.get<RelayRoleAuto>(id);
		if (!relayRole) {
			return;
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

	clear() {
		this.relayInvitations.clear();
	}

	get(id: string) {
		return this.relayInvitations.get(id);
	}

	ingest(update: RelayInvitationDAO): RelayInvitation {
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

	clear(): void {
		this.users.clear();
	}

	get(id: string) {
		return this.users.get(id);
	}

	ingest(update: UserDAO): UserDAO {
		this.users.set(update.id, update);
		return update;
	}

	delete(id: string) {
		this.users.delete(id);
	}
}

class Store {
	collections: Map<string, Collection<unknown, unknown>>;
	relationships: Map<string, string[]>;

	constructor(collections: Collection<unknown, unknown>[]) {
		this.collections = new Map();
		this.relationships = new Map();
		for (const collection of collections) {
			this.collections.set(collection.collectionName, collection);
		}
	}

	bruteGetCollection(id: string) {
		// FIXME
		// struggling with tagging types late at night, this is dumb...
		return [...this.collections.values()].find((collection) => {
			return collection.get(id);
		});
	}

	clear() {
		this.collections.forEach((collection) => {
			collection.clear();
		});
		this.collections.clear();
		this.relationships.clear();
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
			return;
		}
		let result;
		const collection = this.collections.get(record.collectionName);
		if (collection) {
			result = collection.ingest(record) as T;
		} else {
			console.warn("No collection found for record", record);
		}
		if (result instanceof Auto) {
			const aggregate_root = result.aggregate_root;
			if (aggregate_root) {
				const pointer = record.id;
				const refs = this.relationships.get(aggregate_root) || [];
				refs.push(pointer);
				this.relationships.set(aggregate_root, refs);
			}
			const acl = result.acl;
			if (acl) {
				const pointer = record.id;
				const refs = this.relationships.get(acl) || [];
				refs.push(pointer);
				this.relationships.set(acl, refs);
			}
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
		this.cascade(record.collectionName, record.id);
	}

	cascade(collectionName: string, id: string) {
		const collection = this.collections.get(collectionName);
		const children = this.relationships.get(id);
		for (const child of children || []) {
			const collection = this.bruteGetCollection(child);
			if (collection) {
				console.log("cascading", collection.collectionName, child);
				collection.delete(child);
				this.relationships.delete(child);
			}
		}
		if (collection) {
			console.log("delete", collection.collectionName, id);
			collection.delete(id);
		}
	}
}

class RelayRoleAuto extends Auto implements RelayRole {
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
		super();
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

	public get relay(): Relay {
		const relay = this.relays.get(this.relayRole.relay);
		if (!relay) {
			throw new Error("invalid role");
		}
		return relay;
	}

	public get aggregate_root() {
		return this.relayRole.relay;
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

	public get aggregate_root() {
		return this.relayInvitation.relay;
	}
}

// XXX this should probably not be exported
export class RelayAuto implements Relay {
	relayRoles: ObservableMap<string, RelayRole>;
	relayInvitations: ObservableMap<string, RelayInvitation>;
	roles: ObservableMap<string, RoleDAO>;
	relay: RelayDAO;
	remoteFolders: ObservableMap<string, RemoteFolder>;
	user: UserDAO;

	constructor(
		relay: RelayDAO,
		roles: ObservableMap<string, RoleDAO>,
		relayRoles: ObservableMap<string, RelayRole>,
		relayInvitations: ObservableMap<string, RelayInvitation>,
		remoteFolders: ObservableMap<string, RemoteFolder>,
		user: UserDAO
	) {
		this.relayRoles = relayRoles;
		this.roles = roles;
		this.relayInvitations = relayInvitations;
		this.relay = relay;
		this.remoteFolders = remoteFolders;
		this.user = user;
	}

	update(update: RelayDAO): RelayAuto {
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

	public get folders(): ObservableMap<string, RemoteFolder> {
		return this.remoteFolders.filter(
			(folder) => folder.relay.id === this.id
		);
	}

	public get acl() {
		return this.relayRoles.find((role) => {
			return role.relay.id === this.id && role.user.id === this.user.id;
		})?.id;
	}
}

export class RelayManager {
	relays: ObservableMap<string, Relay>;
	relayRoles: ObservableMap<string, RelayRole>;
	relayInvitations: ObservableMap<string, RelayInvitation>;
	users: ObservableMap<string, UserDAO>;
	roles: ObservableMap<string, RoleDAO>;
	remoteFolders: ObservableMap<string, RemoteFolder>;
	user?: UserDAO;
	store?: Store;
	_log: (message: string, ...args: unknown[]) => void;
	private pb: PocketBase;

	constructor() {
		this._log = curryLog("[RelayManager]");

		this.pb = new PocketBase(AUTH_URL);
		this.pb.beforeSend = (url, options) => {
			this._log(url, options);
			return { url, options };
		};

		// Build the NodeLists
		this.users = new ObservableMap<string, UserDAO>();
		this.relays = new ObservableMap<string, Relay>();
		this.remoteFolders = new ObservableMap<string, RemoteFolder>();
		this.relayInvitations = new ObservableMap<string, RelayInvitation>();
		this.relayRoles = new ObservableMap<string, RelayRole>();
		this.roles = new ObservableMap<string, RoleDAO>();
		this.roles.set("2arnubkcv7jpce8", {
			name: "Owner",
			id: "2arnubkcv7jpce8",
		} as RoleDAO);
		this.roles.set("x6lllh2qsf9lxk6", {
			name: "Member",
			id: "x6lllh2qsf9lxk6",
		} as RoleDAO);

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
			this.remoteFolders,
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
		const sharedFolderCollection = new RemoteFolderCollection(
			this.remoteFolders,
			this.relays
		);
		this.store = new Store([
			roleCollection,
			userCollection,
			relayCollection,
			relayRolesCollection,
			relayInvitationsCollection,
			sharedFolderCollection,
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
		this.store?.clear();
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
					expand: [
						"relay_invitations_via_relay",
						"shared_folders_via_relay",
					],
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
		this.pb.collection("shared_folders").subscribe<RemoteFolderDAO>(
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
				expand: ["relay"],
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

		await this.pb
			.collection("users")
			.getOne<UserDAOExpandingRelayRoles>(this.pb.authStore.model.id, {
				expand: "relay_roles_via_user,relay_roles_via_user.relay,relay_roles_via_user.role",
				fetch: customFetch,
			})
			.then((user) => {
				this.store?.ingest(user);
			});

		await this.pb
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
		await this.pb
			.collection("relay_invitations")
			.getFullList<RelayInvitationDAO>({
				fetch: customFetch,
			})
			.then((relayInvitations) => {
				relayInvitations.forEach((record) => {
					this.store?.ingest(record);
				});
			});
		await this.pb
			.collection("shared_folders")
			.getFullList<RemoteFolderDAO>({
				expand: "relay",
				fetch: customFetch,
			})
			.then((remoteFolders) => {
				remoteFolders.forEach((record) => {
					this.store?.ingest(record);
				});
			});
	}

	async acceptInvitation(shareKey: string): Promise<Relay> {
		const response = await this.pb.send("/api/accept-invitation", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				key: shareKey,
			}),
			fetch: customFetch,
		});
		this.log("[InviteAccept]", response);
		const relay = this.store?.ingest<Relay>(response);
		if (!relay) {
			throw new Error("Failed to accept invitation");
		}
		return relay;
	}

	async createRelay(name: string): Promise<Relay> {
		const guid = uuid();
		const record = await this.pb.collection("relays").create<RelayDAO>(
			{
				guid: guid,
				name: name,
				path: null,
			},

			{ fetch: customFetch }
		);
		if (!this.user) {
			throw new Error("Not Logged In");
		}
		const relay = new RelayAuto(
			record,
			this.roles,
			this.relayRoles,
			this.relayInvitations,
			this.remoteFolders,
			this.user
		);
		this.relays.set(relay.id, relay);
		return relay;
	}

	async updateRelay(relay: Relay): Promise<Relay> {
		const record = await this.pb.collection("relays").update<RelayDAO>(
			relay.id,
			{
				name: relay.name.trim(),
			},
			{ fetch: customFetch }
		);
		const updated = this.store?.ingest<Relay>(record);
		if (!updated) {
			throw new Error("Failed to update relay");
		}
		return updated;
	}

	async deleteRemote(folder: SharedFolder): Promise<boolean> {
		folder.remote = undefined;
		const remote = this.remoteFolders.find(
			(remote) => remote.guid === folder.guid
		);
		if (!remote) {
			return false;
		}
		await this.pb
			.collection("shared_folders")
			.delete(remote.id, { fetch: customFetch });
		folder.remote = undefined;
		return true;
	}

	async createRemoteFolder(
		sharedFolder: SharedFolder,
		relay: Relay
	): Promise<RemoteFolder> {
		const record = await this.pb
			.collection("shared_folders")
			.create<RemoteFolderDAO>(
				{
					name: sharedFolder.name,
					guid: sharedFolder.guid,
					relay: relay.id,
					creator: this.user?.id,
					private: false,
				},
				{ fetch: customFetch, expand: "relay" }
			);
		const folder = this.store?.ingest<RemoteFolder>(record);
		if (!folder) {
			throw new Error("Failed to create folder");
		}
		return folder;
	}

	async destroyRelay(relay: Relay): Promise<boolean> {
		await this.pb
			.collection("relays")
			.delete(relay.id, { fetch: customFetch });
		this.store?.cascade("relays", relay.id);
		return true;
	}

	async leaveRelay(relay: Relay): Promise<void> {
		const role = this.relayRoles.find((role) => {
			return (
				role.user.id === this.user?.id && role.relay?.id === relay.id
			);
		});
		if (role) {
			await this.pb
				.collection("relay_roles")
				.delete(role.id, { fetch: customFetch });
		} else {
			console.warn("No role found to leave relay");
		}
		this.store?.cascade("relay", relay.id);
	}

	async kick(relay_role: RelayRole) {
		return this.pb.collection("relay_roles").delete(relay_role.id);
	}

	unsubscribe() {
		if (this.pb) {
			this.pb.collection("relays").unsubscribe();
			this.pb.collection("relay_roles").unsubscribe();
			this.pb.collection("relay_invitations").unsubscribe();
			this.pb.collection("shared_folders").unsubscribe();
		}
	}

	destroy(): void {
		this.unsubscribe();
		this.pb.cancelAllRequests();
	}
}
