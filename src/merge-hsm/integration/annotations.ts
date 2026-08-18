/**
 * Shared CodeMirror annotations for HSM/CRDT integration.
 *
 * These annotations are used to mark editor dispatches that originate from
 * the sync system (HSM, Yjs) to prevent feedback loops.
 */

import {
	Annotation,
	Transaction,
	type TransactionSpec,
} from "@codemirror/state";

/**
 * Annotation used to mark editor changes that originate from Yjs/HSM sync.
 * When this annotation is present on a transaction, the HSM should NOT
 * capture those changes (they already came from the CRDT).
 *
 * Usage:
 * - When dispatching changes TO the editor (CRDT → editor):
 *   editor.dispatch({ changes, annotations: [ySyncAnnotation.of(editor)] })
 *
 * - When receiving editor changes (editor → CRDT):
 *   if (transaction.annotation(ySyncAnnotation)) return; // Skip, from sync
 */
export const ySyncAnnotation = Annotation.define<unknown>();

/**
 * Build the annotations for a synchronization-origin editor dispatch.
 *
 * The Relay annotation prevents the editor change from being captured by the
 * HSM again. With single-user history enabled, CodeMirror also keeps the
 * change out of the current editor's undo stack and identifies it as authored
 * by another actor. Disabling the flag preserves the shared undo behavior.
 */
export function syncDispatchAnnotations(
	view: unknown,
	singleUserHistory: boolean,
): TransactionSpec["annotations"] {
	if (!singleUserHistory) {
		return [ySyncAnnotation.of(view)];
	}

	return [
		ySyncAnnotation.of(view),
		Transaction.addToHistory.of(false),
		Transaction.remote.of(true),
	];
}
