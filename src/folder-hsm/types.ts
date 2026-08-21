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
			hasPersistedMembership: boolean;
	}
	| { type: "DISK_SCANNED" }
	| { type: "PROVIDER_SYNCED" }
	| { type: "INITIAL_RECONCILE_COMPLETE" }
	| { type: "CLOSE" };

export interface FolderFacts {
	replayComplete: boolean;
	hasPersistedMembership: boolean;
	providerSynced: boolean;
	diskScanned: boolean;
	initialReconcileComplete: boolean;
	closed: boolean;
}
