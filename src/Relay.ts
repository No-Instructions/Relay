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
	folders: ObservableMap<string, RemoteSharedFolder>;
	subscriptions: ObservableMap<string, RelaySubscription>;
	cta: string;
	plan: string;
}

export interface RelayRole extends Identified, Updatable<RelayRole> {
	id: string;
	user: RelayUser;
	userId: string;
	role: Role;
	relay: Relay;
}

export interface RelayInvitation
	extends Identified,
		Updatable<RelayInvitation> {
	id: string;
	role: Role;
	relay: Relay;
	key: string;
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
