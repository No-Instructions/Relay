import { MarkdownView, type App } from "obsidian";
import type { HsmStateSnapshot, RelayDebugAPI } from "../RelayDebugAPI";
import type { MergeEffect, MergeState } from "../merge-hsm/types";
import type { TimeProvider } from "../TimeProvider";

/** A lane is rendered as stuck once it waits this long. */
const STUCK_MS = 5000;
/** Completed writes stay visible in the panel this long. */
const COMPLETED_WRITE_TTL_MS = 30_000;
const TICK_MS = 1000;
/** Deep store snapshot refresh cadence, in ticks. */
const SNAPSHOT_EVERY_TICKS = 3;

export interface NoteStateSectionContext {
	app: App;
	timeProvider: TimeProvider;
	debugAPI: RelayDebugAPI;
}

/**
 * One WRITE_DISK effect observed on the HSM's public effects observable.
 * Settled when the HSM's disk metadata is next seen to change — the bytes
 * hit disk AND the HSM learned about it (SAVE_COMPLETE in active mode, the
 * disk-changed lane in idle mode). A row that never settles is exactly the
 * "content stuck getting written to disk" failure this panel exists for.
 */
interface ObservedWrite {
	startedAt: number;
	size: number;
	completedAt: number | null;
}

interface Verdict {
	label: string;
	cls: "ok" | "warn" | "bad" | "muted";
}

interface StoresCheck {
	label: string;
	cls: "ok" | "warn" | "bad";
}

type LookupResult =
	| { status: "ok"; doc: any; hsm: any; guid: string; folder: any }
	| { status: "unshared" }
	| { status: "no-doc" };

/**
 * Compact per-note merge-state strip for the sync-status sidebar, gated by
 * the note state inspector feature flag. Follows the active note and shows
 * the HSM state path, the disk lanes (HSM writes out, Obsidian's native
 * editor save, disk ingestion in), and a one-line store convergence check.
 *
 * Passive observer: it reads engine state (statePath, disk metadata,
 * pendingDiskContents, the HsmStateSnapshot) and watches the HSM's public
 * `effects`/`stateChanges` observables, timestamping what it sees. It
 * computes nothing beyond string comparisons — no hashing — and writes
 * nothing back into the engine, so write/ingest ages reflect activity
 * observed since the strip bound to the note.
 *
 * The component owns a root element that survives sidebar re-renders:
 * `attach()` re-parents it while subscriptions persist.
 */
export class NoteStateSection {
	readonly el: HTMLElement;

	private boundPath: string | null = null;
	private hsm: any = null;
	private hsmUnsubscribers: (() => void)[] = [];
	private lastRenderedStatePath: string | null = null;

	private writes: ObservedWrite[] = [];
	/** Last observed disk identity (`hash·mtime`), for settling writes. */
	private lastDiskKey: string | null = null;
	private ingestObservedAt: number | null = null;

	private snapshot: HsmStateSnapshot | null = null;
	private snapshotAt: number | null = null;
	private snapshotInFlight = false;
	private tickCount = 0;
	private timer: number;
	private destroyed = false;

	constructor(private context: NoteStateSectionContext) {
		this.el = createDiv({ cls: "system3-note-state" });
		this.timer = context.timeProvider.setInterval(() => this.tick(), TICK_MS);
	}

	attach(parent: HTMLElement): void {
		parent.appendChild(this.el);
		this.render();
	}

	destroy(): void {
		this.destroyed = true;
		this.context.timeProvider.clearInterval(this.timer);
		this.unsubscribeHsm();
		this.el.remove();
	}

	// ===========================================================================
	// Binding
	// ===========================================================================

	bindToFile(path: string | null): void {
		// A null path means no file is active (e.g. the note was just closed).
		// Keep the last binding: idle-mode lane activity right after closing a
		// note is exactly what this panel exists to observe.
		if (this.destroyed || path === null || path === this.boundPath) return;
		this.boundPath = path;
		this.resetDocumentState();
		this.syncHsmBinding();
		void this.refreshSnapshot();
		this.render();
	}

	private resetDocumentState(): void {
		this.unsubscribeHsm();
		this.writes = [];
		this.lastDiskKey = null;
		this.ingestObservedAt = null;
		this.snapshot = null;
		this.snapshotAt = null;
	}

