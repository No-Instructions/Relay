import { normalizeNoteText } from "../../diskText";
import type { MergeHSM } from "../MergeHSM";
import type { DiskContent } from "../types";

interface ReloadView {
	file: object | null;
	lastSavedData?: string | null;
	saving?: boolean;
	saveAgain?: boolean;
	__relayLoading?: "initial" | "reload" | false | null;
	getViewData?(): string;
	save?(): unknown;
	setData(contents: string, clear: boolean): void;
}

interface ReloadHold {
	request: object;
	saving: boolean | undefined;
}

const pendingReloads = new WeakMap<ReloadView, ReloadHold>();

/** Native onModify must keep observing disk while Relay holds native saves. */
export function isHoldingActiveDiskReload(view: ReloadView): boolean {
	return pendingReloads.has(view);
}

/**
 * Reload an active note from raw disk bytes, before the host can patch
 * unsaved typing onto them. The native saving flag also blocks autosave
 * functions bound by the host before Relay installed its view hooks.
 * Null delegates states without a supported writable view to the host.
 */
export function reloadActiveNote(
	view: ReloadView,
	file: object,
	hsm: MergeHSM,
	readDisk: () => Promise<DiskContent>,
): Promise<void> | null {
	const canReload = () => {
		if (view.file !== file || hsm.isDestroyed() || hsm.isReadMode() || hsm.hasFork()) return false;
		if (hsm.statePath === "active.tracking") return true;
		if (!hsm.statePath.startsWith("active.conflict.")) return false;
		// A sibling may observe the same modify event after another view
		// opened the conflict. Its unsaved text is retained in "ours".
		// Do not replace fresh typing made on the displayed file side.
		const text = view.getViewData?.();
		return typeof text === "string" &&
			(text === view.lastSavedData || text === hsm.getConflictData()?.ours);
	};
	if (!canReload()) return null;
	const previousHold = pendingReloads.get(view);
	// An actual host write already in flight owns this flag. Acquiring it
	// here would make our finally clear the host's write protection.
	if (!previousHold && view.saving) return null;
	const request = {};
	const hold = previousHold ?? { request, saving: view.saving };
	hold.request = request;
	pendingReloads.set(view, hold);
	view.saving = true;
	const ownsRequest = () => pendingReloads.get(view) === hold && hold.request === request;
	const isCurrent = () => ownsRequest() && canReload();

	return (async () => {
		let displayed = false;
		try {
			while (isCurrent()) {
				const saved = view.lastSavedData;
				const disk = await readDisk();
				if (!isCurrent()) return;
				// A native save or another accepted load advanced this view's
				// ancestor while the read was pending. Read again against that
				// ancestor; pairing the stale bytes with it could undo the save.
				if (view.lastSavedData !== saved) continue;
				const base = typeof saved === "string" ? normalizeNoteText(saved) : null;
				view.lastSavedData = disk.content;
				if (hsm.statePath.startsWith("active.conflict.")) {
					hsm.send({ type: "DISK_CHANGED", contents: disk.content, hash: disk.hash, mtime: disk.mtime });
				}
				hsm.send({
					type: "OBSIDIAN_SET_VIEW_DATA", data: disk.content,
					clear: false, diskReload: true, reload: { base, disk },
				});
				if (view.file !== file || hsm.isDestroyed() || !ownsRequest()) return;
				// Conflict UI uses the file as the displayed side, retaining
				// unsaved CRDT text as "ours". The unchanged file display also
				// keeps an already-scheduled native save from overwriting it.
				const contents = hsm.statePath === "active.tracking"
					? hsm.getLocalDoc()?.getText("contents").toString() ?? disk.content
					: disk.content;
				const loading = view.__relayLoading;
				view.__relayLoading = "reload";
				try {
					view.setData(contents, false);
				} finally {
					view.__relayLoading = loading;
				}
				displayed = true;
				return;
			}
		} finally {
			if (ownsRequest()) {
				pendingReloads.delete(view);
				view.saving = hold.saving;
				// Native save sets saveAgain when it encounters our hold. Replay
				// only after the view carries the accepted text. Failed reads,
				// demotion, file reuse, and teardown must not replay stale typing.
				if (displayed && view.file === file && !hsm.isDestroyed() && view.saveAgain) {
					await view.save?.();
				}
			}
		}
	})();
}
