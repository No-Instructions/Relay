/**
 * CM6Integration - CodeMirror 6 Integration for MergeHSM
 *
 * Bridges the MergeHSM with CodeMirror 6 editor:
 * - Subscribes to HSM effects and dispatches changes to editor
 * - Forwards editor changes to HSM
 * - Tracks editor state for drift detection
 * - Connects conflict decoration plugin to HSM for inline resolution
 */

import type { EditorView, ViewUpdate } from "@codemirror/view";
import { Transaction, type TransactionSpec } from "@codemirror/state";
import { editorInfoField, getFrontMatterInfo } from "obsidian";
import type { MergeHSM } from "../MergeHSM";
import type { PositionedChange } from "../types";
// Import the shared annotation to prevent feedback loops
import { ySyncAnnotation } from "./annotations";
import { curryLog } from "../../debug";

/**
 * Callback to verify the editor is still bound to the expected document.
 * Returns true if the editor is showing the document this integration was
 * created for. Used to detect view reuse and file renames.
 */
export type EditorValidityCheck = () => boolean;

// =============================================================================
// CM6Integration Class
// =============================================================================

let viewIdCounter = 0;

export class CM6Integration {
	private hsm: MergeHSM;
	private view: EditorView;
	private unsubscribe: (() => void) | null = null;
	private destroyed = false;
	private log: (...args: unknown[]) => void;
	private warn: (...args: unknown[]) => void;
	private isEditorStillValid: EditorValidityCheck;
	private driftCheckTimer: ReturnType<typeof setTimeout> | null = null;
	readonly viewId: string;

	/** Delay after last data-flow event before checking for drift (ms) */
	private static readonly DRIFT_CHECK_DELAY = 3000;

	private isRecoverableDispatchError(error: unknown): error is Error {
		if (!(error instanceof Error)) return false;
		return (
			error.message.includes("Invalid change range") ||
			error.message.includes("wrong length")
		);
	}

	private shouldBypassFrontmatterTransactionFilters(
		changes: PositionedChange[],
	): boolean {
		const fileInfo = this.view.state.field(editorInfoField, false) as any;
		const propertiesInDocument =
			fileInfo?.app?.vault?.getConfig?.("propertiesInDocument") ?? null;
		if (propertiesInDocument === "source") {
			return false;
		}

		const info = getFrontMatterInfo(this.view.state.doc.toString());
		if (!info.exists) {
			return false;
		}
		const frontmatterEnd = info.contentStart;

		const selectionTouchesFrontmatter =
			this.view.state.selection.ranges.some(
				(range) => range.from <= frontmatterEnd || range.to <= frontmatterEnd,
			);
		if (!selectionTouchesFrontmatter) {
			return false;
		}

		return changes.some(
			(change) => change.from < frontmatterEnd || change.to <= frontmatterEnd,
		);
	}

	private recoverFromDispatchError(
		error: unknown,
		changes: PositionedChange[],
		phase: "dispatch" | "dispatch-rAF",
	): boolean {
		if (!this.isRecoverableDispatchError(error)) {
			return false;
		}
		const message = error.message;

		if (this.destroyed || !this.isEditorStillValid()) {
			this.warn(
				`${phase}: stale CM6 patch after view invalidation; dropping ${changes.length} changes`,
			);
			return true;
		}

		const editorText = this.view.state.doc.toString();
		const driftDetected = this.hsm.checkAndCorrectDrift(editorText);
		this.warn(
			`${phase}: CM6 rejected patch (${message}). ` +
				`${driftDetected ? "Triggered drift recovery." : "Editor/localDoc already match; dropping stale patch."}`,
		);
		return true;
	}

