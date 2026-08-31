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
import { editorInfoField, MarkdownView } from "obsidian";
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

type EditorConnectionManager = {
  sharedFolders: {
    lookup(path: string): { getFile(file: TFile): unknown } | null;
  };
  findCanvas(editor: EditorView): unknown;
  findCanvasEmbed?(editor: EditorView): { file: TFile } | undefined;
  findView(editor: EditorView): { document: Document } | undefined;
};

function getConnectionManager(editor: EditorView): EditorConnectionManager | null {
  return getLiveViews(editor);
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
   * Whether this EditorView has been identified as an embedded sub-editor:
   * an editor whose buffer holds less than the note and whose spawning
   * machinery persists whatever is dispatched into it back into the note as
   * a user edit. Obsidian has two such families. The Live Preview table
   * widget spawns a per-cell editor inside the clicked cell and forwards
   * its transactions into the host editor. Editable embeds (footnote
   * popovers, the footnotes pane, page-preview hover popovers, canvas file
   * nodes) spawn an editor over a subpath fragment whose every change is
   * spliced back into the file as before + buffer + after. In both, file
   * identity and document resolution match the real note. Binding one to
   * the merge machinery would render the full document into a fragment
   * buffer — which the spawning machinery then writes into the note — and
   * would feed fragment text back as document content. Sticky: once
   * detected, this instance is permanently inert.
   */
  private subEditor = false;
  private bindingEpoch = 0;
  private lastInitializationRetry:
    | {
        file: TFile | null;
        live: boolean;
        owner: EditorView | null;
        connected: boolean;
        canvas: boolean;
        canvasEmbed: boolean;
      }
    | null = null;
  private log: (...args: unknown[]) => void;
  private debug: (...args: unknown[]) => void;

  private clearPendingEdits(): void {
    this.pendingEdits = [];
    this.pendingEditBaseText = null;
    this.pendingEditFile = null;
    this.pendingRestores = [];
  }

  private replayPendingEdits(hsm: Pick<MergeHSM, "send">, viewId: string): boolean {
    if (this.pendingEdits.length === 0) return false;

    for (const event of buildBufferedCM6ReplayEvents(this.pendingEdits, viewId)) {
      hsm.send(event);
    }
    this.clearPendingEdits();
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

    // Try to get the document and initialize CM6Integration.
    // Note: We do NOT check isLiveEditor() here and set destroyed=true,
    // because the `relay-live-editor` CSS class is added asynchronously
    // by LiveViews after acquireLock(). If we destroy here, the plugin
    // will never initialize when the class appears later.
    //
    // The attempt is unconditional: a view created for a document whose
    // merge machinery is already active must bind at creation, before any
    // input or save echo can reach a detached buffer — and at creation the
    // live-editor class has not been applied to this view yet. For every
    // other editor the attempt fails fast on document resolution.
    this.initializeIfReady();
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
    // A canvas embed's CM6 lives in an iframe whose info field carries no
    // file, so it cannot name its own document. The node that owns the embed
    // does: find the node whose child is this editor and take its file.
    const file = fileInfo?.file ?? this.embeddedNodeFile(connectionManager);
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
   * The file of the canvas node whose embedded editor is this one, when this
   * editor is an embed. Null for every other editor.
   */
  private embeddedNodeFile(
    connectionManager: EditorConnectionManager,
  ): TFile | null {
    return connectionManager.findCanvasEmbed?.(this.editor)?.file ?? null;
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
        (connectionManager.findCanvas(this.editor) !== undefined ||
          connectionManager.findCanvasEmbed?.(this.editor) !== undefined)
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
   * Detect an editor that may never bind, by allow-list: the only owners
   * whose editors are eligible are workspace MarkdownViews (their own
   * editor — the adoption check in probeBornAttached and the view registry
   * prove which EditorView that is) and registered whole-file canvas embeds.
   * Sticky refusals key only on stable owner properties or ancestry that has
   * been positively observed. Everything the classification refuses is an
   * embedded sub-editor whose machinery persists dispatched content back
   * into the note, so nothing may ever be dispatched into it:
   *
   * - Any editor mounted inside a `.table-cell-wrapper` element — the
   *   container the Live Preview table widget spawns its per-cell editor
   *   in. The cell editor's owner is the host MarkdownView, so owner kind
   *   cannot catch it; ancestry is checked first because it is definitive
   *   and clears buffered fragment input immediately. The wrapper is only
   *   observable once the editor's DOM is attached, so a negative answer
   *   means "not detected", never "proven eligible".
   * - Any editor whose owner is not a MarkdownView, except a registered
   *   whole-file canvas embed. This refuses the
   *   editable-embed family — footnote popovers, the footnotes pane,
   *   page-preview hover popovers — whose buffer holds a subpath fragment
   *   the embed splices back into the file on every change, and any
   *   unrecognized future owner kind, which fails closed here instead of
   *   binding. An embed scoped to a subpath is refused even when registered
   *   by canvas: its buffer is a fragment of the target note. Before the DOM
   *   attaches, a whole-file non-view owner remains undecided because canvas
   *   registration may not exist yet; undecided editors remain unable to bind
   *   (this probe returns true without setting `subEditor`) and are re-probed
   *   after attachment.
   */
  private probeSubEditor(): boolean {
    if (this.subEditor) return true;
    if (this.editor.dom.closest(".table-cell-wrapper")) {
      this.log("Refusing to bind an embedded table-cell editor");
      return this.inertSubEditor();
    }
    const fileInfo = this.editor.state.field(editorInfoField, false);
    if (!fileInfo || typeof fileInfo !== "object") return false;
    if (fileInfo instanceof MarkdownView) return false;
    const subpath = (fileInfo as { subpath?: unknown }).subpath;
    const fragmentScoped = typeof subpath === "string" && subpath.length > 0;
    if (!fragmentScoped) {
      const connectionManager = getConnectionManager(this.editor);
      // A canvas editor is not an embed-owned sub-editor: it is the surface a
      // person types into. A text card's editor carries its node in its own
      // CM6 state, so findCanvas names it. A file embed's editor carries no
      // such field and can only be named by the node that renders it —
      // without this second hatch it falls through and is marked inert
      // permanently, which is what stops it ever binding to its document.
      if (connectionManager?.findCanvas(this.editor) !== undefined) return false;
      if (connectionManager?.findCanvasEmbed?.(this.editor) !== undefined) {
        return false;
      }
      // Not yet attached: refuse for now, but without latching, so the editor
      // can be reconsidered once the canvas has wired it up.
      if (!this.editor.dom.isConnected) return true;
    }
    this.debug(
      fragmentScoped
        ? `Refusing to bind a fragment-scoped embed editor (${String(subpath)})`
        : "Refusing to bind an embed-owned editor",
    );
    return this.inertSubEditor();
  }

  /** Permanently inert this instance and drop any buffered fragment input. */
  private inertSubEditor(): boolean {
    this.subEditor = true;
    if (this.cm6Integration) {
      this.cm6Integration.destroy();
      this.cm6Integration = null;
    }
    this.clearPendingEdits();
    this.document = null;
    return true;
  }

  /**
   * The EditorView that this editor's owner considers its editor, when
   * resolvable. A view's own editor is the one this names — positive
   * adoption. A table-cell editor inherits its host's editorInfoField, so
   * the field resolves to the HOST view and names the host's EditorView,
   * never this one. (An embed-owned editor names itself here — the embed's
   * editor getter resolves to its own edit mode — which is why adoption
   * alone cannot admit an editor; the owner-kind check in probeSubEditor
   * runs first.) Returns null when the owner's editor is not resolvable.
   */
  private ownerEditorView(): EditorView | null {
    try {
      const fileInfo = this.editor.state.field(editorInfoField, false);
      const ownerEditor = fileInfo?.editor as
        | { cm?: EditorView }
        | undefined;
      return ownerEditor?.cm ?? null;
    } catch {
      return null;
    }
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
      if (this.probeSubEditor()) return false;
      const fileInfo = this.editor.state.field(editorInfoField, false);
      if (fileInfo?.file) {
        const doc = this.resolveCurrentDocument();
        if (doc) {
          // Born-attached is the one bind that skips the positive identity
          // check against the view registry, so the probe itself must prove
          // this view is a view's own editor. File identity, the info
          // field, and source-view ancestry cannot: an embedded sub-editor
          // (a table-cell editor) matches its host on all three. The proof
          // is positive adoption: the owning view names this EditorView as
          // its editor. Obsidian assigns a view's editor before extensions
          // can instantiate (the EditorView is created once in the editor's
          // constructor and never replaced; MarkdownView.editor resolves
          // through it live), so a view's own editor passes here at
          // creation, while a table-cell editor names the host's editor and
          // never passes. Anything short of adoption — a different editor
          // or an unresolvable one — leaves the decision open rather than
          // deciding false, and the retry paths re-probe when the owner's
          // editor identity changes.
          const ownerCm = this.ownerEditorView();
          if (ownerCm !== this.editor) {
            return false;
          }
          const sourceView = this.editor.dom.closest(".markdown-source-view");
          const embed = !!sourceView?.classList.contains("mod-inside-iframe");
          this.bornAttached =
            !embed && doc.hsm !== null && doc.hsm.matches("active.tracking");
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
    if (this.cm6Integration) return true;
    if (this.destroyed) return false;
    if (this.probeSubEditor()) return false;

    const connectionManager = getConnectionManager(this.editor);
    if (!connectionManager) return false;

    // Registered canvas editors have no MarkdownView wrapper and do not
    // auto-save. Registry membership is the same positive proof used by the
    // owner allow-list and does not depend on DOM attachment timing.
    this.embed =
      connectionManager.findCanvas(this.editor) !== undefined ||
      connectionManager.findCanvasEmbed?.(this.editor) !== undefined;

    this.document = this.resolveCurrentDocument();
    if (!this.document) return false;

    const hsm = this.document.hsm;
    if (!hsm) return false;

    // Verify the HSM's Document matches the editor's file.
    // When multiple SharedFolders have the same relative path, ensure the
    // editor connects to the HSM for its actual file.
    const fileInfo = this.editor.state.field(editorInfoField, false);
    const editorFile = fileInfo?.file ?? this.embeddedNodeFile(connectionManager);

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
    // born-attached view that LiveViews has not adopted yet, validity is keyed
    // off file identity instead; once LiveViews has adopted the editor, the
    // stricter identity check owns validity permanently.
    const expectedFile = editorFile;
    let adoptedByLiveView = false;
    this.cm6Integration = new CM6Integration(hsm, this.editor, () => {
      // Until the born-attached render replaces the stale buffer, the editor
      // is not a valid dispatch target: document-side changes arriving in
      // this window are already part of the text the render will install.
      if (this.bornAttachedRenderPending) return false;
      if (this.isCurrentEditorInstance(expectedGuid)) {
        adoptedByLiveView = true;
        return true;
      }
      if (!bornAttached || adoptedByLiveView) return false;
      return this.isEditorShowingFile(expectedGuid, expectedFile);
    });
    this.debug(`Initialized for ${this.document.guid} (embed: ${this.embed})`);

    const currentText = this.editor.state.doc.toString();

    if (bornAttached) {
      // Born attached: render the authoritative document text directly and
      // rebase any pre-bind input onto it. The buffered replay below never
      // runs on this path — with an attached sibling view, the save/reload
      // echo is a second delivery channel for the same keystrokes, and
      // replaying a buffer next to it can apply them twice.
      this.renderBornAttached(hsm, expectedGuid);
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
  private renderBornAttached(hsm: MergeHSM, expectedGuid: string): void {
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
      // Re-verify eligibility at fire time. A sub-editor discriminator may
      // become available only after the bind (a container attached late);
      // ancestry and owner kind make the instance permanently inert. The
      // bind required positive owner adoption, so an owner that no longer
      // names this editor means the view replaced its editor between bind
      // and render; that refusal stays retryable for legitimate adoption.
      if (this.probeSubEditor()) {
        abort("embedded sub-editor");
        return;
      }
      const ownerCm = this.ownerEditorView();
      if (ownerCm !== this.editor) {
        abort("owner view no longer adopts this editor");
        if (this.cm6Integration) {
          this.cm6Integration.destroy();
          this.cm6Integration = null;
        }
        this.clearPendingEdits();
        this.document = null;
        this.bornAttached = null;
        this.lastInitializationRetry = null;
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
    if (this.destroyed || this.subEditor) return;
    if (update.docChanged) {
      this.lastInitializationRetry = null;
    }

    // Skip editors that are definitively outside a shared folder. During file
    // open, editorInfoField can still be unset while the CM6 buffer already
    // accepts input. Preserve document changes from that unidentified window;
    // a later set transaction will rebase them onto the populated file.
    if (!this.cm6Integration && !this.isLiveEditor() && !this.resolveCurrentDocument()) {
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

    // An embed's editor is replaced when Obsidian re-renders the node. The
    // superseded instance still resolves the same document, so the document
    // check below cannot see it — but the node names exactly one editor as
    // its own, and anything else is stale. Leaving it bound leaves two
    // integrations bootstrapping one document against each other.
    if (this.embed && this.cm6Integration) {
      const manager = getConnectionManager(this.editor);
      if (
        manager &&
        manager.findCanvas(this.editor) === undefined &&
        manager.findCanvasEmbed?.(this.editor) === undefined
      ) {
        this.resetForDocumentChange(null);
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
        const live = this.isLiveEditor();
        const owner = this.ownerEditorView();
        const connected = this.editor.dom.isConnected;
        const canvas =
          getConnectionManager(this.editor)?.findCanvas(this.editor) !== undefined;
        const canvasEmbed =
          getConnectionManager(this.editor)?.findCanvasEmbed?.(this.editor) !== undefined;
        const prior = this.lastInitializationRetry;
        if (
          !prior ||
          prior.file !== file ||
          prior.live !== live ||
          prior.owner !== owner ||
          prior.connected !== connected ||
          prior.canvas !== canvas ||
          prior.canvasEmbed !== canvasEmbed
        ) {
          this.lastInitializationRetry = {
            file,
            live,
            owner,
            connected,
            canvas,
            canvasEmbed,
          };
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
    this.cm6Integration.onEditorUpdate(update);

    // A bound embed needs no save of its own. Its edits reach the document
    // through this integration, and the document's own machine writes disk.
    // Asking the document to save here re-renders the canvas node, which
    // replaces the editor and discards the buffer being typed into — the
    // save lands, and the text the person just wrote does not.
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
    this.clearPendingEdits();
    this.document = null;
    this.editor = null as unknown as typeof this.editor;
  }
}

/**
 * The HSMEditorPlugin ViewPlugin for CodeMirror 6.
 *
 * Add this to the editor extensions to enable editor→HSM sync:
 *   extensions: [HSMEditorPlugin, ...]
 */
export const HSMEditorPlugin = ViewPlugin.fromClass(HSMEditorPluginValue);
