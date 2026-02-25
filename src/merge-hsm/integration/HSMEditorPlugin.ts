/**
 * HSMEditorPlugin - CodeMirror 6 ViewPlugin for HSM Editor Integration
 *
 * This plugin captures editor changes and forwards them to the MergeHSM,
 * enabling real-time CRDT synchronization. It replaces the editor→CRDT
 * sync functionality that was previously in LiveEditPlugin.
 *
 * Flow:
 *   Editor Change → HSMEditorPlugin.update()
 *                 → CM6Integration.onEditorUpdate()
 *                 → HSM.send({ type: 'CM6_CHANGE' })
 *                 → localDoc updated
 *                 → syncLocalToRemote()
 */

import { ViewPlugin, EditorView, ViewUpdate } from "@codemirror/view";
import type { PluginValue } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { getConnectionManager } from "../../LiveViews";
import { Document } from "../../Document";
import { CM6Integration } from "./CM6Integration";
import { ySyncAnnotation } from "./annotations";
import { curryLog } from "../../debug";
import type { PositionedChange } from "../types";

/**
 * Plugin value class that handles the editor ↔ HSM integration.
 */
class HSMEditorPluginValue implements PluginValue {
  private editor: EditorView;
  private document: Document | null = null;
  private cm6Integration: CM6Integration | null = null;
  private destroyed = false;
  private embed = false;
  private pendingEdits: Array<{ changes: PositionedChange[]; docText: string }> = [];
  private log: (...args: unknown[]) => void;
  private debug: (...args: unknown[]) => void;

  constructor(editor: EditorView) {
    this.editor = editor;
    this.log = curryLog("[HSMEditorPlugin]", "log");
    this.debug = curryLog("[HSMEditorPlugin]", "debug");

    // Try to get the document and initialize CM6Integration.
    // Note: We do NOT check isLiveEditor() here and set destroyed=true,
    // because the `relay-live-editor` CSS class is added asynchronously
    // by LiveViews after acquireLock(). If we destroy here, the plugin
    // will never initialize when the class appears later.
    if (this.isLiveEditor()) {
      this.initializeIfReady();
    }
  }

  /**
   * Check if this editor is for a live/shared document.
   */
  private isLiveEditor(): boolean {
    const sourceView = this.editor.dom.closest(".markdown-source-view");
    const isLiveEditor = this.editor.dom.closest(".relay-live-editor");
    const hasIframeClass = sourceView?.classList.contains("mod-inside-iframe");

    // Only activate for live editors or embedded canvas editors
    return !!(isLiveEditor || hasIframeClass);
  }

  /**
   * Resolve the Document for the file currently shown in this editor.
   * Returns null if the file isn't in a shared folder.
   */
  private resolveCurrentDocument(): Document | null {
    const connectionManager = getConnectionManager(this.editor);
    if (!connectionManager) return null;

    const fileInfo = this.editor.state.field(editorInfoField, false);
    const file = fileInfo?.file;
    if (!file) return null;

    const folder = connectionManager.sharedFolders.lookup(file.path);
    if (!folder) return null;

    return folder.proxy.getDoc(file.path) as Document;
  }

