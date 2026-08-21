"use strict";

/**
 * State paths, events, and facts for the folder machine.
 *
 * The machine derives its state from monotone facts — each false-to-true
 * once — so the state cannot go backwards. `folderStateOf` in the machine
 * definition is the pure oracle for that derivation.
 */

export type FolderStatePath =
	| "loading"
	| "discovering"
	| "reconciling"
	| "active"
	| "closed";

export type FolderEvent =
	| { type: "REPLAY_COMPLETE" }
	| { type: "DISK_SCANNED" }
	| { type: "PROVIDER_SYNCED" }
	| { type: "CLOSE" };

export interface FolderFacts {
	/** The persistence replay finished. */
	replayComplete: boolean;
	/** The startup disk scan finished (or was abandoned by a failed boot). */
	diskScanned: boolean;
	/** The provider completed its first sync. */
	providerSynced: boolean;
	/** Destroyed. */
	closed: boolean;
}