	private lookup(): LookupResult {
		if (!this.boundPath) return { status: "unshared" };
		try {
			const result = this.context.debugAPI.lookupDocument("/" + this.boundPath);
			if (!result) return { status: "no-doc" };
			return { status: "ok", ...result };
		} catch {
			// lookupDocument throws for paths outside every shared folder.
			return { status: "unshared" };
		}
	}

	/**
	 * Keep the effect/state subscriptions attached to the current HSM
	 * instance. Documents hibernate and reload, so the HSM behind a path can
	 * be replaced between ticks; resubscribe whenever the identity changes.
	 */
	private syncHsmBinding(): void {
		const lookup = this.lookup();
		const hsm = lookup.status === "ok" ? lookup.hsm : null;
		if (hsm === this.hsm) return;

		this.unsubscribeHsm();
		this.hsm = hsm;
		if (!hsm) return;

		this.lastDiskKey = this.diskKey(hsm.state);
		this.hsmUnsubscribers.push(
			hsm.effects.subscribe((effect: MergeEffect) => this.onEffect(effect)),
			hsm.stateChanges.subscribe((state: MergeState) => this.onStateChange(state)),
		);
	}

	private unsubscribeHsm(): void {
		this.hsmUnsubscribers.forEach((unsubscribe) => unsubscribe());
		this.hsmUnsubscribers = [];
		this.hsm = null;
	}

	// ===========================================================================
	// HSM observation
	// ===========================================================================

	private diskKey(state: MergeState | undefined): string | null {
		const disk = state?.disk;
		return disk ? `${disk.hash}·${disk.mtime}` : null;
	}

	private onEffect(effect: MergeEffect): void {
		if (effect.type !== "WRITE_DISK") return;
		this.writes.push({
			startedAt: this.context.timeProvider.now(),
			size: effect.contents.length,
			completedAt: null,
		});
		this.render();
	}

	private onStateChange(state: MergeState): void {
		// Any change of the HSM's disk metadata after a write was observed
		// means the write landed and the HSM was told about it.
		const key = this.diskKey(state);
		if (key !== this.lastDiskKey) {
			this.lastDiskKey = key;
			if (key !== null) {
				const now = this.context.timeProvider.now();
				for (const write of this.writes) {
					if (write.completedAt === null) write.completedAt = now;
				}
			}
		}
		this.trackIngestLane();
		if (state.statePath !== this.lastRenderedStatePath) this.render();
	}

	private trackIngestLane(): void {
		const pending = this.hsm ? (this.hsm.pendingDiskContents ?? null) !== null : false;
		if (pending && this.ingestObservedAt === null) {
			this.ingestObservedAt = this.context.timeProvider.now();
		} else if (!pending) {
			this.ingestObservedAt = null;
		}
	}

	private pruneWrites(): void {
		const now = this.context.timeProvider.now();
		this.writes = this.writes.filter(
			(w) => w.completedAt === null || now - w.completedAt < COMPLETED_WRITE_TTL_MS,
		);
	}

	// ===========================================================================
	// Polling
	// ===========================================================================

	private tick(): void {
		if (this.destroyed || !this.el.isConnected || !this.el.isShown()) return;
		this.tickCount++;

		// Follow the active file across renames, which do not fire file-open.
		const activeFile = this.context.app.workspace.getActiveFile();
		if (activeFile && activeFile.path !== this.boundPath) {
			this.bindToFile(activeFile.path);
			return;
		}

		this.syncHsmBinding();
		this.trackIngestLane();
		this.pruneWrites();
		if (this.tickCount % SNAPSHOT_EVERY_TICKS === 0) {
			void this.refreshSnapshot();
		}
		this.render();
	}

	private async refreshSnapshot(): Promise<void> {
		if (this.snapshotInFlight || !this.boundPath) return;
		if (this.lookup().status !== "ok") return;
		this.snapshotInFlight = true;
		const path = this.boundPath;
		try {
			const snapshot = await this.context.debugAPI.getHsmStateSnapshot("/" + path);
			if (this.boundPath !== path) return;
			this.snapshot = snapshot;
			this.snapshotAt = this.context.timeProvider.now();
		} catch {
			if (this.boundPath !== path) return;
			this.snapshot = null;
			this.snapshotAt = null;
		} finally {
			this.snapshotInFlight = false;
		}
	}

	// ===========================================================================
	// Derived state
	// ===========================================================================

	private localDocText(): string | null {
		const text = this.hsm?.localDoc?.getText?.("contents");
		return text ? text.toString() : null;
	}

