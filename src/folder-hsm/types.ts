"use strict";

/**
 * State paths, events, and facts for the folder machine.
 *
 * Every fact is monotone — false to true, once — so the state derived from
 * them cannot go backwards. `folderStateOf` in the machine definition is
 * the pure oracle for that derivation.
 */

export type FolderStatePath =
	| "loading"
	| "discovering"
	| "reconciling"
	| "active"
	| "closed";

export type FolderEvent =
	| {
			type: "REPLAY_COMPLETE";
			/** This device has a folder DB to read (or a persisted
			 * server-sync marker) — snapshot evidence of its own. */
			hasPersistedMembership: boolean;
	}
	| { type: "DISK_SCANNED" }
	| { type: "PROVIDER_SYNCED" }
	| { type: "INITIAL_RECONCILE_COMPLETE" }
	| { type: "CLOSE" };

export interface FolderFacts {
	/** The persistence replay finished (the boot snapshot is pinned). */
	replayComplete: boolean;
	/** This device had persisted membership to replay. */
	hasPersistedMembership: boolean;
	/** The provider completed a sync (vacuous for authoritative folders). */
	providerSynced: boolean;
	/** The startup disk scan finished (or was abandoned by a failed boot). */
	diskScanned: boolean;
	/** The initial reconcile — snapshot decisions against the server's
	 * completed view — drained. */
	initialReconcileComplete: boolean;
	/** Destroyed. */
	closed: boolean;
}
