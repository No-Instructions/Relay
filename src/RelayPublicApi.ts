import * as Y from "yjs";
import type Live from "./main";
import type { Document } from "./Document";
import { isDocument } from "./Document";
import type { RelayUser } from "./Relay";
import type { SharedFolder } from "./SharedFolder";
import { usercolors } from "./User";

export interface RelayPublicUser {
	id: string;
	name: string;
	picture?: string;
	color?: string;
	colorLight?: string;
	isCurrentUser: boolean;
}

export interface RelayDocumentContext {
	path: string;
	virtualPath: string;
	sharedFolderPath: string;
	sharedFolderGuid: string;
	relayId: string | null;
	remoteSharedFolderId: string | null;
	documentGuid: string | null;
	isLoaded: boolean;
	isWritable: boolean;
}

export interface RelayAttributionRange {
	from: number;
	to: number;
	user: RelayPublicUser;
}

export interface RelayIdentityApi {
	getCurrentUser(path?: string): RelayPublicUser | null;
	resolveUser(userId: string, path?: string): RelayPublicUser | null;
	listUsersForPath(path: string): RelayPublicUser[];
}

export interface RelayDocumentsApi {
	getContext(path: string): RelayDocumentContext | null;
}

export interface RelayAttributionApi {
	getAuthorsForRange(path: string, from: number, to: number): RelayAttributionRange[];
	getDominantAuthorForRange(path: string, from: number, to: number): RelayPublicUser | null;
}

export interface RelayAwarenessApi {
	getOnlineUsers(path: string): RelayPublicUser[];
}

export interface RelayPublicApiV1 {
	version: 1;
	identity: RelayIdentityApi;
	documents: RelayDocumentsApi;
	attribution: RelayAttributionApi;
	awareness: RelayAwarenessApi;
}

interface PathLookup {
	folder: SharedFolder;
	virtualPath: string;
	documentGuid: string | null;
	document: Document | null;
}

interface YItemLike {
	id: { client: number };
	length: number;
	deleted?: boolean;
	right?: YItemLike | null;
}

interface RelayUserLike {
	id?: string;
	name?: string;
	picture?: string;
	color?: {
		color?: string;
		light?: string;
	};
}

interface AwarenessUserLike {
	id?: string;
	name?: string;
	color?: string;
	colorLight?: string;
}

export class RelayPublicApi implements RelayPublicApiV1 {
	readonly version = 1 as const;

	readonly identity: RelayIdentityApi = {
		getCurrentUser: (path?: string) => this.getCurrentUser(path),
		resolveUser: (userId: string, path?: string) => this.resolveUser(userId, path),
		listUsersForPath: (path: string) => this.listUsersForPath(path),
	};

	readonly documents: RelayDocumentsApi = {
		getContext: (path: string) => this.getDocumentContext(path),
	};

	readonly attribution: RelayAttributionApi = {
		getAuthorsForRange: (path: string, from: number, to: number) =>
			this.getAuthorsForRange(path, from, to),
		getDominantAuthorForRange: (path: string, from: number, to: number) =>
			this.getDominantAuthorForRange(path, from, to),
	};

	readonly awareness: RelayAwarenessApi = {
		getOnlineUsers: (path: string) => this.getOnlineUsers(path),
	};

	constructor(private plugin: Live) {}

	private getCurrentUser(path?: string): RelayPublicUser | null {
		const user = this.plugin.loginManager?.user ?? this.plugin.relayManager?.user;
		if (!user?.id) return null;
		return this.userToPublicUser(user, path);
	}

	private resolveUser(userId: string, path?: string): RelayPublicUser | null {
		return this.resolveUserSummary(userId, path, false);
	}

	private listUsersForPath(path: string): RelayPublicUser[] {
		const lookup = this.lookupPath(path);
		if (!lookup) return [];

		const userIds = new Set<string>();
		const localDoc = lookup.document?.localDoc;
		if (localDoc) {
			const usersMap = localDoc.getMap("users");
			usersMap.forEach((_entry: unknown, userId: string) => {
				userIds.add(userId);
			});
		}

		for (const onlineUser of this.getOnlineUsers(path)) {
			userIds.add(onlineUser.id);
		}

		const currentUser = this.getCurrentUser(path);
		if (currentUser) {
			userIds.add(currentUser.id);
		}

		return [...userIds]
			.map((userId) => this.resolveUserSummary(userId, path, true))
			.filter((user): user is RelayPublicUser => user !== null);
	}