	constructor(
		hsm: MergeHSM,
		view: EditorView,
		isEditorStillValid: EditorValidityCheck,
	) {
		this.hsm = hsm;
		this.view = view;
		this.isEditorStillValid = isEditorStillValid;
		this.viewId = `cm6-${++viewIdCounter}`;
		this.log = curryLog("[CM6Integration]", "log");
		this.warn = curryLog("[CM6Integration]", "warn");

		// Subscribe to HSM effects
		this.unsubscribe = hsm.effects.subscribe((effect) => {
			if (effect.type === "DISPATCH_CM6") {
				if (effect.originView === this.viewId) return;
				this.dispatchToEditor(effect.changes);
			}
			if (effect.type === "SET_CM6") {
				if (effect.targetView !== this.viewId) return;
				this.setEditorText(effect.text);
			}
			// Reset drift debounce on any data-flow effect, not just DISPATCH_CM6.
			// REMOTE_UPDATE processing (mergeRemoteToLocal) may not emit DISPATCH_CM6
			// (e.g., machine edit rewind where net text is unchanged), but the pipeline
			// is still active and the editor may not have settled yet.
			if (
				effect.type === "DISPATCH_CM6" ||
				effect.type === "SYNC_TO_REMOTE" ||
				effect.type === "DIAGNOSTIC" ||
				effect.type === "STATUS_CHANGED" ||
				effect.type === "PERSIST_STATE"
			) {
				this.scheduleDriftCheck();
			}
		});
	}

	/**
	 * Dispatch changes from HSM to the editor.
	 * Uses ySyncAnnotation to prevent feedback loop.
	 */
	private dispatchToEditor(changes: PositionedChange[]): void {
		if (changes.length === 0) return;
		if (this.destroyed) return;

		// Verify the editor is still bound to our document.
		// If the editor has been reused for a different file, dispatching would
		// corrupt the wrong document.
		if (!this.isEditorStillValid()) {
			this.log("Skipping dispatch: editor is no longer bound to this document");
			return;
		}

		// Convert PositionedChange[] to CodeMirror ChangeSpec[]
		const cmChanges = changes.map((change) => ({
			from: change.from,
			to: change.to,
			insert: change.insert,
		}));

		try {
			const editorBefore = this.view.state.doc.length;
			this.log(
				`dispatchToEditor: ${changes.length} changes, editor=${editorBefore} chars before`,
			);
				const dispatchSpec: TransactionSpec = {
					changes: cmChanges,
					// Mark as coming from Yjs/HSM to prevent feedback loops
					annotations: [ySyncAnnotation.of(this.view)],
			};
			if (this.shouldBypassFrontmatterTransactionFilters(changes)) {
				dispatchSpec.filter = false;
			}
			this.view.dispatch(dispatchSpec);
			const editorAfter = this.view.state.doc.length;
			this.log(`dispatchToEditor: editor=${editorAfter} chars after`);
		} catch (e) {
			// CM6 throws if dispatch is called during an update (re-entrant).
			// Defer to the next microtask to break the synchronous cycle.
			if (e instanceof Error && e.message.includes("update is in progress")) {
				this.warn(
					`dispatchToEditor: DEFERRED due to re-entrant update. ${changes.length} changes queued for rAF`,
				);
				requestAnimationFrame(() => {
					if (!this.destroyed && this.isEditorStillValid()) {
						try {
							const editorBefore = this.view.state.doc.length;
							this.log(
								`dispatchToEditor (rAF): applying ${changes.length} deferred changes, editor=${editorBefore} chars before`,
							);
								const dispatchSpec: TransactionSpec = {
									changes: cmChanges,
									annotations: [ySyncAnnotation.of(this.view)],
							};
							if (this.shouldBypassFrontmatterTransactionFilters(changes)) {
								dispatchSpec.filter = false;
							}
							this.view.dispatch(dispatchSpec);
							const editorAfter = this.view.state.doc.length;
							this.log(
								`dispatchToEditor (rAF): editor=${editorAfter} chars after`,
							);
						} catch (deferredError) {
							if (
								!this.recoverFromDispatchError(
									deferredError,
									changes,
									"dispatch-rAF",
								)
								) {
									throw deferredError;
								}
							}
						}
					});
			} else if (this.recoverFromDispatchError(e, changes, "dispatch")) {
				return;
			} else {
				throw e;
			}
		}
	}

