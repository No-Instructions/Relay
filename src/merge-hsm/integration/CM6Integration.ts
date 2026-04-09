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
import type { MergeHSM } from "../MergeHSM";
import type { PositionedChange } from "../types";
// Import the shared annotation to prevent feedback loops
import { ySyncAnnotation } from "./annotations";
// Import conflict decoration plugin accessor
import { getConflictDecorationPlugin } from "../../y-codemirror.next/ConflictDecorationPlugin";
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

export class CM6Integration {
	private hsm: MergeHSM;
	private view: EditorView;
	private unsubscribe: (() => void) | null = null;
	private conflictPluginConnected = false;
	private destroyed = false;
	private log: (...args: unknown[]) => void;
	private warn: (...args: unknown[]) => void;
	private isEditorStillValid: EditorValidityCheck;
	private driftCheckTimer: ReturnType<typeof setTimeout> | null = null;

	/** Delay after last data-flow event before checking for drift (ms) */
	private static readonly DRIFT_CHECK_DELAY = 3000;

	constructor(
		hsm: MergeHSM,
		view: EditorView,
		isEditorStillValid: EditorValidityCheck,
	) {
		this.hsm = hsm;
		this.view = view;
		this.isEditorStillValid = isEditorStillValid;
		this.log = curryLog("[CM6Integration]", "log");
		this.warn = curryLog("[CM6Integration]", "warn");

		// Subscribe to HSM effects
		this.unsubscribe = hsm.effects.subscribe((effect) => {
			if (effect.type === "DISPATCH_CM6") {
				this.dispatchToEditor(effect.changes);
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

		// Connect the conflict decoration plugin to HSM
		this.connectConflictPlugin();
	}

	/**
	 * Connect the conflict decoration plugin to the HSM for inline resolution.
	 */
	private connectConflictPlugin(): void {
		if (this.conflictPluginConnected) return;

		const conflictPlugin = getConflictDecorationPlugin(this.view);
		if (conflictPlugin) {
			conflictPlugin.setHSM(this.hsm);
			this.conflictPluginConnected = true;
		}
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
			this.view.dispatch({
				changes: cmChanges,
				// Mark as coming from Yjs/HSM to prevent feedback loops
				annotations: [ySyncAnnotation.of(this.view)],
			});
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
						const editorBefore = this.view.state.doc.length;
						this.log(
							`dispatchToEditor (rAF): applying ${changes.length} deferred changes, editor=${editorBefore} chars before`,
						);
						this.view.dispatch({
							changes: cmChanges,
							annotations: [ySyncAnnotation.of(this.view)],
						});
						const editorAfter = this.view.state.doc.length;
						this.log(
							`dispatchToEditor (rAF): editor=${editorAfter} chars after`,
						);
					}
				});
			} else {
				throw e;
			}
		}
	}

	/**
	 * Handle editor updates from CodeMirror.
	 * Call this from a ViewPlugin's update method.
	 */
	onEditorUpdate(update: ViewUpdate): void {
		// Try to connect conflict plugin if not yet connected
		if (!this.conflictPluginConnected) {
			this.connectConflictPlugin();
		}

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
			this.hsm.send({
				type: "CM6_CHANGE",
				changes,
				docText: update.state.doc.toString(),
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
