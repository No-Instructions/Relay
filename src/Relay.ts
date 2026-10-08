import type { RequestUrlResponse } from "obsidian";
import type { IObservable } from "./observable/Observable";
import type { ObservableMap } from "./observable/ObservableMap";
import { flags } from "./flagManager";

export type Role = "Owner" | "Member" | "Reader";

export type Resource = [string, string];

interface Identified {
	id: string;
}
interface Updatable<T> {
	update(update: unknown): T;
}
interface HasAttachment {
	attachmentUrl(): Promise<string>;
	getAttachment(): Promise<RequestUrlResponse>;
}
interface HasPermissionParents {
	permissionParents: [string, string][];
}
interface Serializable {
	toDict: () => Record<string, unknown>;
}

export function hasPermissionParents(item: HasPermissionParents) {
	return Array.isArray(item.permissionParents);
}

export type Permission =
	| readonly ["folder", "read_content"]
	| readonly ["folder", "edit_content"]
	| readonly ["folder", "manage_files"]
	| readonly ["folder", "upload"]
	| readonly ["folder", "download"]
	| readonly ["folder", "manage_users"]
	| readonly ["folder", "make_private"] // TODO
	| readonly ["folder", "rename"]
	| readonly ["folder", "delete"]
	| readonly ["relay", "rename"]
	| readonly ["relay", "create_folder"]
	| readonly ["relay", "manage_users"]
	| readonly ["relay", "manage_sharing"]
	| readonly ["relay", "delete"]
	| readonly ["subscription", "manage"];

export interface RelayUser extends Identified, Updatable<RelayUser> {
	id: string;
	name: string;
	picture: string;
	email: string;
}

export interface Organization extends Identified, Updatable<Organization> {
	id: string;
	name: string;
}

export interface RemoteSharedFolder
	extends Identified,
		Updatable<RemoteSharedFolder>,
		IObservable<RemoteSharedFolder>,
		HasPermissionParents {
	id: string;
	guid: string;
	name: string;
	private: boolean;
	role: Role;
	owner: boolean;
	relay: Relay;
	relayId: string;
	creator: RelayUser;
	creatorId: string;
	permissionParents: [string, string][];
}

export interface Relay
	extends Identified,
		Updatable<Relay>,
		IObservable<Relay>,
		HasPermissionParents {
	id: string;
	guid: string;
	name: string;
	version: number;
	userLimit: number;
	role: Role;
	owner: boolean;
	invitation?: RelayInvitation;
	storageQuota?: StorageQuota;
	storageQuotaId: string;
	folders: ObservableMap<string, RemoteSharedFolder>;
	subscriptions: ObservableMap<string, RelaySubscription>;
	cta: string;
	plan: string;
	provider?: Provider;
	providerId?: string;
	permissionParents: [string, string][];
}

export interface Provider
	extends Identified,
		Updatable<Provider>,
		IObservable<Provider> {
	name: string;
	id: string;
	url: string;
	selfHosted: boolean;
	publicKey: string;
	keyType: string;
	keyId: string;
}

export interface StorageQuota
	extends Identified,
		IObservable<StorageQuota>,
		Updatable<StorageQuota> {
	name: string;
	quota: number;
	usage: number;
	maxFileSize: number;
	metered: boolean;
}

export interface RelayRole extends Identified, Updatable<RelayRole> {
	id: string;
	user: RelayUser;
	userId: string;
	role: Role;
	relay: Relay;
	relayId: string;
}

export interface FolderRole extends Identified, Updatable<FolderRole> {
	id: string;
	user: RelayUser;
	userId: string;
	role: Role;
	sharedFolder: RemoteSharedFolder;
	sharedFolderId: string;
}

export interface RelayInvitation
	extends Identified,
		Updatable<RelayInvitation> {
	id: string;
	role: Role;
	relay: Relay;
	relayId: string;
	key: string;
	enabled: boolean;
}

export interface RelaySubscription
	extends Identified,
		Updatable<RelaySubscription>,
		IObservable<RelaySubscription> {
	id: string;
	active: boolean;
	relay: Relay;
	relayId: string;
	user: RelayUser;
	cancelAt: Date | null;
	quantity: number;
	token: string;
}

export interface FileInfo
	extends Identified,
		Updatable<FileInfo>,
		HasAttachment,
		Serializable {
	id: string;
	guid: string;
	relay: Relay;
	parent: string | null;
	sharedFolder: RemoteSharedFolder;
	ctime: number;
	mtime: number;
	synchash: string;
	synctime: number;
	updated: string;
	created: string;
	type: string;
	name: string;
	deletedAt: number | null;
	lastParentId: string | null;
	isDirectory: boolean;
}

export interface FileInfoSend extends FileInfo {
	attachment: null | Blob | File;
}

/** The roles the client offers in role menus; Reader only when its flag is on. */
export function offeredRoles<T extends { name: string }>(roles: T[]): T[] {
	return roles.filter((role) =>
		role.name === "Owner" || role.name === "Member" ||
		(role.name === "Reader" && flags().enableReaderRole),
	);
}

/** Relay Reader is offered independently of the folder Reader flag. */
export function offeredRelayRoles<T extends { name: string }>(roles: T[]): T[] {
	return roles.filter((role) =>
		role.name === "Owner" || role.name === "Member" ||
		(role.name === "Reader" && flags().enableRelayReaderRole),
	);
}

/** Members may own folders; Readers may only receive folder Reader access. */
export function offeredFolderRoles<T extends { name: string }>(
	roles: T[],
	relayRole: Role | null | undefined,
): T[] {
	if (relayRole === "Reader") {
		return offeredRoles(roles).filter((role) => role.name === "Reader");
	}
	return relayRole === "Owner" || relayRole === "Member" ? offeredRoles(roles) : [];
}

/** Keep a valid selection, or choose a non-owner role within the available grant. */
export function selectedFolderRole(
	roles: { name: string }[],
	selected?: Role,
): Role | null {
	if (selected && roles.some((role) => role.name === selected)) return selected;
	if (roles.some((role) => role.name === "Member")) return "Member";
	if (roles.some((role) => role.name === "Reader")) return "Reader";
	return null;
}
