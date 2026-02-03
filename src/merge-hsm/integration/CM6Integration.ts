/**
 * CM6Integration - CodeMirror 6 Integration for MergeHSM
 *
 * Bridges the MergeHSM with CodeMirror 6 editor:
 * - Subscribes to HSM effects and dispatches changes to editor
 * - Forwards editor changes to HSM
 * - Tracks editor state for drift detection
 * - Connects conflict decoration plugin to HSM for inline resolution
 */

import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { MergeHSM } from '../MergeHSM';
import type { PositionedChange } from '../types';
// Import the shared annotation to prevent feedback loops
import { ySyncAnnotation } from './annotations';
// Import conflict decoration plugin accessor
import { getConflictDecorationPlugin } from '../../y-codemirror.next/ConflictDecorationPlugin';

// =============================================================================
// CM6Integration Class
// =============================================================================

export class CM6Integration {
  private hsm: MergeHSM;
  private view: EditorView;
  private unsubscribe: (() => void) | null = null;
  private suppressNextChange = false;
  private conflictPluginConnected = false;

  constructor(hsm: MergeHSM, view: EditorView) {
    this.hsm = hsm;
    this.view = view;

    // Subscribe to HSM effects
    this.unsubscribe = hsm.effects.subscribe((effect) => {
      if (effect.type === 'DISPATCH_CM6') {
        this.dispatchToEditor(effect.changes);
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

    // Convert PositionedChange[] to CodeMirror ChangeSpec[]
    const cmChanges = changes.map((change) => ({
      from: change.from,
      to: change.to,
      insert: change.insert,
    }));

    // Set flag to suppress the resulting editor change event
    this.suppressNextChange = true;

    this.view.dispatch({
      changes: cmChanges,
      // Mark as coming from Yjs/HSM to prevent feedback loops
      annotations: [ySyncAnnotation.of(this.view)],
    });

    this.suppressNextChange = false;
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

    // Skip if this change originated from HSM (dispatched by us)
    if (this.suppressNextChange) {
      return;
    }

    // Only process if there are actual document changes
    if (!update.docChanged) {
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
        type: 'CM6_CHANGE',
        changes,
        docText: update.state.doc.toString(),
        isFromYjs: false,
      });
    }
  }

  /**
   * Destroy the integration and unsubscribe from HSM.
   */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
