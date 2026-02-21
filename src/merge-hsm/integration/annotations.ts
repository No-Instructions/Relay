/**
 * Shared CodeMirror annotations for HSM/CRDT integration.
 *
 * These annotations are used to mark editor dispatches that originate from
 * the sync system (HSM, Yjs) to prevent feedback loops.
 */

import { Annotation } from "@codemirror/state";

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
