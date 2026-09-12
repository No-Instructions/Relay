import type { CliData, CliFlags } from "obsidian";
import type { ConflictInfoSnapshot } from "../merge-hsm/conflict";
import type {
	FolderRole,
	Relay,
	RelayRole,
	RelayUser,
	RemoteSharedFolder,
	Role,
} from "../Relay";
import type { FeatureFlags } from "../flags";
import type { SyncCategory, SyncCategoryKey, SyncFlags } from "../SyncSettings";

export type CliFormat = "text" | "json";

/** A failure the CLI reports as an envelope instead of a thrown error. */
export class CliError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly extra: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "CliError";
	}
}

export interface CliResult {
	/** Machine payload. Objects merge under `ok: true`; arrays become `items`. */
	data: Record<string, unknown> | unknown[];
	/** Human rendering for `format=text`. */
	text: string;
}

export interface CliCommand {
	id: string;
	description: string;
	flags: CliFlags | null;
	run(params: CliData, ctx: CliContext): Promise<CliResult> | CliResult;
}

/** The slice of a Shared Folder the commands touch. */
export interface CliSharedFolder {
	path: string;
	guid: string;
	connected: boolean;
	remote: RemoteSharedFolder | undefined;
	syncSettingsManager: {
		getCategories(): Record<SyncCategoryKey, SyncCategory>;
		toggleCategory(category: keyof SyncFlags, enabled: boolean): Promise<void>;
	};
	resync(): Promise<void>;
}

export interface CliFolderStatus {
	label: string;
	queued: number;
	failures: number;
	actionable: { category: string; path: string; label: string }[];
}

export interface CliRelayManager {
	relays: { values(): Relay[] };
	relayRoles: { values(): RelayRole[] };
	folderRoles: { values(): FolderRole[] };
	users: { values(): RelayUser[] };
	createRelay(name: string): Promise<Relay>;
	updateRelay(relay: Relay): Promise<Relay>;
	leaveRelay(relay: Relay): Promise<void>;
	destroyRelay(relay: Relay): Promise<boolean>;
	kick(role: RelayRole): Promise<unknown>;
	deleteRemote(remote: RemoteSharedFolder): Promise<boolean>;
	createRemoteFolder(
		guid: string,
		name: string,
		relay: Relay,
		isPrivate?: boolean,
	): Promise<RemoteSharedFolder>;
	addFolderRole(
		remote: RemoteSharedFolder,
		userId: string,
		role: Role,
	): Promise<FolderRole>;
	removeFolderRole(role: FolderRole): Promise<void>;
}

export interface CliNoteState {
	statePath: string;
	hasConflict: boolean;
	hasLCA: boolean;
	diskMatchesIdb: boolean;
}

export type HunkResolution = "ours" | "theirs" | "both" | "neither";

/** Everything a command may reach. Narrow on purpose so tests can fake it. */
export interface CliContext {
	version: string;
	vault: {
		hasFolder(path: string): boolean;
		createFolder(path: string): Promise<void>;
	};
	login: {
		loggedIn: boolean;
		user?: { id: string; name: string; email: string };
	};
	relayManager: CliRelayManager;
	sharedFolders: {
		items(): CliSharedFolder[];
		init(path: string, remote?: RemoteSharedFolder): CliSharedFolder;
		clone(path: string, guid: string, relayId?: string): CliSharedFolder;
		delete(folder: CliSharedFolder): boolean;
		notifyListeners(): void;
	};
	folderStatus(folder: CliSharedFolder): CliFolderStatus;
	backgroundSync: { pause(): void; resume(): void; paused(): boolean };
	notes: {
		listConflicts(): { folderPath: string; guid: string; path: string }[];
		conflictInfo(path: string): Promise<ConflictInfoSnapshot>;
		resolveHunk(
			path: string,
			hunkId: string,
			resolution: HunkResolution,
		): Promise<string>;
		resolveContents(path: string, contents: string): Promise<string>;
		state(path: string): Promise<CliNoteState>;
		/** Ask the folder to converge the note with the server. */
		converge(path: string): Promise<boolean>;
	};
	flags: {
		get(): FeatureFlags;
		set(name: keyof FeatureFlags, value: boolean): Promise<void>;
	};
	debugging: { enabled(): boolean; set(on: boolean): void };
	metadataHealth(): { status: string; message: string | null } | null;
}
