/**
 * HSMEditorPlugin - CodeMirror 6 ViewPlugin for HSM Editor Integration
 *
 * This plugin captures editor changes and forwards them to the MergeHSM,
 * enabling real-time CRDT synchronization.
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
import { Transaction } from "@codemirror/state";
import { editorInfoField } from "obsidian";
import type { TFile } from "obsidian";
import { getLiveViews } from "../../editorContext";
import { isDocument, type Document } from "../../Document";
import type { MergeHSM } from "../MergeHSM";
import { CM6Integration } from "./CM6Integration";
import { syncDispatchAnnotations, ySyncAnnotation } from "./annotations";
import { curryLog } from "../../debug";
import { formatUserFacingError } from "../../UserFacingError";
import { flags } from "../../flagManager";
import type { PositionedChange } from "../types";
import {
  buildBufferedCM6ReplayEvents,
  buildTextChanges,
  rebaseBufferedTextAcrossReplacement,
  type BufferedCM6Edit,
} from "./replayBufferedEdits";
import {
  editorBindingAuthority,
  onEditorBindingAuthorityChange,
  type EditorBindingAuthority,
} from "./editorBindingAuthority";

type EditorConnectionManager = {
  sharedFolders: { lookup(path: string): any };
  findCanvas(editor: EditorView): unknown;
  findView(editor: EditorView): { document: Document } | undefined;
};

function getConnectionManager(editor: EditorView): EditorConnectionManager | null {
  return getLiveViews(editor) as EditorConnectionManager | null;
}

/**
 * Plugin value class that handles the editor ↔ HSM integration.
 */
export class HSMEditorPluginValue implements PluginValue {
  private editor: EditorView;
  private document: Document | null = null;
  private cm6Integration: CM6Integration | null = null;
  private destroyed = false;
  private embed = false;
  private pendingEdits: BufferedCM6Edit[] = [];
  private pendingEditBaseText: string | null = null;
  private pendingEditFile: TFile | null = null;
  /**
   * Typed input consumed from the buffer when replacement transactions
   * rebuilt the editor, awaiting re-entry rebased onto the replacement.
   * Each layer is a (base, edited) pair whose delta is the typed input;
   * layers are applied oldest first. Held on the instance (not in scheduled
   * closures) so a bind that completes in the same task can take the
   * restores over synchronously.
   */
  private pendingRestores: Array<{
    baseText: string;
    editedText: string;
    ingestedText?: string;
  }> = [];
  /**
   * Whether this editor view was created while the document's merge machinery
   * was already active and holding the editor lock (an attached sibling view
   * exists). Decided once per document binding at the first moment the file
   * identity and its document resolve, then sticky until the editor moves to
   * another document. null = not yet decidable.
   */
  private bornAttached: boolean | null = null;
  /**
   * True between a born-attached bind and its render. The editor buffer is
   * stale until the render replaces it, so document-side dispatches (whose
   * content the render already includes) must not be applied to it; the
   * integration's validity check reports the editor not-ready until then.
   */
  private bornAttachedRenderPending = false;
  /**
   * The positive host grant under which this binding was created. Editor
   * identity is not inferred from file metadata or DOM shape: fragment
   * editors inherit both from their host. Unknown editors remain inert.
   */
  private bindingAuthority: EditorBindingAuthority | null = null;
  private bindingEpoch = 0;
  private lastInitializationRetry:
    | { file: TFile | null; authority: EditorBindingAuthority }
    | null = null;
  private log: (...args: unknown[]) => void;
  private debug: (...args: unknown[]) => void;
  private authorityUnsubscribe: (() => void) | null = null;

  private clearPendingEdits(): void {
    this.pendingEdits = [];
    this.pendingEditBaseText = null;
    this.pendingEditFile = null;
    this.pendingRestores = [];
  }

  private deactivateUnauthorizedEditor(): void {
    if (
      this.bindingAuthority === null &&
      this.cm6Integration === null &&
      this.document === null &&
      this.pendingEdits.length === 0 &&
      this.pendingRestores.length === 0
    ) {
      return;
    }

    this.bindingEpoch += 1;
    this.bornAttachedRenderPending = false;
    this.lastInitializationRetry = null;
    if (this.cm6Integration) {
      this.cm6Integration.destroy();
      this.cm6Integration = null;
    }
    this.clearPendingEdits();
    this.document = null;
    this.bindingAuthority = null;
    this.bornAttached = null;
    this.embed = false;
  }

