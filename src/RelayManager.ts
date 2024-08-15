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
	type RecordSubscription,
} from "pocketbase";
import { ObservableMap } from "./observable/ObservableMap";
import { curryLog } from "./debug";
import { customFetch } from "./customFetch";
import type { SharedFolder } from "./SharedFolder";
import type { LoginManager } from "./LoginManager";
import type { Unsubscriber } from "svelte/motion";
import { Observable } from "./observable/Observable";
import { PostOffice } from "./observable/Postie";

interface Identified {
	id: string;
}

function hasId(obj: any): obj is Identified {
	return typeof obj.id === "string";
}

interface Named {
	name: string;
}

function hasName(obj: any): obj is Named {
	return typeof obj.name === "string";
}

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
	cta: string;
	plan: string;
}

interface RemoteFolderDAO extends RecordModel {
	id: string;
	guid: string;
	name: string;
	creator: string;
	relay: string;
	private: boolean;
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

interface Collection<D, A> {
	collectionName: string;
	items(): A[];
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

	items(): RoleDAO[] {
		return this.roles.values();
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
	return typeof obj.aggregate_root === "object";
}

interface hasACL {
	acl: [string, string] | undefined;
}

function hasACL(obj: any): obj is hasACL {
	return typeof obj.acl === "object";
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

	public get acl(): [string, string] {
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

	items(): RemoteFolder[] {
		return this.remoteFolders.values();
	}

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

	items(): Relay[] {
		return this.relays.values();
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

	items(): RelayRole[] {
		return this.relayRoles.values();
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

	items(): RelayInvitation[] {
		return this.relayInvitations.values();
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

	items(): RelayUser[] {
		return this.users.values();
	}

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

	items(): RelaySubscription[] {
		return this.subscriptions.values();
	}

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
	relationships: Map<string, Set<string>>;
	warn: (message: string, ...args: unknown[]) => void;
	error: (message: string, ...args: unknown[]) => void;

	constructor(collections: Collection<unknown, unknown>[]) {
		this.collections = new Map();
		this.relationships = new Map();
		for (const collection of collections) {
			this.collections.set(collection.collectionName, collection);
		}
		this.error = curryLog("[Store]", "error");
		this.warn = curryLog("[Store]", "warn");
		this.warn("instance", this);
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
		const postie = PostOffice.getInstance();
		postie.beginTransaction();
		this.collections.forEach((collection) => {
			collection.clear();
		});
		this.collections.clear();
		this.relationships.clear();
		postie.commitTransaction();
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
			const aggregate_root = result.aggregate_root;
			if (aggregate_root) {
				const pointer = record.id;
				const refs =
					this.relationships.get(aggregate_root.join(":")) ||
					new Set<string>();
				refs.add([record.collectionName, pointer].join(":"));
				this.relationships.set(aggregate_root.join(":"), refs);
			}
		}
		if (hasACL(result)) {
			const acl = result.acl;
			if (acl) {
				const pointer = record.id;
				const refs =
					this.relationships.get(acl.join(":")) || new Set<string>();
				refs.add([record.collectionName, pointer].join(":"));
				this.relationships.set(acl.join(":"), refs);
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

	graphviz() {
		let dot = "digraph G {\n";
		for (const [collectionName, collection] of this.collections) {
			//dot += `  ${collectionName} [shape=box];\n`;
			for (const record of collection.items()) {
				if (!hasId(record)) {
					this.warn("record has no id", record);
					continue;
				}
				let name = collectionName + "_" + record.id;
				if (hasName(record)) {
					name = collectionName + "_" + record.name;
				}
				dot += `  ${collectionName}_${record.id} [label="${name}"];\n`;
				if (hasId(record) && hasRoot(record)) {
					if (record.aggregate_root) {
						const [rootCollection, rootId] = record.aggregate_root;
						dot += `  ${collectionName}_${record.id} -> ${rootCollection}_${rootId};\n`;
					}
				}
				if (hasId(record) && hasACL(record)) {
					if (record.acl) {
						const [aclCollection, aclId] = record.acl;
						dot += `  ${collectionName}_${record.id} -> ${aclCollection}_${aclId} [style=dotted];\n`;
					}
				}
			}
		}
		dot += "}";
		return dot;
	}

	cascade(collectionName: string, id: string) {
		const collection = this.collections.get(collectionName);
		const children = this.relationships.get([collectionName, id].join(":"));
		const postie = PostOffice.getInstance();
		postie.beginTransaction();
		if (collection) {
			this.warn("cascade delete parent", collectionName, id);
			collection.delete(id);
		}
		this.relationships.delete([collectionName, id].join(":"));
		for (const fqid of children || []) {
			const [childCollection, childId] = fqid.split(":");
			this.warn("cascade delete child", childCollection, childId);
			const collection = this.getCollection(childCollection);
			if (collection) {
				this.cascade(childCollection, childId);
			}
		}
		postie.commitTransaction();
	}
}

class RelayRoleAuto extends Auto implements RelayRole {
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

	public get acl(): [string, string] {
		return ["users", this.relayRole.user];
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
	token: string;
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

	public get token() {
		return this.subscription.token;
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
		return ["users", this.subscription.user];
	}
}

class RelayAuto extends Observable<Relay> implements Relay, hasACL {
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

	public get cta() {
		return this.relay.cta;
	}

	public get plan() {
		return this.relay.plan;
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
	authUser?: AuthModel;
	user?: RelayUser;
	store?: Store;
	_offLoginManager: Unsubscriber;
	log: (message: string, ...args: unknown[]) => void;
	warn: (message: string, ...args: unknown[]) => void;
	private pb: PocketBase;

	constructor(private loginManager: LoginManager) {
		this.log = curryLog("[RelayManager]", "log");
		this.warn = curryLog("[RelayManager]", "warn");
		this.pb = this.loginManager.pb;

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

		// Subscribe to logout/login
		this._offLoginManager = this.loginManager.subscribe(() => {
			this.login();
		});

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
			.getList<RelayInvitationDAO>(0, 200)
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
		const collections = [
			{
				name: "relays",
				expand: [
					"relay_invitations_via_relay",
					"shared_folders_via_relay",
					"shared_folders_via_relay.creator",
					"subscriptions_via_relay",
					"subscriptions_via_relay.relay",
					"creator",
				],
			},
			{ name: "relay_invitations", expand: ["relay"] },
			{ name: "relay_roles", expand: ["user", "relay"] },
			{ name: "shared_folders", expand: ["relay", "creator"] },
			{ name: "subscriptions", expand: ["user", "relay"] },
		];

		const handleEvent = (
			collectionName: string,
			e: RecordSubscription<RecordModel>
		) => {
			this.log(`[Event]: ${collectionName}`, e.action, e.record);
			if (e.action === "delete") {
				this.store?.delete(e.record);
			} else {
				this.store?.ingest(e.record);
			}
		};

		for (const collection of collections) {
			this.pb
				.collection(collection.name)
				.subscribe("*", (e) => handleEvent(collection.name, e), {
					expand: collection.expand.join(","),
					fetch: customFetch,
				});
		}
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
			})
			.then((user) => {
				this.store?.ingest(user);
			})
			.catch((e) => {
				if (e.status === 404) {
					this.loginManager.logout();
				}
			});

		await this.pb
			.collection("relay_roles")
			.getFullList<RelayRoleDAOExpandingRelayUser>({
				expand: "user",
			})
			.then((roles) => {
				roles.forEach((record) => {
					this.store?.ingest(record);
				});
			});
		await this.pb
			.collection("relay_invitations")
			.getFullList<RelayInvitationDAO>()
			.then((relayInvitations) => {
				relayInvitations.forEach((record) => {
					this.store?.ingest(record);
				});
			});
		await this.pb
			.collection("shared_folders")
			.getFullList<RemoteFolderDAO>({
				expand: "relay,creator",
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
		const record = await this.pb.collection("relays").create<RelayDAO>({
			guid: guid,
			name: name,
			path: null,
		});
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
		const record = await this.pb
			.collection("relays")
			.update<RelayDAO>(relay.id, {
				name: relay.name.trim(),
			});
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
		await this.pb.collection("shared_folders").delete(remote.id);
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
				{ expand: "relay" }
			);
		const folder = this.store?.ingest<RemoteFolder>(record);
		if (!folder) {
			throw new Error("Failed to create folder");
		}
		return folder;
	}

	async destroyRelay(relay: Relay): Promise<boolean> {
		await this.pb.collection("relays").delete(relay.id);
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
			await this.pb.collection("relay_roles").delete(role.id);
		} else {
			this.warn("No role found to leave relay");
		}
		this.store?.cascade("relay", relay.id);
	}

	async kick(relay_role: RelayRole) {
		return this.pb.collection("relay_roles").delete(relay_role.id);
	}

	destroy(): void {
		if (this._offLoginManager) {
			this._offLoginManager();
		}
	}
}
