/**
 * GatedDeletionController — the decision queue behind the gated-deletion
 * surface (specs/surfacing gated deletions.md).
 *
 * The delete collector in the folder doc bridge holds an anomalous deletion
 * burst until a human replicates it (send) or discards it (restore). This
 * controller turns each gated folder into one modal decision: it queues
 * folders so their modals never merge, keeps a burst gated when its modal is
 * dismissed, closes the surface when a burst empties on its own, and refuses
 * a resolution while the folder is disconnected. It holds no Obsidian
 * references — the modal and the disconnect notice arrive as injected
 * callbacks — so the queue logic is exercised directly in tests.
 */

/** A gated folder as the controller needs to see it. */
export interface GatedFolderView {
	/** Stable identity for queue dedup (the folder guid). */
	readonly key: string;
	/** Folder name for the modal heading. */
	readonly name: string;
	/** Whether the collector is still awaiting a decision. */
	isGated(): boolean;
	/** Whether the folder is connected and can act on a resolution. */
	isConnected(): boolean;
	/** Held paths in the live burst, deduped and display-ready. */
	heldPaths(): string[];
	/** Replicate the burst to every device and member. */
	send(): void;
	/** Discard the burst and re-materialize the files from server truth. */
	restore(): void;
	/** Fires whenever the folder's gate state or burst contents change. */
	subscribe(listener: () => void): () => void;
}

/** The choices the modal reports back to the controller. */
export interface DecisionModalActions {
	/** Replicate the burst everywhere. */
	deleteEverywhere(): void;
	/** Discard the burst and restore the files. */
	restoreFiles(): void;
	/** Dismissed without a decision (Escape / click-away). */
	dismiss(): void;
}

/** The handle the controller keeps on an open modal. */
export interface DecisionModalHandle {
	/** Re-render for the current burst — the path list changed. */
	refresh(): void;
	/** Close the modal programmatically, without a dismissal callback. */
	close(): void;
}

export interface GatedDeletionControllerDeps {
	/** Open the decision modal for a folder; return a handle to drive it. */
	openModal(
		view: GatedFolderView,
		actions: DecisionModalActions,
	): DecisionModalHandle;
	/** A resolution was attempted while the folder was disconnected. */
	notifyDisconnected(view: GatedFolderView): void;
}

export class GatedDeletionController {
	/** Folders awaiting a decision; index 0 is the one currently shown. */
	private queue: GatedFolderView[] = [];
	/** Live-update subscriptions, keyed by folder. */
	private subs = new Map<string, () => void>();
	private activeKey: string | null = null;
	private activeHandle: DecisionModalHandle | null = null;
	private destroyed = false;

	constructor(private readonly deps: GatedDeletionControllerDeps) {}

	/**
	 * A folder entered (or was rehydrated into) the gated phase. Queues a
	 * decision for it and opens the modal when nothing else is shown. A
	 * folder already queued or being shown is ignored, so a repeated signal
	 * never stacks duplicate modals. Reopening from the navigation
	 * affordance calls the same entry point.
	 */
	present(view: GatedFolderView): void {
		if (this.destroyed || !view.isGated()) return;
		if (this.queue.some((v) => v.key === view.key)) return;
		this.queue.push(view);
		if (!this.subs.has(view.key)) {
			this.subs.set(view.key, view.subscribe(() => this.onViewChanged(view)));
		}
		this.pump();
	}

	/** Keys of folders with a modal shown or queued (shown first). */
	get pendingKeys(): string[] {
		return this.queue.map((v) => v.key);
	}

	/** Whether a decision modal is currently open. */
	get hasActiveModal(): boolean {
		return this.activeHandle !== null;
	}

	destroy(): void {
		this.destroyed = true;
		for (const off of this.subs.values()) {
			try {
				off();
			} catch {
				/* subscription source torn down first */
			}
		}
		this.subs.clear();
		this.queue = [];
		const handle = this.activeHandle;
		this.activeHandle = null;
		this.activeKey = null;
		handle?.close();
	}

	/** Open the next queued modal if the surface is idle. */
	private pump(): void {
		if (this.destroyed || this.activeHandle) return;
		// A folder whose burst resolved while queued never gets a modal.
		while (this.queue.length > 0 && !this.queue[0].isGated()) {
			this.drop(this.queue[0].key);
		}
		const next = this.queue[0];
		if (!next) return;
		this.activeKey = next.key;
		this.activeHandle = this.deps.openModal(next, {
			deleteEverywhere: () => this.resolve(next, "send"),
			restoreFiles: () => this.resolve(next, "restore"),
			dismiss: () => this.onDismiss(next),
		});
	}

	private resolve(view: GatedFolderView, kind: "send" | "restore"): void {
		if (this.destroyed || this.activeKey !== view.key) return;
		if (!view.isConnected()) {
			// A held burst can only resolve against server truth. Keep it
			// gated and the modal open rather than dropping the decision.
			this.deps.notifyDisconnected(view);
			return;
		}
		if (kind === "send") {
			view.send();
		} else {
			view.restore();
		}
		this.closeActive();
	}

	private onDismiss(view: GatedFolderView): void {
		if (this.activeKey !== view.key) return;
		// Dismissal chooses neither: the burst stays gated and reachable via
		// its navigation affordance. Retire the modal and show the next
		// queued folder. The modal already closed itself.
		this.activeKey = null;
		this.activeHandle = null;
		this.drop(view.key);
		this.pump();
	}

	private onViewChanged(view: GatedFolderView): void {
		if (this.destroyed) return;
		const live = view.isGated() && view.heldPaths().length > 0;
		if (!live) {
			// The burst emptied (files re-created) or resolved elsewhere.
			if (this.activeKey === view.key) {
				this.closeActive();
			} else {
				this.drop(view.key);
			}
			return;
		}
		if (this.activeKey === view.key) {
			this.activeHandle?.refresh();
		}
	}

	/** Close the shown modal programmatically and advance the queue. */
	private closeActive(): void {
		const handle = this.activeHandle;
		const key = this.activeKey;
		this.activeHandle = null;
		this.activeKey = null;
		if (key) this.drop(key);
		handle?.close();
		this.pump();
	}

	private drop(key: string): void {
		this.queue = this.queue.filter((v) => v.key !== key);
		const off = this.subs.get(key);
		if (off) {
			this.subs.delete(key);
			off();
		}
	}
}
