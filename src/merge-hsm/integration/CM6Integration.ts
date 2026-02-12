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
import { editorInfoField } from 'obsidian';
import type { MergeHSM } from '../MergeHSM';
import type { PositionedChange } from '../types';
// Import the shared annotation to prevent feedback loops
import { ySyncAnnotation } from './annotations';
// Import conflict decoration plugin accessor
import { getConflictDecorationPlugin } from '../../y-codemirror.next/ConflictDecorationPlugin';
import { curryLog } from '../../debug';

// =============================================================================
// CM6Integration Class
// =============================================================================

export class CM6Integration {
  private hsm: MergeHSM;
  private view: EditorView;
  private unsubscribe: (() => void) | null = null;
  private suppressNextChange = false;
  private conflictPluginConnected = false;
  private destroyed = false;
  private log: (...args: unknown[]) => void;
  private warn: (...args: unknown[]) => void;
  /**
   * The vault-relative path that this integration was created for.
   * Used to detect when the editor view has switched to a different file.
   */
  private readonly expectedVaultPath: string;
  private driftCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** How often to check for editor↔CRDT drift (ms) */
  private static readonly DRIFT_CHECK_INTERVAL = 5000;

  constructor(hsm: MergeHSM, view: EditorView, vaultRelativePath: string) {
    this.hsm = hsm;
    this.view = view;
    this.expectedVaultPath = vaultRelativePath;
    this.log = curryLog('[CM6Integration]', 'log');
    this.warn = curryLog('[CM6Integration]', 'warn');

    // Subscribe to HSM effects
    this.unsubscribe = hsm.effects.subscribe((effect) => {
      if (effect.type === 'DISPATCH_CM6') {
        this.dispatchToEditor(effect.changes);
      }
    });

    // Connect the conflict decoration plugin to HSM
    this.connectConflictPlugin();

    // Start periodic drift detection
    this.startDriftCheck();
  }

  /**
   * Check if the editor is still showing the expected file.
   * Returns false if the editor has switched to a different file.
   */
  private isEditorShowingExpectedFile(): boolean {
    const fileInfo = this.view.state.field(editorInfoField, false);
    const currentPath = fileInfo?.file?.path;
    return currentPath === this.expectedVaultPath;
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

    // BUG-056 FIX: Verify the editor is still showing our file.
    // If the editor has switched to a different file, dispatching would
    // corrupt the wrong document.
    if (!this.isEditorShowingExpectedFile()) {
      this.log(
        `Skipping dispatch: editor is no longer showing expected file "${this.expectedVaultPath}"`
      );
      return;
    }

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

    // BUG-057 FIX: Verify the editor is still showing our file.
    // When editor views are reused, an old CM6Integration might receive
    // updates for a different file. Sending these to the wrong HSM causes
    // content corruption.
    if (!this.isEditorShowingExpectedFile()) {
      this.log(
        `Skipping editor update: editor is no longer showing expected file "${this.expectedVaultPath}"`
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
        type: 'CM6_CHANGE',
        changes,
        docText: update.state.doc.toString(),
        isFromYjs: false,
      });
    }
  }

  /**
   * Start periodic drift detection between editor and CRDT.
   * Reads the actual editor content and compares against localDoc.
   * If drift is found, logs diagnostics and corrects (CRDT wins).
   */
  private startDriftCheck(): void {
    this.driftCheckInterval = setInterval(() => {
      if (this.destroyed) return;
      if (!this.isEditorShowingExpectedFile()) return;

      const editorText = this.view.state.doc.toString();
      const driftDetected = this.hsm.checkAndCorrectDrift(editorText);

      if (driftDetected) {
        this.warn(
          `Drift corrected for "${this.expectedVaultPath}". ` +
          `This indicates a change reached the editor without going through the HSM.`,
        );
      }
    }, CM6Integration.DRIFT_CHECK_INTERVAL);
  }

  /**
   * Destroy the integration and unsubscribe from HSM.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.driftCheckInterval !== null) {
      clearInterval(this.driftCheckInterval);
      this.driftCheckInterval = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