  private replayPendingEdits(hsm: { send: (event: any) => void }, viewId: string): boolean {
    if (this.pendingEdits.length === 0) return false;

    for (const event of buildBufferedCM6ReplayEvents(this.pendingEdits, viewId)) {
      hsm.send(event);
    }
    this.clearPendingEdits();
    if (this.embed) {
      this.document?.requestSave();
    }
    return true;
  }

  private resetForDocumentChange(nextFile: TFile | null): void {
    this.bindingEpoch += 1;
    this.bornAttachedRenderPending = false;
    this.lastInitializationRetry = null;
    if (this.cm6Integration) {
      this.cm6Integration.destroy();
      this.cm6Integration = null;
    }
    if (this.pendingEditFile === null || this.pendingEditFile !== nextFile) {
      this.clearPendingEdits();
    }
    this.document = null;
    // The attach topology belongs to the document binding, not the editor:
    // re-decide it against the next document's state.
    this.bornAttached = null;
  }

  constructor(editor: EditorView) {
    this.editor = editor;
    this.log = curryLog("[HSMEditorPlugin]", "log");
    this.debug = curryLog("[HSMEditorPlugin]", "debug");

    this.authorityUnsubscribe = onEditorBindingAuthorityChange(
      editor,
      () => this.initializeIfReady(),
    );

    // A host may grant before or after extension construction. The initial
    // probe covers the first ordering; the authority subscription above
    // synchronously re-probes for the second.
    this.initializeIfReady();
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

    try {
      const doc = folder.getFile(file);
      return isDocument(doc) ? doc : null;
    } catch (error) {
      this.debug("resolveCurrentDocument failed", {
        filePath: file.path,
        error: formatUserFacingError(error),
      });
      return null;
    }
  }

  /**
   * Check whether this EditorView is still the active editor instance for the
   * expected document. GUID matching alone is insufficient because Obsidian can
   * replace the editor while keeping the same file open.
   */
  private isCurrentEditorInstance(expectedGuid: string): boolean {
    const connectionManager = getConnectionManager(this.editor);
    if (!connectionManager) return false;

    if (this.embed) {
      const currentDoc = this.resolveCurrentDocument();
      return (
        currentDoc !== null &&
        currentDoc.guid === expectedGuid &&
        connectionManager.findCanvas(this.editor) !== undefined
      );
    }

    const liveView = connectionManager.findView(this.editor);
    return liveView !== undefined && liveView.document.guid === expectedGuid;
  }

  /**
   * Check that this editor still shows the exact file (and document) it was
   * bound to. Keyed off file identity because editor views are reused across
   * file switches: the TFile reference and the resolved document GUID must
   * both match, so a reused view pointing at another file can never pass.
   */
  private isEditorShowingFile(expectedGuid: string, expectedFile: TFile): boolean {
    // Obsidian updates editorInfoField.file before setViewData replaces the
    // buffer on view reuse; this identity check therefore fails before any
    // render can target another file's content.
    const fileInfo = this.editor.state.field(editorInfoField, false);
    if (!fileInfo?.file || fileInfo.file !== expectedFile) return false;
    const currentDoc = this.resolveCurrentDocument();
    return (
      currentDoc !== null &&
      !currentDoc.destroyed &&
      currentDoc.guid === expectedGuid
    );
  }

  /**
   * Decide, once per document binding, whether this view was created while
   * the document's merge machinery was already active and holding the editor
   * lock. Decided at the first moment the editor's file identity and its
   * document both resolve, and sticky afterwards: a view whose own lock cycle
   * runs during its lifetime (first editor on the document) keeps the
   * buffered-input path, so first-editor behavior is unchanged. Embedded
   * canvas editors always keep the buffered path.
   */
  private probeBornAttached(): boolean {
    if (this.bornAttached === null) {
      const authority = editorBindingAuthority(this.editor);
      if (!authority || authority !== this.bindingAuthority) return false;
      const fileInfo = this.editor.state.field(editorInfoField, false);
      if (fileInfo?.file) {
        const doc = this.resolveCurrentDocument();
        if (doc) {
          this.bornAttached =
            authority.kind === "workspace-markdown-view" &&
            doc.hsm !== null &&
            doc.hsm.matches("active.tracking");
          // `active.entering` is deliberately not promoted later: it may be
          // this view's own first-editor lock cycle. A sibling born in that
          // narrow state retains the cold-boot buffer/replay path.
        }
      }
    }
    return this.bornAttached === true;
  }

