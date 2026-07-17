import { diff_match_patch } from "diff-match-patch";
import { MarkdownView, type App, type Editor, type EventRef } from "obsidian";
import type { HsmStateSnapshot, RelayDebugAPI } from "../RelayDebugAPI";
import { generateHash } from "../hashing";
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
 * It settles only against the executor's confirmed hash/mtime identity.
 */
interface ObservedWrite {
	startedAt: number;
	size: number;
	hash: string | null;
	confirmation: { hash: string; mtime: number } | null;
	completedAt: number | null;
}

interface WriteConfirmation {
	identity: { hash: string; mtime: number };
	observedAt: number;
	consumed: boolean;
}

interface IngestEvidence {
	startedAt: number;
	settledAt: number | null;
	preContent: string;
	content: string;
	preHash: string | null;
	contentHash: string | null;
	addedSpans: string[];
	pendingCleared: boolean;
	/** Settled by measured convergence rather than by carrying the lane's
	 * content identity: the row reads "none", but the evidence stays live
	 * for revert detection like any other completed ingest. */
	clearedByConvergence: boolean;
}

interface EditorLocalMismatch {
	editorText: string;
	localText: string;
	observedAt: number;
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
 * hashes only newly observed lane payloads and writes nothing back into the
 * engine, so write/ingest ages reflect activity observed since the strip
 * bound to the note.
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
	private writeConfirmations: WriteConfirmation[] = [];
	private lastWriteConfirmationRef: unknown = null;
	private activeIngest: IngestEvidence | null = null;
	private completedIngest: IngestEvidence | null = null;
	private revertedIngest: IngestEvidence | null = null;
	private observedPendingContent: string | null = null;
	private lastEditorText: string | null = null;
	private lastEditorChangeAt: number | null = null;
	private lastLocalText: string | null = null;
	private lastLocalChangeAt: number | null = null;
	private editorLocalMismatch: EditorLocalMismatch | null = null;
	private pendingMachineEditorTexts: string[] = [];
	/** Most recent point at which editor, localDoc, and disk agreed. */
	private lastAgreementAt: number | null = null;
	/** Bad-class stores label aging toward the verdict's persistence
	 * threshold, keyed to the label so a just-flipped label is never
	 * presented as persistent. Null while ok, warn, or unmeasured. */
	private storesMismatch: { label: string; since: number } | null = null;
	private editorChangeRef: EventRef;

	private snapshot: HsmStateSnapshot | null = null;
	private snapshotAt: number | null = null;
	/** Adapter-observed mtime paired with the snapshot's disk read. */
	private snapshotDiskMtime: number | null = null;
	/** Latest cheap adapter stat, independent of the HSM's disk belief. */
	private diskStatMtime: number | null = null;
	private diskStatAt: number | null = null;
	private diskStatInFlight = false;
	private diskProbeSequence = 0;
	private appliedDiskProbeSequence = 0;
	private snapshotInFlight = false;
	private tickCount = 0;
	private timer: number;
	private destroyed = false;

	constructor(private context: NoteStateSectionContext) {
		this.el = createDiv({ cls: "system3-note-state" });
		this.timer = context.timeProvider.setInterval(() => this.tick(), TICK_MS);
		this.editorChangeRef = context.app.workspace.on(
			"editor-change",
			(editor, info) => {
				if (info.file?.path !== this.boundPath) return;
				this.recordEditorChange(editor);
				this.render();
			},
		);
	}

	attach(parent: HTMLElement): void {
		parent.appendChild(this.el);
		this.render();
	}