	private editorText(): string | null {
		if (!this.boundPath) return null;
		let content: string | null = null;
		this.context.app.workspace.iterateAllLeaves((leaf) => {
			if (content !== null) return;
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === this.boundPath) {
				content = view.editor.getValue();
			}
		});
		return content;
	}

	/**
	 * Editor text diverges from disk — Obsidian's debounced save has not
	 * flushed yet. Compared against the snapshot's disk content (a plain
	 * string compare), so up to one snapshot interval stale. Null when not
	 * comparable, or when disk changed after the snapshot was taken (the
	 * comparison would be against outdated disk content).
	 */
	private editorUnsaved(editorText: string | null): boolean | null {
		if (editorText === null) return null;
		const diskContent = this.snapshot?.diskContent ?? null;
		if (diskContent === null || this.snapshotAt === null) return null;
		const diskMtime: number | null = this.hsm?.state?.disk?.mtime ?? null;
		if (diskMtime !== null && diskMtime > this.snapshotAt) return null;
		return editorText !== diskContent;
	}

	private pendingWrites(): ObservedWrite[] {
		return this.writes.filter((w) => w.completedAt === null);
	}

	/**
	 * The store convergence chain the e2e fixtures assert before calling a
	 * note "synced and persisted across all stores", reduced to the first
	 * failing pair. Null when there is not enough data to judge.
	 */
	private storesCheck(
		editorText: string | null,
		localText: string | null,
	): StoresCheck | null {
		if (editorText !== null && localText !== null && editorText !== localText) {
			return { label: "editor ≠ localDoc", cls: "bad" };
		}
		const snapshot = this.snapshot;
		if (!snapshot) return null;
		if (snapshot.diskContent === null) return { label: "disk missing", cls: "bad" };
		if (!snapshot.diskMatchesIdb) {
			// Expected while Obsidian's debounced save is outstanding.
			if (this.editorUnsaved(editorText)) {
				return { label: "disk behind editor", cls: "warn" };
			}
			return { label: "disk ≠ localDoc", cls: "bad" };
		}
		if (snapshot.hasLCA && !snapshot.idbMatchesLca) {
			return { label: "localDoc ≠ lca", cls: "bad" };
		}
		if (snapshot.persistedLcaHash && !snapshot.idbMatchesPersistedLca) {
			return { label: "localDoc ≠ persisted lca", cls: "bad" };
		}
		if (snapshot.stateVectorsEqual === false) return { label: "SV mismatch", cls: "bad" };
		return { label: "converged", cls: "ok" };
	}

	private verdict(lookup: LookupResult, stores: StoresCheck | null): Verdict {
		if (lookup.status === "unshared") return { label: "not shared", cls: "muted" };
		if (lookup.status === "no-doc") return { label: "no HSM", cls: "muted" };

		const now = this.context.timeProvider.now();
		const statePath: string = this.hsm?.state?.statePath ?? "unknown";

		if (this.snapshot?.hasConflict || statePath.includes("conflict")) {
			return { label: "conflict", cls: "bad" };
		}
		const pending = this.pendingWrites();
		if (pending.length > 0) {
			if (pending.some((w) => now - w.startedAt > STUCK_MS)) {
				return { label: "write stuck", cls: "bad" };
			}
			return { label: "writing…", cls: "warn" };
		}
		if (this.ingestObservedAt !== null) {
			if (now - this.ingestObservedAt > STUCK_MS) {
				return { label: "ingest stuck", cls: "bad" };
			}
			return { label: "ingesting…", cls: "warn" };
		}
		const gate = this.snapshot?.syncGate;
		if (gate && (gate.pendingInbound > 0 || gate.pendingOutbound > 0)) {
			return { label: "syncing", cls: "warn" };
		}
		if (stores && stores.cls === "bad") return { label: stores.label, cls: "warn" };
		if (statePath.startsWith("active.")) return { label: "tracking", cls: "ok" };
		if (statePath === "idle.synced") return { label: "synced", cls: "ok" };
		return { label: statePath, cls: "warn" };
	}

	// ===========================================================================
	// Rendering
	// ===========================================================================

	private fmtAge(ms: number): string {
		if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.round(ms / 60_000)}m`;
	}

	private row(
		label: string,
		value: string,
		cls?: "ok" | "warn" | "bad" | "muted",
		mono = false,
	): void {
		const row = this.el.createDiv({ cls: "system3-note-state-row" });
		row.createSpan({ cls: "system3-note-state-label", text: label });
		row.createSpan({
			cls:
				"system3-note-state-value" +
				(cls ? ` system3-note-state-${cls}` : "") +
				(mono ? " system3-note-state-mono" : ""),
			text: value,
		});
	}

	private render(): void {
		if (this.destroyed) return;
		this.el.empty();

		const lookup = this.lookup();
		const editorText = this.editorText();
		const localText = this.localDocText();
		const stores = this.storesCheck(editorText, localText);
		const verdict = this.verdict(lookup, stores);
		const statePath: string = this.hsm?.state?.statePath ?? "unknown";
		this.lastRenderedStatePath = statePath;

		const header = this.el.createDiv({ cls: "system3-note-state-header" });
		header.createDiv({ cls: "system3-note-state-title", text: "Note state" });
		header.createDiv({
			cls: `system3-note-state-pill system3-note-state-${verdict.cls}`,
			text: verdict.label,
		});

		const name = this.boundPath?.split("/").pop() ?? "(no note)";
		const closedSuffix =
			lookup.status === "ok" && editorText === null ? " · no editor" : "";
		this.row("note", name + closedSuffix, "muted");

		if (lookup.status !== "ok") {
			this.row(
				"state",
				lookup.status === "unshared" ? "not in a shared folder" : "no merge HSM",
				"muted",
			);
			return;
		}

		const gate = this.snapshot?.syncGate;
		const gateSuffix =
			gate && (gate.pendingInbound > 0 || gate.pendingOutbound > 0)
				? ` · in ${gate.pendingInbound} out ${gate.pendingOutbound}`
				: "";
		// Idle docs hold no provider connection by design; only flag a missing
		// connection in active mode where one is expected.
		const offlineSuffix =
			statePath.startsWith("active.") && this.hsm?.isOnline === false
				? " · offline"
				: "";
		this.row("state", statePath + gateSuffix + offlineSuffix, undefined, true);

		this.renderHsmWriteRow();
		this.renderObsidianSaveRow(editorText);
		this.renderIngestRow();

		if (stores === null) {
			this.row("stores", "checking…", "muted");
		} else {
			this.row(
				"stores",
				`${stores.cls === "ok" ? "✓" : "✗"} ${stores.label}`,
				stores.cls,
			);
		}
	}

	/** WRITE_DISK effects observed since the strip bound to this note. */
	private renderHsmWriteRow(): void {
		const now = this.context.timeProvider.now();
		const pending = this.pendingWrites();
		if (pending.length > 0) {
			const oldest = Math.max(...pending.map((w) => now - w.startedAt));
			const label =
				pending.length === 1
					? `writing… ${this.fmtAge(oldest)} · ${pending[0].size} ch`
					: `${pending.length} in flight · oldest ${this.fmtAge(oldest)}`;
			this.row("hsm write", label, oldest > STUCK_MS ? "bad" : "warn");
			return;
		}
		const completed = this.writes.filter((w) => w.completedAt !== null);
		const last = completed[completed.length - 1];
		if (last) {
			this.row(
				"hsm write",
				`✓ took ${this.fmtAge((last.completedAt ?? 0) - last.startedAt)} · ${this.fmtAge(now - (last.completedAt ?? 0))} ago`,
				"ok",
			);
			return;
		}
		this.row("hsm write", "none observed", "muted");
	}

	/** Obsidian's native editor save (buffer → disk). Pending is a plain
	 * string compare of editor text against the snapshot's disk content;
	 * the flush age reads the HSM's disk mtime. */
	private renderObsidianSaveRow(editorText: string | null): void {
		if (editorText === null) return;
		const unsaved = this.editorUnsaved(editorText);
		if (unsaved === null) {
			this.row("obsidian save", "–", "muted");
			return;
		}
		const diskMtime: number | null = this.hsm?.state?.disk?.mtime ?? null;
		const flushAge =
			diskMtime !== null
				? this.fmtAge(this.context.timeProvider.now() - diskMtime)
				: "?";
		if (unsaved) {
			this.row("obsidian save", `unsaved · last flush ${flushAge} ago`, "warn");
		} else {
			this.row("obsidian save", `✓ flushed ${flushAge} ago`, "ok");
		}
	}

	private renderIngestRow(): void {
		if (this.ingestObservedAt !== null) {
			const age = this.context.timeProvider.now() - this.ingestObservedAt;
			this.row("disk ingest", `waiting ${this.fmtAge(age)}`, age > STUCK_MS ? "bad" : "warn");
		} else {
			this.row("disk ingest", "none", "muted");
		}
	}
}