  /**
   * Initialize CM6Integration if document and HSM are ready.
   */
  private initializeIfReady(): boolean {
    if (this.cm6Integration) return true;
    if (this.destroyed) return false;

    const connectionManager = getConnectionManager(this.editor);
    if (!connectionManager) return false;

    // Detect embedded canvas editors (no MarkdownView wrapper, no auto-save)
    const sourceView = this.editor.dom.closest(".markdown-source-view");
    this.embed = !!sourceView?.classList.contains("mod-inside-iframe");

    this.document = this.resolveCurrentDocument();
    if (!this.document) return false;

    const hsm = this.document.hsm;
    if (!hsm) return false;

    // Verify the HSM's Document matches the editor's file.
    // When multiple SharedFolders have files with the same relative path
    // (e.g., multiple e2e-fixture-* folders each with /test-1.md),
    // we must ensure we're connecting to the correct HSM.
    const fileInfo = this.editor.state.field(editorInfoField, false);
    const editorFile = fileInfo?.file;

    // Verify the Document's TFile matches the editor's TFile
    const documentTFile = this.document.tfile;
    if (editorFile && documentTFile && documentTFile !== editorFile) {
      this.log(
        `TFile mismatch: Document tfile != editor file. ` +
        `Skipping CM6Integration to prevent cross-folder contamination.`
      );
      return false;
    }

    // Don't create CM6Integration until we can identify the editor's file.
    if (!editorFile) return false;

    // Capture the document GUID for the validity check closure.
    // This is stable across renames — unlike paths.
    const expectedGuid = this.document.guid;

    // Create CM6Integration with a validity check that uses GUID identity.
    // The check resolves the editor's current document and compares GUIDs,
    // so it survives file renames and detects view reuse.
    this.cm6Integration = new CM6Integration(hsm, this.editor, () => {
      const currentDoc = this.resolveCurrentDocument();
      return currentDoc !== null && currentDoc.guid === expectedGuid;
    });
    this.debug(`Initialized for ${this.document.guid} (embed: ${this.embed})`);

    // Replay any edits that arrived before initialization completed.
    // The editor may have changed while the HSM/Document weren't ready yet.
    if (this.pendingEdits.length > 0) {
      this.log(`Replaying ${this.pendingEdits.length} buffered edits for ${expectedGuid}`);
      for (const edit of this.pendingEdits) {
        hsm.send({
          type: 'CM6_CHANGE',
          changes: edit.changes,
          docText: edit.docText,
          isFromYjs: false,
        });
      }
      this.pendingEdits = [];
    }

    return true;
  }

  /**
   * Handle editor updates from CodeMirror.
   * This is called on every editor state change.
   */
  update(update: ViewUpdate): void {
    if (this.destroyed) return;

    // Skip non-live editors entirely (no buffering needed).
    // Check resolveCurrentDocument() too — the file may be in a shared folder
    // before the relay-live-editor CSS class is added by acquireLock().
    if (!this.cm6Integration && !this.isLiveEditor() && !this.resolveCurrentDocument()) return;

    // Skip if no document changes
    if (!update.docChanged) return;

    // Skip if this change came from Yjs/HSM sync (prevent feedback loop)
    if (
      update.transactions.length > 0 &&
      update.transactions.some((tr) => tr.annotation(ySyncAnnotation))
    ) {
      return;
    }

    // Detect when the editor is now showing a different document.
    // This happens when Obsidian reuses an editor view for a new file,
    // or after a file rename where the Document object changes.
    if (this.document) {
      const currentDoc = this.resolveCurrentDocument();
      if (currentDoc && currentDoc.guid !== this.document.guid) {
        // Send diagnostic event to OLD HSM before teardown
        const oldHsm = this.document?.hsm;
        if (oldHsm) {
          try {
            oldHsm.send({
              type: 'OBSIDIAN_VIEW_REUSED',
              oldPath: this.document.path,
              newPath: currentDoc.path,
            });
          } catch { /* diagnostic must never break */ }
        }
        // Document changed! Destroy old integration and reset.
        this.log(
          `Document changed: ${this.document.guid} → ${currentDoc.guid}. ` +
          `Resetting CM6Integration.`
        );
        if (this.cm6Integration) {
          this.cm6Integration.destroy();
          this.cm6Integration = null;
        }
        this.document = null;
        // Fall through to re-initialize
      }
    }

    // Lazy initialization: HSM might not be available during constructor
    // if acquireLock() hasn't completed yet
    if (!this.cm6Integration && !this.initializeIfReady()) {
      // Buffer the actual CM6 changes so they can be replayed once initialized
      const changes: PositionedChange[] = [];
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes.push({ from: fromA, to: toA, insert: inserted.toString() });
      });
      if (changes.length > 0) {
        this.pendingEdits.push({
          changes,
          docText: update.state.doc.toString(),
        });
      }
      return;
    }

    // Forward to CM6Integration which sends to HSM
    this.cm6Integration!.onEditorUpdate(update);

    // Embedded canvas editors don't auto-save — trigger explicit save
    if (this.embed && this.document) {
      this.document.requestSave();
    }
  }

  /**
   * Clean up resources when plugin is destroyed.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.cm6Integration) {
      this.cm6Integration.destroy();
      this.cm6Integration = null;
    }
    this.pendingEdits = [];
    this.document = null;
  }
}

/**
 * The HSMEditorPlugin ViewPlugin for CodeMirror 6.
 *
 * Add this to the editor extensions to enable editor→HSM sync:
 *   extensions: [HSMEditorPlugin, ...]
 */
export const HSMEditorPlugin = ViewPlugin.fromClass(HSMEditorPluginValue);
