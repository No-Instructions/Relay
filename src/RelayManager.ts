"use strict";

import { v4 as uuid } from "uuid";
import {
	type RelayRole,
	type Relay,
	type RelayInvitation,
	type Role,
	type RemoteSharedFolder as RemoteFolder,
	type RelayUser,
	type RelaySubscription,
	type RemoteSharedFolder,
} from "./Relay";
import PocketBase, {
	type AuthModel,
	type ListResult,
	type RecordModel,
} from "pocketbase";
import { ObservableMap } from "./observable/ObservableMap";
import { curryLog } from "./debug";
import { customFetch } from "./customFetch";
import type { SharedFolder } from "./SharedFolder";
import { requestUrl } from "obsidian";
import type { User } from "./User";
import type { LoginManager } from "./LoginManager";
import type { Unsubscriber } from "svelte/motion";
import { Observable } from "./observable/Observable";
import { PostOffice } from "./observable/Postie";

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

	ingest(update: RoleDAO): RoleDAO {
		this.roles.set(update.id, update);
		return update;
	}

	delete(id: string) {
		this.roles.delete(id);
	}
}

interface hasRoot {
	aggregate_root: [string, string] | undefined;
}

function hasRoot(obj: any): obj is hasRoot {
	return typeof obj.aggregate_root === "function";
}

interface hasACL {
	acl: [string, string] | undefined;
}

function hasACL(obj: any): obj is hasACL {
	return typeof obj.acl === "function";
}

class Auto implements hasRoot, hasACL {
	public get aggregate_root(): [string, string] | undefined {
		return;
	}

	public get acl(): [string, string] | undefined {
		return;
	}
}

class RelayUserAuto extends Auto implements RelayUser {
	constructor(private user: UserDAO) {
		super();
	}

	public get id() {
		return this.user.id;
	}

	public get name() {
		return this.user.name;
	}

	public update(update: UserDAO): RelayUser {
		this.user = update;
		return this;
	}
}

class RemoteFolderAuto extends Auto implements RemoteSharedFolder {
	constructor(
		private remoteFolder: RemoteFolderDAO,
		private relays: ObservableMap<string, Relay>,
		private users: ObservableMap<string, RelayUser>
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

	public get creator() {
		const user = this.users.get(this.remoteFolder.creator);
		if (!user) {
			throw new Error("invalid remote folder");
		}
		return user;
	}

	public get relay(): Relay {
		const relay = this.relays.get(this.remoteFolder.relay);
		if (!relay) {
			throw new Error("invalid remote folder");
		}
		return relay;
	}

	public get aggregate_root(): [string, string] {
		return ["relays", this.remoteFolder.relay];
	}
}

class RemoteFolderCollection
	implements Collection<RemoteFolderDAO, RemoteFolder>
{
	collectionName: string = "shared_folders";

	constructor(
		public remoteFolders: ObservableMap<string, RemoteFolder>,
		private relays: ObservableMap<string, Relay>,
		private users: ObservableMap<string, RelayUser>
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
		const folder = new RemoteFolderAuto(update, this.relays, this.users);
		this.remoteFolders.set(update.id, folder);
		return folder;
	}

	delete(id: string) {
		this.remoteFolders.delete(id);
	}
}

class RelayCollection implements Collection<RelayDAO, Relay> {
	collectionName: string = "relays";
	constructor(
		private relays: ObservableMap<string, Relay>,
		private roles: ObservableMap<string, RoleDAO>,
		private relayRoles: ObservableMap<string, RelayRole>,
		private relayInvitations: ObservableMap<string, RelayInvitation>,
		private remoteFolders: ObservableMap<string, RemoteFolder>,
		private subscriptions: ObservableMap<string, RelaySubscription>,
		private user: RelayUser
	) {}

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
			this.relayRoles,
			this.relayInvitations,
			this.remoteFolders,
			this.subscriptions,
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
	users: ObservableMap<string, RelayUser>;
	roles: ObservableMap<string, RoleDAO>;

