import type { ConflictInfoSnapshot } from "../merge-hsm/conflict";
import type {
	RemoteSharedFolder,
} from "../Relay";
import type { FeatureFlags } from "../flags";
import type { SyncCategory, SyncCategoryKey, SyncFlags } from "../SyncSettings";

export { CliError } from "./schema";
export type { CliData, CliOption, CliResult, CliFormat } from "./schema";
import type { Command } from "./schema";
import type { ServerContext } from "./server";
export type CliCommand = Command<CliContext>;
export interface CliRegisteredCommand extends CliCommand { id: string }

/** The slice of a Shared Folder the commands touch. */
export interface CliSharedFolder {
	path: string;
	guid: string;
	connected: boolean;
	localOnly?: boolean;
	remote: RemoteSharedFolder | undefined;
	syncSettingsManager: {
		getCategories(): Record<SyncCategoryKey, SyncCategory>;
		toggleCategory(category: keyof SyncFlags, enabled: boolean): Promise<void>;
	};
	connect(): Promise<boolean>;
	/** Forget the remote; the server copy stays and the folder stays off every Relay Server until attached again. */
	detachRemote(): void;
	resync(): Promise<void>;
}

export interface CliFolderStatus {
	label: string;
	queued: number;
	failures: number;
	actionable: { category: string; path: string; label: string }[];
}

export type { ServerManager as CliRelayManager } from "./server";

export interface CliNoteState {
	statePath: string;
	hasConflict: boolean;
	hasLCA: boolean;
	diskMatchesIdb: boolean;
}

export type HunkResolution = "ours" | "theirs" | "both" | "neither";

/** Everything a command may reach. Narrow on purpose so tests can fake it. */
export interface CliContext extends ServerContext {
	version: string;
	vault: {
		name: string;
		path: string | null;
		hasFolder(path: string): boolean;
		createFolder(path: string): Promise<void>;
		readFile(path: string): Promise<string>;
	};
	login: {
		loggedIn: boolean;
		user?: { id: string; name: string; email: string };
	};
	sharedFolders: {
		items(): CliSharedFolder[];
		init(path: string, remote?: RemoteSharedFolder): CliSharedFolder;
		clone(path: string, guid: string, relayId?: string): CliSharedFolder;
		delete(folder: CliSharedFolder): boolean;
		notifyListeners(): void;
	};
	folderStatus(folder: CliSharedFolder): CliFolderStatus;
	backgroundSync: { pause(): void; resume(): void; paused(): boolean };
	/** The plugin's timers, so a deadline never reaches for a bare global. */
	timers: { setTimeout(callback: () => void, ms: number): number; clearTimeout(timerId: number): void };
	notes: {
		listConflicts(): { folderPath: string; guid: string; path: string }[];
		conflictInfo(path: string): Promise<ConflictInfoSnapshot>;
		resolveHunk(
			path: string,
			blockId: string,
			decision: HunkResolution,
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
	debugging: { enabled(): boolean; set(on: boolean): Promise<void> };
	metadataHealth(): { status: string; message: string | null } | null;
}