  /**
   * Initialize CM6Integration if document and HSM are ready.
   */
  initializeIfReady(): boolean {
    if (this.destroyed) return false;

    const authority = editorBindingAuthority(this.editor);
    if (!authority) {
      this.deactivateUnauthorizedEditor();
      return false;
    }
    if (this.cm6Integration && this.bindingAuthority === authority) return true;
    if (this.bindingAuthority && this.bindingAuthority !== authority) {
      this.resetForDocumentChange(
        this.editor.state.field(editorInfoField, false)?.file ?? null,
      );
    }
    this.bindingAuthority = authority;

    const connectionManager = getConnectionManager(this.editor);
    if (!connectionManager) return false;

    this.embed = authority.kind === "canvas-file-node";

    this.document = this.resolveCurrentDocument();
    if (!this.document) return false;

    const hsm = this.document.hsm;
    if (!hsm) return false;

    // Verify the HSM's Document matches the editor's file.
    // When multiple SharedFolders have the same relative path, ensure the
    // editor connects to the HSM for its actual file.
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

    // Decide the attach topology for this binding (sticky; see
    // probeBornAttached). A view born while the document is already active
    // and locked binds immediately, keyed off file identity; every other
    // view keeps the LiveView-gated path below.
    const bornAttached = this.probeBornAttached();

    // LiveViews attaches after Obsidian creates and populates the EditorView.
    // Registering with the HSM before that attachment makes bootstrap dispatches
    // fail their own validity check, while subsequent keystrokes have nowhere
    // to be buffered. Wait until the editor has an owning LiveView so bootstrap
    // and input replay form one ordered handoff. A born-attached view does not
    // wait: all attach prerequisites are already satisfied, and waiting is what
    // opens the detached window the save-echo race lives in.
    if (!bornAttached && !this.isCurrentEditorInstance(expectedGuid)) {
      return false;
    }

    // Create CM6Integration with a validity check that requires both the
    // expected document GUID and the current editor identity. This detects
    // same-file editor replacement where the old EditorView still resolves to
    // the same document but is no longer the active editor instance. For a
    // born-attached view, validity may be keyed off file identity while the
    // LiveViews registry is between refresh snapshots. The exact authority
    // identity still makes editor replacement fail closed: transfer revokes
    // the outgoing EditorView before authorizing its replacement.
    const expectedFile = editorFile;
    const expectedAuthority = authority;
    this.cm6Integration = new CM6Integration(hsm, this.editor, () => {
      if (editorBindingAuthority(this.editor) !== expectedAuthority) return false;
      // Until the born-attached render replaces the stale buffer, the editor
      // is not a valid dispatch target: document-side changes arriving in
      // this window are already part of the text the render will install.
      if (this.bornAttachedRenderPending) return false;
      if (this.isCurrentEditorInstance(expectedGuid)) return true;
      return bornAttached && this.isEditorShowingFile(expectedGuid, expectedFile);
    });
    this.debug(`Initialized for ${this.document.guid} (embed: ${this.embed})`);

    const currentText = this.editor.state.doc.toString();

    if (bornAttached) {
      // Born attached: render the authoritative document text directly and
      // rebase any pre-bind input onto it. The buffered replay below never
      // runs on this path — with an attached sibling view, the save/reload
      // echo is a second delivery channel for the same keystrokes, and
      // replaying a buffer next to it can apply them twice.
      this.renderBornAttached(hsm, expectedGuid, expectedAuthority);
      return true;
    }

    hsm.attachEditorView(
      { getViewData: () => this.editor.state.doc.toString() },
      currentText,
    );

    if (this.pendingEdits.length === 0) {
      hsm.bootstrapEditorView(
        this.cm6Integration.viewId,
        currentText,
      );
    }

    // Replay any edits that arrived before initialization completed.
    // The editor may have changed while the HSM/Document weren't ready yet.
    if (this.pendingEdits.length > 0) {
      this.log(`Replaying ${this.pendingEdits.length} buffered edits for ${expectedGuid}`);
      this.replayPendingEdits(hsm, this.cm6Integration.viewId);
    }

    return true;
  }

