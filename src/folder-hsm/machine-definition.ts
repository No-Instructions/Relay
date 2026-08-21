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
 * A folder with no persisted membership has no boot snapshot to read, so
 * it stays `loading` until the server's first view stands in for one —
 * that such a folder must connect while still loading is why `mayConnect`
 * depends on `replayComplete` rather than on the state.
 */
export function folderStateOf(facts: FolderFacts): FolderStatePath {
	if (facts.closed) return "closed";
	if (!facts.replayComplete) return "loading";
	if (!facts.hasPersistedMembership && !facts.providerSynced) {
		return "loading";
	}
	if (!(facts.diskScanned && facts.providerSynced)) return "discovering";
	if (!facts.initialReconcileComplete) return "reconciling";
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
	INITIAL_RECONCILE_COMPLETE: {
		target: self,
		actions: ["recordInitialReconcileComplete"],
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
