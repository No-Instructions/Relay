import type { RequestUrlResponse } from "obsidian";
import type { IObservable } from "./observable/Observable";
import type { ObservableMap } from "./observable/ObservableMap";

export type Role = "Owner" | "Member";

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
interface Serializable {
	toDict: () => any;
}

export interface RelayUser extends Identified, Updatable<RelayUser> {
	id: string;
	name: string;
	picture: string;
	email: string;
}

export interface RemoteSharedFolder
	extends Identified,
		Updatable<RemoteSharedFolder> {
	id: string;
	guid: string;
	name: string;
	private: boolean;
	relay: Relay;
	creator: RelayUser;
	creatorId: string;
}

export interface Relay
	extends Identified,
		Updatable<Relay>,
		IObservable<Relay> {
	id: string;
	guid: string;
	name: string;
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
	acl?: [string, string];
}

export interface Provider
	extends Identified,
		Updatable<Provider>,
		IObservable<Provider> {
	name: string;
	id: string;
	url: string;
	selfHosted: boolean;
}

export interface StorageQuota
	extends Identified,
		IObservable<StorageQuota>,
		Updatable<StorageQuota> {
	name: string;
	quota: number;
	usage: number;
	maxFileSize: number;
}

export interface RelayRole extends Identified, Updatable<RelayRole> {
	id: string;
	user: RelayUser;
	userId: string;
	role: Role;
	relay: Relay;
	relayId: string;
}

export interface RelayInvitation
	extends Identified,
		Updatable<RelayInvitation> {
	id: string;
	role: Role;
	relay: Relay;
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