	destroy(): void {
		this.destroyed = true;
		this.context.timeProvider.clearInterval(this.timer);
		this.context.app.workspace.offref(this.editorChangeRef);
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
		this.writeConfirmations = [];
		this.lastWriteConfirmationRef = null;
		this.activeIngest = null;
		this.completedIngest = null;
		this.revertedIngest = null;
		this.observedPendingContent = null;
		this.lastEditorText = null;
		this.lastEditorChangeAt = null;
		this.lastLocalText = null;
		this.lastLocalChangeAt = null;
		this.editorLocalMismatch = null;
		this.pendingMachineEditorTexts = [];
		this.lastAgreementAt = null;
		this.storesMismatch = null;
		this.snapshot = null;
		this.snapshotAt = null;
		this.snapshotDiskMtime = null;
		this.diskStatMtime = null;
		this.diskStatAt = null;
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

		this.lastWriteConfirmationRef =
			lookup.status === "ok" ? (lookup.doc?._lastEngineWrite ?? null) : null;
		this.hsmUnsubscribers.push(
			hsm.effects.subscribe((effect: MergeEffect) => this.onEffect(effect)),
			hsm.stateChanges.subscribe((state: MergeState) =>
				this.onStateChange(state),
			),
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

	private onEffect(effect: MergeEffect): void {
		if (effect.type === "DISPATCH_CM6") {
			const editorText = this.editorText();
			if (editorText !== null) {
				this.rememberMachineEditorText(
					this.applyTextChanges(editorText, effect.changes),
				);
			}
			return;
		}
		if (effect.type === "SET_CM6") {
			this.rememberMachineEditorText(effect.text);
			return;
		}
		if (effect.type !== "WRITE_DISK") return;
		const write: ObservedWrite = {
			startedAt: this.context.timeProvider.now(),
			size: effect.contents.length,
			hash: effect.hash ?? null,
			confirmation: null,
			completedAt: null,
		};
		this.writes.push(write);
		if (write.hash === null) {
			void this.fillWriteHash(write, effect.contents).catch(() => undefined);
		}
		this.render();
	}

	private onStateChange(state: MergeState): void {
		this.observeWriteConfirmation();
		this.trackIngestLane();
		if (state.statePath !== this.lastRenderedStatePath) this.render();
	}

	private async fillWriteHash(
		write: ObservedWrite,
		contents: string,
	): Promise<void> {
		write.hash = await this.hashText(contents);
		this.matchWriteConfirmations();
		this.render();
	}

	/** Observe the executor's confirmation object, never an HSM metadata change. */
	private observeWriteConfirmation(): void {
		const lookup = this.lookup();
		if (lookup.status !== "ok") return;
		const confirmation = lookup.doc?._lastEngineWrite;
		if (!confirmation || confirmation === this.lastWriteConfirmationRef) return;
		this.lastWriteConfirmationRef = confirmation;
		if (
			typeof confirmation.hash !== "string" ||
			typeof confirmation.mtime !== "number"
		) {
			return;
		}
		this.writeConfirmations.push({
			identity: { hash: confirmation.hash, mtime: confirmation.mtime },
			observedAt: this.context.timeProvider.now(),
			consumed: false,
		});
		this.matchWriteConfirmations();
	}

	private matchWriteConfirmations(): void {
		for (const confirmation of this.writeConfirmations) {
			if (confirmation.consumed) continue;
			const write = this.writes.find(
				(candidate) =>
					candidate.completedAt === null &&
					candidate.hash === confirmation.identity.hash &&
					candidate.startedAt <= confirmation.observedAt,
			);
			if (!write) continue;
			confirmation.consumed = true;
			write.confirmation = confirmation.identity;
			write.completedAt = confirmation.observedAt;
		}
	}

	private trackIngestLane(): void {
		const pendingValue = this.hsm?.pendingDiskContents;
		const pending = typeof pendingValue === "string" ? pendingValue : null;
		const localText = this.localDocText();

		if (pending === null) {
			this.observedPendingContent = null;
			if (this.activeIngest) this.activeIngest.pendingCleared = true;
		} else if (this.activeIngest && pending !== this.activeIngest.content) {
			this.activeIngest.pendingCleared = true;
			this.settleActiveIngest(localText);
			this.activeIngest = null;
		}

		if (
			pending !== null &&
			localText !== null &&
			this.activeIngest === null &&
			pending !== this.observedPendingContent
		) {
			this.observedPendingContent = pending;
			this.beginIngest(pending, localText);
		}

		this.settleActiveIngest(localText);
		this.clearConvergedIngest(localText);
		this.detectCompletedIngestRevert(localText);
	}

	/**
	 * A cleared pending buffer with fresh measured store agreement means
	 * the dataflow settled without preserving the lane's content identity —
	 * a normalizing merge, or a deletion folded into later edits. The
	 * stores agree, so no ingest is outstanding: the lane clears rather
	 * than aging a timer on stale evidence. Runs after settleActiveIngest
	 * so same-pass completion and the reverted latch win over a plain
	 * clear; across passes the evidence is retained in the completed slot,
	 * so a revert to the pre-ingest content within the completed-write TTL
	 * still latches, exactly as it does after a completion.
	 */
	private clearConvergedIngest(localText: string | null): void {
		const ingest = this.activeIngest;
		if (!ingest || !ingest.pendingCleared) return;
		if (!this.measuredConvergence(localText)) return;
		ingest.settledAt = this.context.timeProvider.now();
		ingest.clearedByConvergence = true;
		this.activeIngest = null;
		this.completedIngest = ingest;
	}

	/**
	 * Measured agreement between the live localDoc and a disk read that is
	 * stat-paired to the latest adapter mtime — the same belief-free
	 * comparison the stores row trusts, never the HSM's disk metadata.
	 * Fresh evidence only: the stat must be no older than one tick and the
	 * snapshot no older than its refresh cadence. Ticks suspend while the
	 * panel is hidden but state changes keep driving the lane tracker, so
	 * without this bound the pairing guard passes vacuously on frozen
	 * values and live localDoc gets compared against a disk read of
	 * unbounded age. Refusing stale evidence fails conservative: the lane
	 * keeps waiting until the polling loop measures again.
	 */
	private measuredConvergence(localText: string | null): boolean {
		const diskContent = this.snapshot?.diskContent ?? null;
		const now = this.context.timeProvider.now();
		return (
			localText !== null &&
			diskContent !== null &&
			this.diskStatMtime !== null &&
			this.snapshotDiskMtime !== null &&
			this.diskStatMtime === this.snapshotDiskMtime &&
			this.diskStatAt !== null &&
			now - this.diskStatAt <= TICK_MS &&
			this.snapshotAt !== null &&
			now - this.snapshotAt <= SNAPSHOT_EVERY_TICKS * TICK_MS &&
			localText === diskContent
		);
	}

	private beginIngest(content: string, localText: string): void {
		this.completedIngest = null;
		const evidence: IngestEvidence = {
			startedAt: this.context.timeProvider.now(),
			settledAt: null,
			preContent: localText,
			content,
			preHash: this.knownHash(localText),
			contentHash:
				typeof this.hsm?.pendingDiskHash === "string"
					? this.hsm.pendingDiskHash
					: null,
			addedSpans: this.addedSpans(localText, content),
			pendingCleared: false,
			clearedByConvergence: false,
		};
		void this.fillIngestHashes(evidence).catch(() => undefined);

		// A buffer that already equals localDoc is stale bookkeeping, not work.
		if (content === localText) {
			this.completeIngest(evidence);
			return;
		}
		this.activeIngest = evidence;
	}

	private settleActiveIngest(localText: string | null): void {
		const ingest = this.activeIngest;
		if (!ingest || localText === null || !ingest.pendingCleared) return;
		if (this.containsIngestEvidence(ingest, localText)) {
			this.completeIngest(ingest);
			return;
		}
		if (
			localText === ingest.preContent &&
			!this.containsAnyAddedSpan(ingest.addedSpans, localText)
		) {
			this.latchRevertedIngest(ingest);
		}
	}

	private completeIngest(ingest: IngestEvidence): void {
		ingest.settledAt = this.context.timeProvider.now();
		this.activeIngest = null;
		this.completedIngest = ingest;
	}

	private latchRevertedIngest(ingest: IngestEvidence): void {
		ingest.settledAt = this.context.timeProvider.now();
		this.activeIngest = null;
		this.completedIngest = null;
		this.revertedIngest = ingest;
	}

	private detectCompletedIngestRevert(localText: string | null): void {
		const ingest = this.completedIngest;
		if (
			!ingest ||
			this.revertedIngest ||
			localText === null ||
			ingest.preContent === ingest.content
		) {
			return;
		}
		if (
			localText === ingest.preContent &&
			!this.containsAnyAddedSpan(ingest.addedSpans, localText)
		) {
			this.latchRevertedIngest(ingest);
		}
	}

	private addedSpans(before: string, after: string): string[] {
		const dmp = new diff_match_patch();
		const diffs = dmp.diff_main(before, after);
		dmp.diff_cleanupSemantic(diffs);
		return diffs
			.filter(([operation]) => operation === 1)
			.map(([, text]) => text);
	}

	private containsIngestEvidence(
		ingest: IngestEvidence,
		text: string,
	): boolean {
		return (
			text === ingest.content ||
			(ingest.addedSpans.length > 0 &&
				this.containsAllAddedSpans(ingest.addedSpans, text))
		);
	}

	private containsAllAddedSpans(spans: string[], text: string): boolean {
		const required = new Map<string, number>();
		for (const span of spans) required.set(span, (required.get(span) ?? 0) + 1);
		for (const [span, count] of required) {
			let found = 0;
			let from = 0;
			while (found < count) {
				const at = text.indexOf(span, from);
				if (at < 0) return false;
				found++;
				from = at + Math.max(1, span.length);
			}
		}
		return true;
	}

	private containsAnyAddedSpan(spans: string[], text: string): boolean {
		return spans.some((span) => text.includes(span));
	}

	private knownHash(content: string): string | null {
		const lca = this.hsm?._lca;
		if (lca?.contents === content && typeof lca.meta?.hash === "string") {
			return lca.meta.hash;
		}
		return null;
	}

	private async fillIngestHashes(ingest: IngestEvidence): Promise<void> {
		const [preHash, contentHash] = await Promise.all([
			ingest.preHash ?? this.hashText(ingest.preContent),
			ingest.contentHash ?? this.hashText(ingest.content),
		]);
		ingest.preHash = preHash;
		ingest.contentHash = contentHash;
		if (
			this.activeIngest === ingest ||
			this.completedIngest === ingest ||
			this.revertedIngest === ingest
		) {
			this.render();
		}
	}

	private hashText(content: string): Promise<string> {
		return generateHash(new TextEncoder().encode(content).buffer);
	}

	private pruneWrites(): void {
		const now = this.context.timeProvider.now();
		this.writes = this.writes.filter(
			(w) =>
				w.completedAt === null || now - w.completedAt < COMPLETED_WRITE_TTL_MS,
		);
		this.writeConfirmations = this.writeConfirmations.filter(
			(confirmation) =>
				!confirmation.consumed ||
				now - confirmation.observedAt < COMPLETED_WRITE_TTL_MS,
		);
		if (
			this.completedIngest?.settledAt !== null &&
			this.completedIngest?.settledAt !== undefined &&
			now - this.completedIngest.settledAt >= COMPLETED_WRITE_TTL_MS
		) {
			this.completedIngest = null;
		}
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
		this.observeWriteConfirmation();
		this.trackIngestLane();
		this.pruneWrites();
		if (this.tickCount % SNAPSHOT_EVERY_TICKS === 0) {
			void this.refreshSnapshot();
		} else {
			void this.refreshDiskStat();
		}
		this.render();
	}

	private async refreshSnapshot(): Promise<void> {
		if (this.snapshotInFlight || !this.boundPath) return;
		if (this.lookup().status !== "ok") return;
		this.snapshotInFlight = true;
		const path = this.boundPath;
		try {
			// Probe first so the disk content snapshot is associated with measured
			// filesystem metadata, never the HSM's cached disk identity.
			const diskMtime = await this.probeDiskStat(path);
			const snapshot = await this.context.debugAPI.getHsmStateSnapshot(
				"/" + path,
			);
			if (this.boundPath !== path) return;
			this.snapshot = snapshot;
			this.snapshotAt = this.context.timeProvider.now();
			this.snapshotDiskMtime = diskMtime;
		} catch {
			if (this.boundPath !== path) return;
			this.snapshot = null;
			this.snapshotAt = null;
			this.snapshotDiskMtime = null;
		} finally {
			this.snapshotInFlight = false;
		}
	}

	private async refreshDiskStat(): Promise<void> {
		if (this.diskStatInFlight || !this.boundPath) return;
		this.diskStatInFlight = true;
		const path = this.boundPath;
		try {
			await this.probeDiskStat(path);
		} finally {
			this.diskStatInFlight = false;
		}
	}

	private async probeDiskStat(path: string): Promise<number | null> {
		const sequence = ++this.diskProbeSequence;
		let mtime: number | null = null;
		try {
			const stat = await this.context.app.vault.adapter.stat(path);
			mtime = stat?.mtime ?? null;
		} catch {
			mtime = null;
		}
		if (this.boundPath === path && sequence >= this.appliedDiskProbeSequence) {
			this.appliedDiskProbeSequence = sequence;
			this.diskStatMtime = mtime;
			this.diskStatAt = this.context.timeProvider.now();
		}
		return mtime;
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

	private recordEditorChange(editor: Editor): void {
		const now = this.context.timeProvider.now();
		const content = editor.getValue();
		this.lastEditorText = content;
		this.lastEditorChangeAt = now;

		const machineTextIndex = this.pendingMachineEditorTexts.indexOf(content);
		const machineApplied = machineTextIndex >= 0;
		if (machineApplied) {
			this.pendingMachineEditorTexts.splice(0, machineTextIndex + 1);
		}

		// The stale editor event that caused the trample may finish propagating
		// after the latch is set. A later user edit has a new buffer identity;
		// Relay-applied editor effects are recognized from the effect payload.
		const reverted = this.revertedIngest;
		if (reverted && !machineApplied && content !== reverted.preContent) {
			this.revertedIngest = null;
			this.completedIngest = null;
		}
	}

	private rememberMachineEditorText(content: string): void {
		this.pendingMachineEditorTexts.push(content);
		if (this.pendingMachineEditorTexts.length > 8) {
			this.pendingMachineEditorTexts.shift();
		}
	}

	private applyTextChanges(
		content: string,
		changes: { from: number; to: number; insert: string }[],
	): string {
		const sorted = [...changes].sort((a, b) => b.from - a.from);
		let result = content;
		for (const change of sorted) {
			result =
				result.slice(0, change.from) + change.insert + result.slice(change.to);
		}
		return result;
	}

	private trackStoreTexts(
		editorText: string | null,
		localText: string | null,
	): void {
		const now = this.context.timeProvider.now();
		if (editorText !== this.lastEditorText) {
			this.lastEditorText = editorText;
			this.lastEditorChangeAt = now;
		}
		if (localText !== this.lastLocalText) {
			this.lastLocalText = localText;
			this.lastLocalChangeAt = now;
		}
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
		if (
			diskContent === null ||
			this.snapshotAt === null ||
			this.diskStatAt === null ||
			this.diskStatMtime === null ||
			this.snapshotDiskMtime === null ||
			this.diskStatMtime !== this.snapshotDiskMtime
		) {
			return null;
		}
		return editorText !== diskContent;
	}

	private pendingWrites(): ObservedWrite[] {
		return this.writes.filter((w) => w.completedAt === null);
	}

	private recordStoreAgreement(diskMtime: number): void {
		const agreedAt = Math.max(diskMtime, this.lastEditorChangeAt ?? diskMtime);
		this.lastAgreementAt = agreedAt;
	}

	private storeDivergence(
		editorText: string | null,
		diskMtime: number | null,
	): StoresCheck {
		const editorAt = this.lastEditorChangeAt;
		const agreementAt = this.lastAgreementAt;
		if (
			agreementAt !== null &&
			editorAt !== null &&
			diskMtime !== null &&
			editorAt > agreementAt &&
			diskMtime > agreementAt
		) {
			return { label: "diverged", cls: "bad" };
		}
		if (diskMtime !== null && editorAt !== null && diskMtime > editorAt) {
			return { label: "editor behind disk", cls: "warn" };
		}
		if (
			diskMtime !== null &&
			editorAt !== null &&
			editorAt > diskMtime &&
			this.editorUnsaved(editorText)
		) {
			return { label: "disk behind editor", cls: "warn" };
		}
		return { label: "diverged", cls: "bad" };
	}

	private editorLocalDivergence(
		editorText: string,
		localText: string,
	): StoresCheck {
		const mismatch = this.editorLocalMismatch;
		if (
			!mismatch ||
			mismatch.editorText !== editorText ||
			mismatch.localText !== localText
		) {
			this.editorLocalMismatch = {
				editorText,
				localText,
				observedAt: this.context.timeProvider.now(),
			};
		}

		const direction = this.editorLocalDirection(editorText, localText);
		const age =
			this.context.timeProvider.now() -
			(this.editorLocalMismatch?.observedAt ?? this.context.timeProvider.now());
		if (age > STUCK_MS) return { label: `${direction} stuck`, cls: "bad" };
		return { label: `${direction} pending`, cls: "warn" };
	}

	private editorLocalDirection(editorText: string, localText: string): string {
		const editorAt = this.lastEditorChangeAt;
		const localAt = this.lastLocalChangeAt;
		if (editorAt !== null && localAt !== null && editorAt !== localAt) {
			return editorAt > localAt ? "editor → localDoc" : "localDoc → editor";
		}
		const diskContent = this.snapshot?.diskContent ?? null;
		if (diskContent === localText && diskContent !== editorText) {
			return "localDoc → editor";
		}
		if (diskContent === editorText && diskContent !== localText) {
			return "editor → localDoc";
		}
		return "editor ↔ localDoc";
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
			return this.editorLocalDivergence(editorText, localText);
		}
		this.editorLocalMismatch = null;
		const snapshot = this.snapshot;
		if (!snapshot) return null;
		if (snapshot.diskContent === null)
			return { label: "disk missing", cls: "bad" };
		if (
			this.diskStatAt === null ||
			this.diskStatMtime === null ||
			this.snapshotDiskMtime === null ||
			this.diskStatMtime !== this.snapshotDiskMtime
		) {
			return null;
		}
		const diskMtime = this.diskStatMtime;
		if (!snapshot.diskMatchesIdb) {
			return this.storeDivergence(editorText, diskMtime);
		}
		if (diskMtime !== null) this.recordStoreAgreement(diskMtime);
		if (snapshot.hasLCA && !snapshot.idbMatchesLca) {
			return { label: "localDoc ≠ lca", cls: "bad" };
		}
		if (snapshot.persistedLcaHash && !snapshot.idbMatchesPersistedLca) {
			return { label: "localDoc ≠ persisted lca", cls: "bad" };
		}
		if (snapshot.stateVectorsEqual === false)
			return { label: "SV mismatch", cls: "bad" };
		return { label: "converged", cls: "ok" };
	}

	/** Age bad-class store disagreement so the verdict can hold it to a
	 * persistence threshold. The clock belongs to the label being named:
	 * agreement, an unmeasurable check, a warn-class label, or a label
	 * change all deliberately reset it, so what escalates is a specific
	 * pair's persistent disagreement — never a streak of assorted non-ok
	 * samples. Resetting on unmeasurable fails conservative. */
	private trackStoresMismatch(stores: StoresCheck | null): void {
		if (!stores || stores.cls !== "bad") {
			this.storesMismatch = null;
			return;
		}
		if (this.storesMismatch?.label !== stores.label) {
			this.storesMismatch = {
				label: stores.label,
				since: this.context.timeProvider.now(),
			};
		}
	}

	private verdict(lookup: LookupResult, stores: StoresCheck | null): Verdict {
		if (lookup.status === "unshared")
			return { label: "not shared", cls: "muted" };
		if (lookup.status === "no-doc") return { label: "no HSM", cls: "muted" };

		const now = this.context.timeProvider.now();
		const statePath: string = this.hsm?.state?.statePath ?? "unknown";

		if (this.snapshot?.hasConflict || statePath.includes("conflict")) {
			return { label: "conflict", cls: "bad" };
		}
		if (this.revertedIngest) return { label: "reverted", cls: "bad" };

		// A measured, converged stores row is stronger than a pending buffer or
		// an elapsed lane timer. Only the latched reverted event above can
		// override convergence.
		if (stores?.cls === "ok") {
			if (statePath.startsWith("active."))
				return { label: "tracking", cls: "ok" };
			if (statePath === "idle.synced") return { label: "synced", cls: "ok" };
			return { label: "ok", cls: "ok" };
		}
		// A bad-class store disagreement that has kept the same label past
		// the threshold names the failing pair and its direction; that
		// outranks the bare lane timers and gate backlog below, which only
		// say something is slow, not which store is wrong. Warn-class labels
		// never claim this slot (they must not downgrade a bad lane verdict)
		// and a just-flipped label starts a fresh clock; both still reach
		// the pill through the fallback below when nothing else claims it.
		if (
			stores?.cls === "bad" &&
			this.storesMismatch !== null &&
			this.storesMismatch.label === stores.label &&
			now - this.storesMismatch.since > STUCK_MS
		) {
			return { label: stores.label, cls: stores.cls };
		}
		const pending = this.pendingWrites();
		if (pending.length > 0) {
			if (pending.some((w) => now - w.startedAt > STUCK_MS)) {
				return { label: "write stuck", cls: "bad" };
			}
			return { label: "writing…", cls: "warn" };
		}
		if (this.activeIngest !== null) {
			if (now - this.activeIngest.startedAt > STUCK_MS) {
				return { label: "ingest stuck", cls: "bad" };
			}
			return { label: "ingesting…", cls: "warn" };
		}
		const gate = this.snapshot?.syncGate;
		if (gate && (gate.pendingInbound > 0 || gate.pendingOutbound > 0)) {
			return { label: "syncing", cls: "warn" };
		}
		if (stores) return { label: stores.label, cls: stores.cls };
		if (statePath.startsWith("active."))
			return { label: "tracking", cls: "ok" };
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

	private fmtTime(timestamp: number): string {
		return new Date(timestamp).toISOString().slice(11, 19);
	}

	private shortHash(hash: string | null): string {
		return hash?.slice(0, 8) ?? "hashing…";
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
		this.trackStoreTexts(editorText, localText);
		const stores = this.storesCheck(editorText, localText);
		this.trackStoresMismatch(stores);
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
				lookup.status === "unshared"
					? "not in a shared folder"
					: "no merge HSM",
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
				`✓ ${this.shortHash(last.confirmation?.hash ?? last.hash)} · took ${this.fmtAge((last.completedAt ?? 0) - last.startedAt)} · ${this.fmtAge(now - (last.completedAt ?? 0))} ago`,
				"ok",
			);
			return;
		}
		this.row("hsm write", "none observed", "muted");
	}

	/** Obsidian's native editor save (buffer → disk). Pending is a plain
	 * string compare against measured disk content and adapter mtime. */
	private renderObsidianSaveRow(editorText: string | null): void {
		if (editorText === null) return;
		const unsaved = this.editorUnsaved(editorText);
		if (unsaved === null) {
			this.row("obsidian save", "–", "muted");
			return;
		}
		const diskMtime = this.diskStatMtime;
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
		const reverted = this.revertedIngest;
		if (reverted && reverted.settledAt !== null) {
			const ingest = reverted;
			const settledAt = reverted.settledAt;
			this.row(
				"disk ingest",
				`reverted @ ${this.fmtTime(settledAt)} · ${this.shortHash(ingest.preHash)} → ${this.shortHash(ingest.contentHash)}`,
				"bad",
			);
			return;
		}
		if (this.activeIngest !== null) {
			const age = this.context.timeProvider.now() - this.activeIngest.startedAt;
			this.row(
				"disk ingest",
				`waiting ${this.fmtAge(age)}`,
				age > STUCK_MS ? "bad" : "warn",
			);
			return;
		}
		if (
			this.completedIngest?.settledAt !== null &&
			this.completedIngest?.settledAt !== undefined &&
			!this.completedIngest.clearedByConvergence
		) {
			this.row(
				"disk ingest",
				`✓ ${this.shortHash(this.completedIngest.contentHash)} · ${this.fmtAge(this.context.timeProvider.now() - this.completedIngest.settledAt)} ago`,
				"ok",
			);
			return;
		}
		// A convergence-cleared ingest renders as no lane — claiming "✓" for
		// content the dataflow did not preserve would be dishonest — but its
		// evidence above keeps watching for a revert until the TTL prune.
		this.row("disk ingest", "none", "muted");
	}
}
