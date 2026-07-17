import * as Y from "yjs";
import type { Role } from "./Relay";
import { flags } from "./flagManager";
import { restoreTextAtSnapshot } from "./merge-hsm/snapshots";
import type { Fork } from "./merge-hsm/types";

/** Role sent to the server for a folder grant under the current feature flag. */
export function effectiveFolderGrantRole(role: Role): Role {
	return flags().enableReadOnlyPermissions ? role : "Member";
}

export function effectiveRoleChange(role: Role): Role {
	return !flags().enableReadOnlyPermissions && role === "Reader" ? "Member" : role;
}

export function filterRolesForReadOnlyFeature<T extends { name: Role }>(
	roles: readonly T[],
): T[] {
	return roles.filter(
		(role) => flags().enableReadOnlyPermissions || role.name !== "Reader",
	);
}

/** Whether an HSM state represents a flag-enabled live Reader session. */
export function isReadingAccessState(statePath: string | undefined): boolean {
	return (
		flags().enableReadOnlyPermissions &&
		(statePath === "active.reading" || statePath === "active.reading.repairing")
	);
}

/**
 * Restore the preserved side of a demotion fork from its own Yjs snapshot.
 * New forks always carry this snapshot; the localDoc fallback keeps older
 * persisted forks reviewable without making current UI depend on mutable text.
 */
export function preservedForkText(
	localDoc: Y.Doc | null,
	fork: Fork | null | undefined,
): string | null {
	if (!localDoc || !fork) return null;
	if (!fork.localSnapshot) {
		return localDoc.getText("contents").toString();
	}

	return restoreTextAtSnapshot(
		localDoc,
		{ snapshot: fork.localSnapshot },
		"contents",
	);
}