  /**
   * Render the localDoc into a view that was born attached, then re-enter any
   * input typed before the bind.
   *
   * The replacement is annotated as sync output so it is not re-captured; the
   * typed input is rebased across the replacement (the same mechanism the
   * pre-load populate path uses) and dispatched as ordinary user input, so it
   * flows into the document exactly once through the wired binding. Runs on a
   * microtask because the bind can complete inside an editor update, where a
   * synchronous dispatch is not allowed; the microtask still runs before any
   * subsequent input or save event can.
   */
  private renderBornAttached(
    hsm: MergeHSM,
    expectedGuid: string,
    expectedAuthority: EditorBindingAuthority,
  ): void {
    this.bornAttachedRenderPending = true;
    const integration = this.cm6Integration;
    const epoch = this.bindingEpoch;

    queueMicrotask(() => {
      // A queued render belongs to exactly one binding. Same-task view reuse
      // must not clear or consume the next binding's pending input.
      if (epoch !== this.bindingEpoch || integration !== this.cm6Integration) return;
      this.bornAttachedRenderPending = false;
      const abort = (reason: string): void => {
        this.log(`Aborting born-attached render for ${expectedGuid}: ${reason}`);
      };
      if (editorBindingAuthority(this.editor) !== expectedAuthority) {
        abort("whole-document authority changed");
        this.deactivateUnauthorizedEditor();
        return;
      }
      // Take over all pre-render input at fire time: the buffered layer
      // (including anything routed here during the render-pending window)
      // and any restores replacement transactions extracted before the
      // bind (their own queued microtasks become no-ops once consumed).
      const restores = this.pendingRestores;
      const baseText = this.pendingEditBaseText;
      const editedText = this.pendingEdits.at(-1)?.docText;
      this.clearPendingEdits();
      if (this.destroyed || !this.cm6Integration) {
        abort("integration destroyed");
        return;
      }
      if (
        !this.document ||
        this.document.destroyed ||
        this.document.guid !== expectedGuid
      ) {
        abort("document binding changed");
        return;
      }
      // The topology can collapse before the render fires (sibling closed,
      // lock released). Without an authoritative localDoc there is nothing
      // to render; the normal lock cycle takes over from here.
      if (!hsm.matches("active.tracking")) {
        abort("document left active tracking");
        return;
      }
      const localDoc = hsm.getLocalDoc();
      if (!localDoc) {
        abort("local document unavailable");
        return;
      }

      const localText = localDoc.getText("contents").toString();
      const currentText = this.editor.state.doc.toString();

      // Do not replace the HSM's legitimate sibling view reference until
      // every late born-attached check has passed. In particular, a nested
      // editor whose container becomes observable only after construction
      // must abort above without leaving its fragment buffer as the HSM's
      // source of editor truth.
      hsm.attachEditorView(
        { getViewData: () => this.editor.state.doc.toString() },
        currentText,
      );

      // Replace whatever the buffer holds — stale disk load, a save echo,
      // pre-bind typing — with the document text.
      if (currentText !== localText) {
        this.editor.dispatch({
          changes: [{ from: 0, to: currentText.length, insert: localText }],
          annotations: syncDispatchAnnotations(
            this.editor,
            flags().enableSingleUserHistory,
          ),
        });
      }

      // Re-enter pre-bind typing rebased onto the rendered text, oldest
      // layer first. Each layer is a (base, edited) pair whose delta is the
      // typed input. The point-in-time ingested replacement lets the rebase
      // omit any insertion portion already delivered through a save echo.
      let targetText = localText;
      const ingestedReplacements = hsm.getRecentIngestedEditorReplacementTexts();
      const bufferedLayer =
        baseText !== null && editedText !== undefined
          ? [{ baseText, editedText }]
          : [];
      for (const layer of [...restores, ...bufferedLayer]) {
        if (layer.baseText === layer.editedText) continue;
        const rebased = rebaseBufferedTextAcrossReplacement(
          layer.baseText,
          layer.editedText,
          targetText,
          "ingestedText" in layer && layer.ingestedText !== undefined
            ? [layer.ingestedText as string, ...ingestedReplacements]
            : ingestedReplacements,
        );
        if (rebased === null) {
          this.log(
            `Dropping pre-bind input for ${expectedGuid}: could not rebase onto rendered text`,
          );
          continue;
        }
        targetText = rebased;
      }
      if (targetText === localText) return;
      this.editor.dispatch({
        changes: buildTextChanges(localText, targetText),
        annotations: [Transaction.userEvent.of("input.type")],
      });
    });
  }

