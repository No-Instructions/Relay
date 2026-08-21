"use strict";

/**
 * Declarative machine definition for the folder machine.
 *
 * Every state handles the same fact events: record the fact, then let the
 * always-cascade settle on the state `folderStateOf` derives. The cascade
 * guards compare the derived state against the current one, so the machine
 * agrees with the pure oracle after every event — a property the exhaustive
 * test asserts over all event orderings.
 */

import type { EventHandler, MachineDefinition, StateNode } from "../hsm/types";
import type { FolderFacts, FolderStatePath } from "./types";

/**
 * The state as a pure total function of the facts: a descending cascade.
 *
 * `publicationLatch` is the sync-convergence latch: when enabled, locally
 * discovered files may mint identities but publication waits for the
 * provider's first completed sync (`reconciling`). When disabled, a scanned
 * folder is immediately `active`.
 */
export function folderStateOf(
	facts: FolderFacts,
	publicationLatch: boolean,
): FolderStatePath {
	if (facts.closed) return "closed";
	if (!facts.diskScanned) {
		return facts.replayComplete ? "discovering" : "loading";
	}
	if (publicationLatch && !facts.providerSynced) return "reconciling";
	return "active";
}

const FACT_EVENTS = (
	self: FolderStatePath,
): Record<string, EventHandler<FolderStatePath>> => ({
	REPLAY_COMPLETE: {
		target: self,
		actions: ["recordReplayComplete"],
		reenter: true,
	},
	DISK_SCANNED: { target: self, actions: ["recordDiskScanned"], reenter: true },
	PROVIDER_SYNCED: {
		target: self,
		actions: ["recordProviderSynced"],
		reenter: true,
	},
	CLOSE: { target: self, actions: ["recordClosed"], reenter: true },
});

const CASCADE: StateNode<FolderStatePath>["always"] = [
	{ target: "closed", guard: "shouldBeClosed" },
	{ target: "loading", guard: "shouldBeLoading" },
	{ target: "discovering", guard: "shouldBeDiscovering" },
	{ target: "reconciling", guard: "shouldBeReconciling" },
	{ target: "active", guard: "shouldBeActive" },
];

function factState(self: FolderStatePath): StateNode<FolderStatePath> {
	return { on: FACT_EVENTS(self), always: CASCADE };
}

export const FOLDER_MACHINE: MachineDefinition<FolderStatePath> = {
	loading: factState("loading"),
	discovering: factState("discovering"),
	reconciling: factState("reconciling"),
	active: factState("active"),
	// Closed is terminal: facts stay recordable (they are monotone and the
	// cascade never leaves closed), waiters were already released.
	closed: factState("closed"),
};