	private getDocumentContext(path: string): RelayDocumentContext | null {
		const lookup = this.lookupPath(path);
		if (!lookup) return null;

		return {
			path,
			virtualPath: lookup.virtualPath,
			sharedFolderPath: lookup.folder.path,
			sharedFolderGuid: lookup.folder.guid,
			relayId: lookup.folder.relayId ?? null,
			remoteSharedFolderId: lookup.folder.remote?.id ?? null,
			documentGuid: lookup.documentGuid,
			isLoaded: lookup.document !== null,
			isWritable: lookup.document?.isWritable ?? false,
		};
	}

	private getAuthorsForRange(
		path: string,
		fromOffset: number,
		toOffset: number,
	): RelayAttributionRange[] {
		const lookup = this.lookupPath(path);
		const ydoc = lookup?.document?.localDoc;
		if (!lookup || !ydoc) return [];

		const ytext = ydoc.getText("contents");
		const docLength = ytext.toString().length;
		const from = clampOffset(fromOffset, docLength);
		const to = clampOffset(toOffset, docLength);
		if (to <= from) return [];

		const clientToUser = this.getClientToUserMap(ydoc);
		const ranges: RelayAttributionRange[] = [];
		let pos = 0;
		let item: YItemLike | null =
			(ytext as unknown as { _start?: YItemLike | null })._start ?? null;

		while (item) {
			const len = item.length;
			if (!item.deleted) {
				const itemFrom = pos;
				const itemTo = pos + len;
				const overlapFrom = Math.max(itemFrom, from);
				const overlapTo = Math.min(itemTo, to);
				const userId = clientToUser.get(String(item.id.client));
				if (userId && overlapTo > overlapFrom) {
					const user = this.resolveUserSummary(userId, path, true);
					if (user) {
						appendAttributionRange(ranges, {
							from: overlapFrom,
							to: overlapTo,
							user,
						});
					}
				}
				pos = itemTo;
			}
			item = item.right ?? null;
		}

		return ranges;
	}

	private getDominantAuthorForRange(
		path: string,
		from: number,
		to: number,
	): RelayPublicUser | null {
		const ranges = this.getAuthorsForRange(path, from, to);
		if (ranges.length === 0) return null;

		const counts = new Map<string, { user: RelayPublicUser; count: number }>();
		for (const range of ranges) {
			const current = counts.get(range.user.id) ?? { user: range.user, count: 0 };
			current.count += range.to - range.from;
			counts.set(range.user.id, current);
		}

		let best: { user: RelayPublicUser; count: number } | null = null;
		for (const entry of counts.values()) {
			if (!best || entry.count > best.count) {
				best = entry;
			}
		}
		return best?.user ?? null;
	}

	private getOnlineUsers(path: string): RelayPublicUser[] {
		const lookup = this.lookupPath(path);
		if (!lookup?.document) return [];

		const states = this.getAwarenessStates(lookup.document);
		const users = new Map<string, RelayPublicUser>();
		states.forEach((state: unknown) => {
			const awarenessUser = getAwarenessUser(state);
			if (!awarenessUser?.id) return;
			const user = this.userToPublicUser(
				this.lookupKnownUser(awarenessUser.id) ?? awarenessUser,
				path,
				awarenessUser,
			);
			if (user) users.set(user.id, user);
		});
		return [...users.values()];
	}

	private lookupPath(path: string): PathLookup | null {
		const folder = this.plugin.sharedFolders?.lookup(path);
		if (!folder) return null;

		let virtualPath: string;
		try {
			virtualPath = folder.getVirtualPath(path);
		} catch (_error) {
			return null;
		}

		const documentGuid = folder.syncStore.get(virtualPath) ?? null;
		const file = documentGuid ? folder.files.get(documentGuid) : undefined;
		return {
			folder,
			virtualPath,
			documentGuid,
			document: isDocument(file) ? file : null,
		};
	}

	private getClientToUserMap(ydoc: Y.Doc): Map<string, string> {
		const clientToUser = new Map<string, string>();
		const usersMap = ydoc.getMap("users");
		usersMap.forEach((entry: unknown, userId: string) => {
			const ids = (entry as { get?: (key: string) => unknown })?.get?.("ids");
			const idsArray =
				typeof (ids as { toArray?: () => unknown[] } | undefined)?.toArray ===
				"function"
					? (ids as { toArray: () => unknown[] }).toArray()
					: null;
			if (!idsArray) return;
			for (const clientId of idsArray) {
				clientToUser.set(String(clientId), userId);
			}
		});
		return clientToUser;
	}