	constructor(
		relayRoles: ObservableMap<string, RelayRole>,
		relays: ObservableMap<string, Relay>,
		users: ObservableMap<string, RelayUser>,
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

class UserCollection implements Collection<UserDAO, RelayUser> {
	collectionName: string = "users";

	constructor(private users: ObservableMap<string, RelayUser>) {}

	clear(): void {
		this.users.clear();
	}

	get(id: string) {
		return this.users.get(id);
	}

	ingest(update: UserDAO): RelayUser {
		const existingUser = this.users.get(update.id);
		if (existingUser) {
			existingUser.update(update);
			this.users.notifyListeners();
			return existingUser;
		}
		const user = new RelayUserAuto(update);
		this.users.set(update.id, user);
		return user;
	}

	delete(id: string) {
		this.users.delete(id);
	}
}

class RelaySubscriptionCollection
	implements Collection<RelaySubscriptionDAO, RelaySubscription>
{
	collectionName: string = "subscriptions";

	constructor(
		private subscriptions: ObservableMap<string, RelaySubscription>,
		private relays: ObservableMap<string, Relay>,
		private users: ObservableMap<string, RelayUser>
	) {}

	clear(): void {
		this.subscriptions.clear();
	}

	get(id: string) {
		return this.subscriptions.get(id);
	}

	ingest(update: RelaySubscriptionDAO): RelaySubscription {
		const existingsubscription = this.subscriptions.get(update.id);
		if (existingsubscription) {
			existingsubscription.update(update);
			this.subscriptions.notifyListeners();
			return existingsubscription;
		}
		const subscription = new RelaySubscriptionAuto(
			update,
			this.relays,
			this.users
		);
		this.subscriptions.set(update.id, subscription);
		return subscription;
	}

	delete(id: string) {
		this.subscriptions.delete(id);
	}
}

class Store {
	collections: Map<string, Collection<unknown, unknown>>;
	relationships: Map<[string, string], Set<[string, string]>>;
	error: (message: string, ...args: unknown[]) => void;

	constructor(collections: Collection<unknown, unknown>[]) {
		this.collections = new Map();
		this.relationships = new Map();
		for (const collection of collections) {
			this.collections.set(collection.collectionName, collection);
		}
		this.error = curryLog("[Store]", "error");
		console.warn("Store", this);
	}

	getCollection(collecitonName: string): Collection<unknown, unknown> {
		const collection = this.collections.get(collecitonName);
		if (!collection) {
			this.error("No collection found for", collecitonName);
			throw new Error("No collection found for " + collecitonName);
		}
		return collection;
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
		const postie = PostOffice.getInstance();
		postie.beginTransaction();
		const result = this._ingest<T>(record);
		postie.commitTransaction();
		return result;
	}

	private _ingest<T>(record?: RecordModel): T | undefined {
		if (!record) {
			return;
		}
		let result;
		const collection = this.collections.get(record.collectionName);
		if (collection) {
			result = collection.ingest(record) as T;
		} else {
			this.error("No collection found for record", record);
		}
		if (hasRoot(result)) {
			console.warn("has root", result, result.aggregate_root);
			const aggregate_root = result.aggregate_root;
			if (aggregate_root) {
				const pointer = record.id;
				const refs =
					this.relationships.get(aggregate_root) ||
					new Set<[string, string]>();
				refs.add([record.collectionName, pointer]);
				this.relationships.set(aggregate_root, refs);
			}
		}
		if (hasACL(result)) {
			console.warn("has ACL", result, result.acl);
			const acl = result.acl;
			if (acl) {
				const pointer = record.id;
				const refs =
					this.relationships.get(acl) || new Set<[string, string]>();
				refs.add([record.collectionName, pointer]);
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
		const children = this.relationships.get([collectionName, id]);
		const postie = PostOffice.getInstance();
		postie.beginTransaction();
		for (const [childCollection, childId] of children || []) {
			const collection = this.getCollection(childCollection);
			if (collection) {
				collection.delete(childId);
				this.relationships.delete([collectionName, childId]);
			}
		}
		if (collection) {
			collection.delete(id);
		}
		postie.commitTransaction();
	}
}

export class RelayRoleAuto extends Auto implements RelayRole {
	users: ObservableMap<string, RelayUser>;
	roles: ObservableMap<string, RoleDAO>;
	relays: ObservableMap<string, Relay>;
	relayRole: RelayRoleDAO;

	constructor(
		relayRole: RelayRoleDAO,
		relays: ObservableMap<string, Relay>,
		users: ObservableMap<string, RelayUser>,
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

	public get user(): RelayUser {
		const user = this.users.get(this.relayRole.user);
		if (!user) {
			throw new Error(`Unable to find user: ${this.relayRole.user}`);
		}
		return user;
	}

	public get role(): Role {
		return this.roles.get(this.relayRole.role)?.name as Role;
	}

	public get relayId(): string {
		return this.relayRole.relay;
	}

	public get relay(): Relay {
		const relay = this.relays.get(this.relayRole.relay);
		if (!relay) {
			throw new Error("invalid role");
		}
		return relay;
	}

	public get aggregate_root(): [string, string] {
		return ["relays", this.relayRole.relay];
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
		return ["relays", this.relayInvitation.relay];
	}
}

interface RelaySubscriptionDAO extends RecordModel {
	id: string;
	active: boolean;
	user: string;
	relay: string;
	stripe_cancel_at: number;
	stripe_quantity: number;
}

export class RelaySubscriptionAuto
	extends Observable<RelaySubscription>
	implements RelaySubscription
{
	constructor(
		private subscription: RelaySubscriptionDAO,
		private relays: ObservableMap<string, Relay>,
		private users: ObservableMap<string, RelayUser>
	) {
		super();
	}

	update(subscription: RelaySubscriptionDAO): RelaySubscription {
		this.subscription = subscription;
		this.notifyListeners();
		return this;
	}

	public get id() {
		return this.subscription.id;
	}

	public get active() {
		return this.subscription.active;
	}

	public get user(): RelayUser {
		const user = this.users.get(this.subscription.user);
		if (!user) {
			throw new Error("invalid subscription");
		}
		return user;
	}

	public get relayId() {
		return this.subscription.relay;
	}

	public get relay(): Relay {
		const relay = this.relays.get(this.subscription.relay);
		if (!relay) {
			throw new Error("invalid subscription");
		}
		return relay;
	}

	public get stripe_cancel_at() {
		return this.subscription.stripe_cancel_at;
	}

	public get cancel_at(): Date | null {
		return this.subscription.stripe_cancel_at !== 0
			? new Date(this.subscription.stripe_cancel_at * 1000)
			: null;
	}

	public get quantity() {
		return this.subscription.stripe_quantity;
	}

	public get aggregate_root() {
		return ["relays", this.subscription.relay];
	}

	public get acl() {
		return ["relays", this.subscription.user];
	}
}

export class SubscriptionActions {
	constructor(
		public subscribe: string | null,
		public cancel: string | null,
		public manage: string | null,
		public cta: string | null
	) {}
}
declare const API_URL: string;

class SubscriptionManager {
	user?: User;
	private _offLoginManager: Unsubscriber;
	private _log: (message: string, ...args: unknown[]) => void;

	constructor(private loginManager: LoginManager) {
		this._log = curryLog("[SubscriptionManager]", "log");
		this._offLoginManager = this.loginManager.subscribe((loginManager) => {
			this.user = loginManager.user;
		});
	}

	destroy() {
		if (this._offLoginManager) {
			this._offLoginManager();
		}
	}

	log(message: string, ...args: unknown[]) {
		this._log(message, ...args);
	}

	async getPaymentLink(relay: Relay): Promise<SubscriptionActions> {
		console.warn("getting paymnent link", relay.id, this.user);
		if (!this.user) {
			throw new Error("User is not logged in.");
		}
		const headers = {
			Authorization: `Bearer ${this.user.token}`,
		};
		const response = await requestUrl({
			url: `${API_URL}/billing`,
			method: "POST",
			body: JSON.stringify({ relay: relay.id, quantity: 10 }),
			headers: headers,
		});
		if (response.status !== 200) {
			throw new Error(
				`Received status code ${response.status} from an API.`
			);
		}
		const response_json = response.json;

		const sub = new SubscriptionActions(
			response_json["subscribe"],
			response_json["cancel"],
			response_json["manage"],
			response_json["cta"]
		);
		return sub;
	}
}

// XXX this should probably not be exported
export class RelayAuto extends Observable<Relay> implements Relay, hasACL {
	log: (message: string, ...args: unknown[]) => void;
	warn: (message: string, ...args: unknown[]) => void;

	constructor(
		private relay: RelayDAO,
		private relayRoles: ObservableMap<string, RelayRole>,
		private relayInvitations: ObservableMap<string, RelayInvitation>,
		private remoteFolders: ObservableMap<string, RemoteFolder>,
		private _subscriptions: ObservableMap<string, RelaySubscription>,
		private user: RelayUser
	) {
		super();
		this.log = curryLog("[RelayAuto]", "log");
		this.warn = curryLog("[RelayAuto]", "warn");
	}

	update(update: RelayDAO): Relay {
		this.relay = update;
		this.notifyListeners();
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
		this.warn("couldn't find role", this.relay.id, this.user, isCreator);
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

	public get subscriptions(): ObservableMap<string, RelaySubscription> {
		return this._subscriptions.filter(
			(subscription) => subscription.relay.id === this.id
		);
	}

	public get acl(): [string, string] | undefined {
		const id = this.relayRoles.find((role) => {
			return role.relay.id === this.id && role.user.id === this.user.id;
		})?.id;
		if (id) {
			return ["relay_roles", id];
		}
	}
}

export class RelayManager {
	relays: ObservableMap<string, Relay>;
	relayRoles: ObservableMap<string, RelayRole>;
	relayInvitations: ObservableMap<string, RelayInvitation>;
	users: ObservableMap<string, RelayUser>;
	roles: ObservableMap<string, RoleDAO>;
	remoteFolders: ObservableMap<string, RemoteFolder>;
	subscriptions: ObservableMap<string, RelaySubscription>;
	sm: SubscriptionManager;
	authUser?: AuthModel;
	user?: RelayUser;
	store?: Store;
	log: (message: string, ...args: unknown[]) => void;
	warn: (message: string, ...args: unknown[]) => void;
	private pb: PocketBase;

	constructor(private loginManager: LoginManager) {
		this.log = curryLog("[RelayManager]", "log");
		this.warn = curryLog("[RelayManager]", "warn");

		this.pb = new PocketBase(AUTH_URL);
		this.pb.beforeSend = (url, options) => {
			this.log(url, options);
			return { url, options };
		};
		this.sm = new SubscriptionManager(this.loginManager);

		// Build the NodeLists
		this.users = new ObservableMap<string, RelayUser>("users");
		this.relays = new ObservableMap<string, Relay>("relays");
		this.remoteFolders = new ObservableMap<string, RemoteFolder>(
			"remote folders"
		);
		this.relayInvitations = new ObservableMap<string, RelayInvitation>(
			"relay invitations"
		);
		this.relayRoles = new ObservableMap<string, RelayRole>("relay roles");
		this.roles = new ObservableMap<string, RoleDAO>("roles");
		this.roles.set("2arnubkcv7jpce8", {
			name: "Owner",
			id: "2arnubkcv7jpce8",
		} as RoleDAO);
		this.roles.set("x6lllh2qsf9lxk6", {
			name: "Member",
			id: "x6lllh2qsf9lxk6",
		} as RoleDAO);
		this.subscriptions = new ObservableMap<string, RelaySubscription>(
			"subscriptions"
		);

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
			this.subscriptions,
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
			this.relays,
			this.users
		);
		const subscriptionCollection = new RelaySubscriptionCollection(
			this.subscriptions,
			this.relays,
			this.users
		);
		this.store = new Store([
			roleCollection,
			userCollection,
			relayCollection,
			relayRolesCollection,
			relayInvitationsCollection,
			sharedFolderCollection,
			subscriptionCollection,
		]);
	}

	setUser() {
		this.authUser = this.pb.authStore.model;
		if (this.authUser) {
			this.user = new RelayUserAuto(this.authUser as UserDAO);
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
						"shared_folders_via_relay.creator",
						"subscriptions_via_relay",
						"subscriptions_via_relay.relay",
						"creator",
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
				expand: ["relay", "creator"],
				fetch: customFetch,
			}
		);
		this.pb.collection("subscriptions").subscribe<RelaySubscriptionDAO>(
			"*",
			(e) => {
				this.log("event: subscriptions", e.action, e.record);
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
			return;
		}

		await this.pb
			.collection("users")
			.getOne<UserDAOExpandingRelayRoles>(this.pb.authStore.model.id, {
				expand: "relay_roles_via_user,relay_roles_via_user.relay,relay_roles_via_user.role,subscriptions_via_user,subscriptions_via_user.relay",
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
				expand: "relay,creator",
				fetch: customFetch,
			})
			.then((remoteFolders) => {
				remoteFolders.forEach((record) => {
					this.store?.ingest(record);
				});
			});
		await this.pb
			.collection("subscriptions")
			.getFullList<RemoteFolderDAO>({
				expand: "relay,user",
				fetch: customFetch,
			})
			.then((subscriptions) => {
				subscriptions.forEach((record) => {
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
			this.relayRoles,
			this.relayInvitations,
			this.remoteFolders,
			this.subscriptions,
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
			this.warn("No role found to leave relay");
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
			this.pb.collection("subscriptions").unsubscribe();
		}
	}

	destroy(): void {
		this.unsubscribe();
		this.pb.cancelAllRequests();
		this.sm.destroy();
	}
}
