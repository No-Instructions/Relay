import type { Relay, RemoteSharedFolder } from "../Relay";
import type { SharedFolder, SharedFolders } from "../SharedFolder";
import type { RelayManager } from "../RelayManager";

export interface SettingsTarget {
	currentRelay?: Relay;
	sharedFolder?: SharedFolder;
	remoteFolder?: RemoteSharedFolder;
}

type Relays = Pick<RelayManager["relays"], "get">;
type RemoteFolders = Pick<RelayManager["remoteFolders"], "get">;
type Locals = Pick<SharedFolders, "find">;

/**
 * Resolve saved navigation against live records.
 *
 * The result is a fixed point: resolving it again yields the same page, so the
 * settings view can re-resolve on every record update without drifting. A
 * saved local folder follows its own remote binding. A remote folder page keeps
 * its remote while that remote is live, and carries the local folder only when
 * that folder is bound to this very remote; a detached copy or a copy bound to
 * another server's folder leaves the page remote-only. Once the remote or its
 * relay is gone, the page falls back to the local copy of the same guid, unless
 * that copy belongs to a different live remote.
 */
export function resolveSettingsTarget(
	target: SettingsTarget,
	relays: Relays,
	remoteFolders: RemoteFolders,
	sharedFolders: Locals,
): SettingsTarget | undefined {
	const saved = target.sharedFolder ?? target.remoteFolder;
	if (saved) {
		const local = sharedFolders.find((candidate) => candidate.guid === saved.guid);
		if (target.sharedFolder && local) {
			const live = liveRemote(local.remote, relays, remoteFolders);
			return live
				? { sharedFolder: local, remoteFolder: live.remote, currentRelay: live.relay }
				: { sharedFolder: local };
		}
		const live = liveRemote(target.remoteFolder, relays, remoteFolders);
		if (live) {
			const bound = local?.remote?.id === live.remote.id ? local : undefined;
			return { sharedFolder: bound, remoteFolder: live.remote, currentRelay: live.relay };
		}
		const boundElsewhere =
			local?.remote && target.remoteFolder && local.remote.id !== target.remoteFolder.id;
		return local && !boundElsewhere ? { sharedFolder: local } : undefined;
	}
	if (target.currentRelay) {
		const relay = relays.get(target.currentRelay.id);
		return relay ? { currentRelay: relay } : undefined;
	}
	return {};
}

function liveRemote(
	saved: RemoteSharedFolder | undefined,
	relays: Relays,
	remoteFolders: RemoteFolders,
): { remote: RemoteSharedFolder; relay: Relay } | undefined {
	const remote = saved && remoteFolders.get(saved.id);
	const relay = remote && relays.get(remote.relayId);
	return remote && relay ? { remote, relay } : undefined;
}

/** Whether two targets show the same page. */
export function sameSettingsTarget(a: SettingsTarget, b: SettingsTarget): boolean {
	return (
		a.currentRelay === b.currentRelay &&
		a.sharedFolder === b.sharedFolder &&
		a.remoteFolder === b.remoteFolder
	);
}

/**
 * Pop saved views until one resolves to a page other than the current one.
 * Views whose records are gone, and views that resolve to the page already on
 * screen, are dropped. Returns undefined once the history is exhausted.
 */
export function popSettingsHistory<View extends SettingsTarget>(
	history: View[],
	current: SettingsTarget,
	relays: Relays,
	remoteFolders: RemoteFolders,
	sharedFolders: Locals,
): { view: View; target: SettingsTarget } | undefined {
	let view: View | undefined;
	while ((view = history.pop())) {
		const target = resolveSettingsTarget(view, relays, remoteFolders, sharedFolders);
		if (target && !sameSettingsTarget(target, current)) {
			return { view, target };
		}
	}
	return undefined;
}