	private setEditorText(text: string): void {
		if (this.destroyed) return;

		if (!this.isEditorStillValid()) {
			this.log("Skipping SET_CM6: editor is no longer bound to this document");
			return;
		}

		const currentText = this.view.state.doc.toString();
		if (currentText === text) {
			return;
		}

		const changes = [{
			from: 0,
			to: this.view.state.doc.length,
			insert: text,
		}];

		try {
			this.log(
				`setEditorText: replacing ${currentText.length} chars with ${text.length} chars`,
			);
			const replacementChanges = [{ from: 0, to: currentText.length, insert: text }];
				const dispatchSpec: TransactionSpec = {
					changes,
					annotations: [ySyncAnnotation.of(this.view)],
			};
			if (
				this.shouldBypassFrontmatterTransactionFilters(
					replacementChanges,
				)
			) {
				dispatchSpec.filter = false;
			}
			this.view.dispatch(dispatchSpec);
		} catch (e) {
			if (e instanceof Error && e.message.includes("update is in progress")) {
				this.warn("setEditorText: DEFERRED due to re-entrant update");
				requestAnimationFrame(() => {
					if (!this.destroyed && this.isEditorStillValid()) {
						const replacementChanges = [{ from: 0, to: currentText.length, insert: text }];
							const dispatchSpec: TransactionSpec = {
								changes,
								annotations: [ySyncAnnotation.of(this.view)],
						};
						if (
							this.shouldBypassFrontmatterTransactionFilters(
								replacementChanges,
							)
						) {
							dispatchSpec.filter = false;
						}
						this.view.dispatch(dispatchSpec);
					}
				});
			} else if (
				!this.recoverFromDispatchError(
					e,
					[{ from: 0, to: currentText.length, insert: text }],
					"dispatch",
				)
			) {
				throw e;
			}
		}
	}

	/**
	 * Handle editor updates from CodeMirror.
	 * Call this from a ViewPlugin's update method.
	 */
	onEditorUpdate(update: ViewUpdate): void {
		// Only process if there are actual document changes
		if (!update.docChanged) {
			return;
		}

		// Skip changes originating from Yjs/HSM dispatches (annotation-based echo suppression)
		if (update.transactions.some((tr) => tr.annotation(ySyncAnnotation))) {
			return;
		}

		// Verify the editor is still bound to our document.
		// When editor views are reused, an old CM6Integration might receive
		// updates for a different file. Sending these to the wrong HSM causes
		// content corruption.
		if (!this.isEditorStillValid()) {
			this.log(
				"Skipping editor update: editor is no longer bound to this document",
			);
			return;
		}

		// Convert CodeMirror changes to PositionedChange[]
		const changes: PositionedChange[] = [];
		update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			changes.push({
				from: fromA,
				to: toA,
				insert: inserted.toString(),
			});
		});

		// Send to HSM
		if (changes.length > 0) {
			const userEvent = update.transactions
				.map((tr) => tr.annotation(Transaction.userEvent))
				.find((e) => e != null);
			this.hsm.send({
				type: "CM6_CHANGE",
				changes,
				docText: update.state.doc.toString(),
				viewId: this.viewId,
				userEvent,
			});
			this.scheduleDriftCheck();
		}
	}

	/**
	 * Schedule a drift check after data-flow activity settles.
	 * Each call resets the timer so the check only fires once
	 * things have been quiet for DRIFT_CHECK_DELAY ms.
	 */
	private scheduleDriftCheck(): void {
		if (this.destroyed) return;
		if (this.driftCheckTimer !== null) {
			clearTimeout(this.driftCheckTimer);
		}
		this.driftCheckTimer = setTimeout(() => {
			this.driftCheckTimer = null;
			if (this.destroyed) return;
			if (!this.isEditorStillValid()) return;

			const editorText = this.view.state.doc.toString();
			const driftDetected = this.hsm.checkAndCorrectDrift(editorText);

			if (driftDetected) {
				this.warn(
					`Drift detected for ${this.hsm.guid}. ` +
						`This indicates a change reached the editor without going through the HSM.`,
				);
			}
		}, CM6Integration.DRIFT_CHECK_DELAY);
	}

	/**
	 * Destroy the integration and unsubscribe from HSM.
	 */
	destroy(): void {
		this.destroyed = true;
		if (this.driftCheckTimer !== null) {
			clearTimeout(this.driftCheckTimer);
			this.driftCheckTimer = null;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
	}
}