  /**
   * Re-enter typed input that replacement transactions displaced, rebased
   * onto the current buffer, oldest layer first. Runs on a microtask after
   * the replacement; a no-op when a bind consumed the restore state in the
   * meantime.
   */
  private flushPendingRestores(): void {
    const restores = this.pendingRestores;
    this.pendingRestores = [];
    if (restores.length === 0 || this.destroyed) return;
    const currentText = this.editor.state.doc.toString();
    let restoredText = currentText;
    const ingestedReplacements =
      this.document?.hsm?.getRecentIngestedEditorReplacementTexts() ?? [];
    for (const layer of restores) {
      if (layer.baseText === layer.editedText) continue;
      const rebased = rebaseBufferedTextAcrossReplacement(
        layer.baseText,
        layer.editedText,
        restoredText,
        layer.ingestedText !== undefined
          ? [layer.ingestedText, ...ingestedReplacements]
          : ingestedReplacements,
      );
      if (rebased === null) continue;
      restoredText = rebased;
    }
    if (restoredText === currentText) return;

    this.editor.dispatch({
      changes: buildTextChanges(currentText, restoredText),
      annotations: Transaction.userEvent.of("input.type"),
    });
  }

  /**
   * Handle editor updates from CodeMirror.
   * This is called on every editor state change.
   */
  update(update: ViewUpdate): void {
    if (this.destroyed) return;
    const authority = editorBindingAuthority(this.editor);
    if (!authority) {
      // A legitimate host grant can arrive after the EditorView is already
      // configured and accepting input. Preserve a bounded delta from the
      // first pre-grant edit; it remains inert unless a host later grants this
      // exact instance, at which point normal bind reconciliation consumes it.
      if (
        this.bindingAuthority !== null ||
        this.cm6Integration !== null ||
        this.document !== null
      ) {
        this.deactivateUnauthorizedEditor();
        return;
      }
      if (
        update.docChanged &&
        !update.transactions.some((tr) => tr.annotation(ySyncAnnotation))
      ) {
        const userEvent = update.transactions
          .map((tr) => tr.annotation(Transaction.userEvent))
          .find((event) => event != null);
        if (userEvent !== "set") {
          if (this.pendingEditBaseText === null) {
            this.pendingEditBaseText = update.startState.doc.toString();
            this.pendingEditFile =
              this.editor.state.field(editorInfoField, false)?.file ?? null;
          }
          const editedText = update.state.doc.toString();
          const changes = buildTextChanges(this.pendingEditBaseText, editedText);
          this.pendingEdits = changes.length > 0
            ? [{ changes, docText: editedText, userEvent }]
            : [];
        }
      }
      return;
    }
    if (this.bindingAuthority && this.bindingAuthority !== authority) {
      this.resetForDocumentChange(
        this.editor.state.field(editorInfoField, false)?.file ?? null,
      );
      this.bindingAuthority = authority;
    }
    if (update.docChanged) {
      this.lastInitializationRetry = null;
    }

    // Skip editors that are definitively outside a shared folder. During file
    // open, editorInfoField can still be unset while the CM6 buffer already
    // accepts input. Preserve document changes from that unidentified window;
    // a later set transaction will rebase them onto the populated file.
    if (!this.cm6Integration && !this.resolveCurrentDocument()) {
      const fileInfo = this.editor.state.field(editorInfoField, false);
      const file = fileInfo?.file;
      const connectionManager = getConnectionManager(this.editor);
      const folder = file
        ? connectionManager?.sharedFolders.lookup(file.path)
        : null;
      if (!update.docChanged || (file && !folder)) {
        this.clearPendingEdits();
        return;
      }
    }

    // Detect when the editor is now showing a different document.
    // This happens when Obsidian reuses an editor view for a new file,
    // after a file rename where the Document object changes, or after a
    // GUID remap during shared folder reconciliation. Checked before the
    // docChanged guard so that GUID remaps (which are remote-only and
    // produce no editor transaction) still trigger re-initialization.
    if (this.document?.destroyed) {
      const nextFile =
        this.editor.state.field(editorInfoField, false)?.file ?? null;
      this.resetForDocumentChange(nextFile);
      this.initializeIfReady();
    }

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
        // Buffered changes belong to the document that was current when they
        // were captured. Never carry them across EditorView reuse or a GUID
        // remap into the replacement document's HSM.
        this.resetForDocumentChange(currentDoc.tfile);
        // Immediately re-initialize with the new document so the
        // editor-CRDT bridge is not lost. This is essential for GUID
        // remaps where no user edit (docChanged) will follow.
        this.initializeIfReady();
      }
    }

    // Skip if no document changes — but while unbound, retry initialization
    // first: a view created on an already-active document must bind on the
    // first tick where its file identity resolves (editorInfoField can lag
    // view creation), not wait for input to arrive.
    if (!update.docChanged) {
      if (!this.cm6Integration) {
        const file = this.editor.state.field(editorInfoField, false)?.file ?? null;
        const prior = this.lastInitializationRetry;
        if (
          !prior ||
          prior.file !== file ||
          prior.authority !== authority
        ) {
          this.lastInitializationRetry = { file, authority };
          this.initializeIfReady();
        }
      }
      return;
    }

    // Skip if this change came from Yjs/HSM sync (prevent feedback loop)
    if (
      update.transactions.length > 0 &&
      update.transactions.some((tr) => tr.annotation(ySyncAnnotation))
    ) {
      return;
    }

    // While a born-attached render is pending, the buffer is still the stale
    // pre-bind content: route any input through the buffering path below so
    // the render (which captures at fire time) rebases it onto the rendered
    // text, exactly like input typed before the bind.
    if (!this.cm6Integration || this.bornAttachedRenderPending) {
      const userEvent = update.transactions
        .map((tr) => tr.annotation(Transaction.userEvent))
        .find((event) => event != null);

      // Obsidian's initial setViewData populates the new editor from disk
      // before LiveViews attaches it. The HSM remains authoritative and will
      // bootstrap the attached editor. User input can land in the temporary
      // pre-load buffer first, so rebase those edits onto the populated buffer
      // before discarding their stale positions.
      if (userEvent === "set") {
        // A replacement rebuilt the buffer (initial populate, or a sibling
        // view's save echoing back through a file reload). When the document
        // is already active and locked, bind now instead of restoring typed
        // input onto the replacement: the bind renders the authoritative
        // document text and rebases the typed input onto that, so the
        // replacement content is never treated as an edit source. (With the
        // bind already made and a render pending, the replacement falls
        // through to the restore extraction below; the render consumes it.)
        if (
          !this.cm6Integration &&
          this.probeBornAttached() &&
          this.initializeIfReady()
        ) {
          return;
        }
        const priorRestores = this.pendingRestores;
        const baseText = this.pendingEditBaseText;
        const editedText = this.pendingEdits.at(-1)?.docText;
        this.clearPendingEdits();
        const newLayer =
          baseText !== null && editedText !== undefined
            ? [{
                baseText,
                editedText,
                ingestedText: update.state.doc.toString(),
              }]
            : [];
        this.pendingRestores = [...priorRestores, ...newLayer];
        if (this.pendingRestores.length > 0) {
          // Held on the instance so a bind completing later in this same
          // task can take the restores over before the microtask fires.
          queueMicrotask(() => this.flushPendingRestores());
        }
      } else {
        // Buffer the actual CM6 changes before attempting initialization. The
        // update that makes an attached editor ready can itself contain user
        // input, and bootstrap must replay that input instead of replacing it.
        if (this.pendingEdits.length === 0) {
          this.pendingEditBaseText = update.startState.doc.toString();
          this.pendingEditFile =
            this.editor.state.field(editorInfoField, false)?.file ?? null;
        }
        const changes: PositionedChange[] = [];
        update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          changes.push({ from: fromA, to: toA, insert: inserted.toString() });
        });
        if (changes.length > 0) {
          this.pendingEdits.push({
            changes,
            docText: update.state.doc.toString(),
            userEvent,
          });
        }
      }

      this.initializeIfReady();
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
    this.authorityUnsubscribe?.();
    this.authorityUnsubscribe = null;
    if (this.cm6Integration) {
      this.cm6Integration.destroy();
      this.cm6Integration = null;
    }
    this.clearPendingEdits();
    this.document = null;
    this.bindingAuthority = null;
    this.editor = null as any;
  }
}

/**
 * The HSMEditorPlugin ViewPlugin for CodeMirror 6.
 *
 * Add this to the editor extensions to enable editor→HSM sync:
 *   extensions: [HSMEditorPlugin, ...]
 */
export const HSMEditorPlugin = ViewPlugin.fromClass(HSMEditorPluginValue);