	private resolveUserSummary(
		userId: string,
		path: string | undefined,
		includeUnknown: boolean,
	): RelayPublicUser | null {
		const knownUser = this.lookupKnownUser(userId);
		if (knownUser) {
			return this.userToPublicUser(knownUser, path);
		}

		const awarenessUser = path ? this.lookupAwarenessUser(path, userId) : null;
		if (awarenessUser) {
			return this.userToPublicUser(awarenessUser, path, awarenessUser);
		}

		if (!includeUnknown) return null;

		return {
			id: userId,
			name: userId,
			...colorForUserId(userId),
			isCurrentUser: this.isCurrentUserId(userId),
		};
	}

	private lookupKnownUser(userId: string): RelayUser | RelayUserLike | null {
		const currentUser =
			this.plugin.loginManager?.user?.id === userId
				? this.plugin.loginManager.user
				: null;
		const currentRelayUser =
			this.plugin.relayManager?.user?.id === userId
				? this.plugin.relayManager.user
				: null;
		return (
			currentUser ??
			currentRelayUser ??
			this.plugin.relayManager?.users.get(userId) ??
			null
		);
	}

	private lookupAwarenessUser(
		path: string,
		userId: string,
	): AwarenessUserLike | null {
		const lookup = this.lookupPath(path);
		if (!lookup?.document) return null;

		let found: AwarenessUserLike | null = null;
		this.getAwarenessStates(lookup.document).forEach((state: unknown) => {
			const awarenessUser = getAwarenessUser(state);
			if (awarenessUser?.id === userId) {
				found = awarenessUser;
			}
		});
		return found;
	}

	private getAwarenessStates(document: Document): Map<number, unknown> {
		const awareness = (document as unknown as {
			_provider?: { awareness?: { getStates?: () => Map<number, unknown> } };
		})._provider?.awareness;
		return awareness?.getStates?.() ?? new Map();
	}

	private userToPublicUser(
		user: RelayUserLike | AwarenessUserLike | undefined | null,
		path?: string,
		awarenessUser?: AwarenessUserLike | null,
	): RelayPublicUser | null {
		if (!user?.id) return null;

		const awareness =
			awarenessUser ?? (path ? this.lookupAwarenessUser(path, user.id) : null);
		const explicitColor = getExplicitColor(user, awareness);
		return {
			id: user.id,
			name: user.name || user.id,
			picture: "picture" in user ? user.picture : undefined,
			...(explicitColor ?? colorForUserId(user.id)),
			isCurrentUser: this.isCurrentUserId(user.id),
		};
	}

	private isCurrentUserId(userId: string): boolean {
		return (
			this.plugin.loginManager?.user?.id === userId ||
			this.plugin.relayManager?.user?.id === userId
		);
	}
}

function appendAttributionRange(
	ranges: RelayAttributionRange[],
	range: RelayAttributionRange,
): void {
	const previous = ranges[ranges.length - 1];
	if (previous && previous.user.id === range.user.id && previous.to === range.from) {
		previous.to = range.to;
		return;
	}
	ranges.push(range);
}

function getAwarenessUser(state: unknown): AwarenessUserLike | null {
	const user = (state as { user?: AwarenessUserLike } | null | undefined)?.user;
	return user?.id ? user : null;
}

function getExplicitColor(
	user: RelayUserLike | AwarenessUserLike,
	awarenessUser?: AwarenessUserLike | null,
): { color: string; colorLight: string } | null {
	const color = awarenessUser?.color ?? ("color" in user ? user.color : undefined);
	if (typeof color === "string" && color.length > 0) {
		return {
			color,
			colorLight: awarenessUser?.colorLight ?? `${color}33`,
		};
	}
	if (typeof color === "object" && color?.color) {
		return {
			color: color.color,
			colorLight: color.light ?? `${color.color}33`,
		};
	}
	return null;
}

function colorForUserId(userId: string): { color: string; colorLight: string } {
	let hash = 0;
	for (let i = 0; i < userId.length; i++) {
		hash = (hash * 31 + userId.charCodeAt(i)) | 0;
	}
	const color = usercolors[Math.abs(hash) % usercolors.length];
	return {
		color: color.color,
		colorLight: color.light,
	};
}

function clampOffset(offset: number, docLength: number): number {
	if (!Number.isFinite(offset)) return 0;
	return Math.max(0, Math.min(Math.floor(offset), docLength));
}
