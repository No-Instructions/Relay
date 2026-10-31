import { Compartment, EditorState, Prec, StateEffect, Text, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MarkdownView, Modal, Notice, TFile, type MarkdownSubView, type MarkdownViewModeType } from "obsidian";
import { buildConflict } from "../merge-hsm/conflictValue";
import { buildPickDocument, type PickDocument } from "../conflict-note/pick";
import { diffDecorations } from "../conflict-note/diff";
import { SituationBox } from "../conflict-note/SituationBox";
import { saveStashCopy, StashCopySavedError, type StashReviewSession } from "./session";

import { getPatcher } from "../Patcher";
import { diffTextChanges } from "../textChanges";
import { ySyncAnnotation } from "../merge-hsm/integration/annotations";
import { ownEditorSession, sessionOf, type NoteEditorSession } from "../conflict-note/editorSession";
import { finishMarkdownModeChanges, setMarkdownViewMode } from "../markdownViewMode";
interface NativeMarkdownModes {
	modes: { source: MarkdownSubView & { sourceMode: boolean; toggleSource(): void } };
	setMode(mode: MarkdownSubView): Promise<boolean>;
}

/** A temporary comparison in the original note's native editor. */
export class StashReviewNote implements NoteEditorSession {
	private layout?: PickDocument;
	private box?: SituationBox;
	private toolbar?: HTMLElement;
	private columnObserver?: ResizeObserver;
	private modal?: Modal;
	private readonly decorations = new Compartment();
	private showChanges = true;
	private plainSourceMode?: boolean;
	private busy = false;
	private closed = false;
	private updateQueued = false;
	private unsubscribe?: () => void;
	private unpatch?: () => void;
	private disown?: () => void;
	private readonly originalMode: MarkdownViewModeType;
	private readonly file: TFile;
	private readonly editor: EditorView;

	constructor(private readonly view: MarkdownView, private readonly review: StashReviewSession) {
		this.originalMode = view.getMode();
		this.file = view.file!;
		this.editor = (view.editor as unknown as { cm: EditorView }).cm;
	}
	private get app() { return this.view.app; }
	private get containerEl() { return this.view.containerEl; }
	private get contentEl() { return this.view.contentEl; }
	private holdsFile(): boolean { return !this.closed && this.view.file === this.file; }
	private ownsFile(): boolean { return this.holdsFile() && this.view.leaf.view === this.view; }
	liveText(): string { return this.review.liveText(); }

	async open(): Promise<void> {
		const review = this.review;
		this.disown = ownEditorSession(this.view, this.editor, this);
		const session = () => this;
		// Native autosave, explicit save and unload all read the current note.
		// A peer update still requests a save while the editor shows the stash.
		this.unpatch = getPatcher().patch(this.view, {
			getViewData(old: MarkdownView["getViewData"]) {
				return function (this: MarkdownView) { return session().holdsFile() ? session().liveText() : old.call(this); };
			},
			setViewData(old: MarkdownView["setViewData"]) {
				return function (this: MarkdownView, data: string, clear: boolean) {
					// Native save echoes update view.data, but must not replace
					// the comparison with the file's live content.
					if (!session().holdsFile()) return old.call(this, data, clear);
				};
			},
			setMode(old: NativeMarkdownModes["setMode"]) {
				return function (this: MarkdownView, mode: MarkdownSubView) {
					return old.call(this, session().ownsFile() ? (this as unknown as NativeMarkdownModes).modes.source : mode);
				};
			},
		});
		try {
			this.configureSourceMode(true);
			const native = this.view as unknown as NativeMarkdownModes;
			await native.setMode(native.modes.source);
			if (!this.ownsFile() || !review.stillHeld()) { this.restoreForUnload(); return; }
			this.layout = buildPickDocument(buildConflict({ situation: "no-baseline", base: null,
				ours: { source: "remote", text: review.current }, theirs: { source: "record", text: review.stash },
			}));
			this.present();
			this.containerEl.addClass("relay-stash-review");
			this.contentEl.addClass("relay-has-conflict-box");
			this.box?.destroy(); this.toolbar?.remove();
			const changes = this.layout.blocks.filter(block => block.kind !== "same").length;
			this.box = new SituationBox(this.contentEl, {
				title: "Stashed edits", text: `These edits were stashed when ${review.folderName} became read-only. They haven’t been shared. This comparison was captured when the pane opened.`,
				status: `${changes} change${changes === 1 ? "" : "s"}`,
			}, [
				{ label: "Save a copy", run: () => { void this.complete(true); } },
				{ label: "Discard stash", warning: true, run: () => this.confirmDiscard() },
			]);
			this.contentEl.prepend(this.box.element);
			this.toolbar = this.contentEl.createDiv({ cls: "relay-stash-toolbar" });
			this.box.element.after(this.toolbar);
			const label = this.toolbar.createEl("label", { cls: "relay-stash-toggle" });
			label.createSpan({ text: "Show changes" });
			const toggle = label.createDiv({ cls: "checkbox-container is-enabled" });
			const input = toggle.createEl("input", { type: "checkbox", attr: { "aria-label": "Show changes" } });
			input.checked = true;
			input.addEventListener("change", () => { toggle.toggleClass("is-enabled", input.checked); this.toggleChanges(input.checked); });
			this.alignNoteControls();
			this.unsubscribe = review.subscribe(() => this.queueUpdate());
			this.queueUpdate();
		} catch (error) {
			this.restoreForUnload();
			throw error;
		}
	}

	private queueUpdate(): void {
		if (this.closed || this.updateQueued) return;
		this.updateQueued = true;
		queueMicrotask(() => {
			this.updateQueued = false;
			if (!this.ownsFile()) return;
			this.view.requestSave();
			if (!this.review.stillHeld() && !this.busy) { void this.close(); return; }
			this.box?.setBusy(this.busy || !this.review.stillHeld());
		});
	}

	/** Obsidian can rebuild editor configuration while keeping the same note. */
	editorUpdated(): void {
		if (this.closed || !this.layout || this.decorations.get(this.editor.state) !== undefined) return;
		queueMicrotask(() => { if (this.ownsFile() && this.decorations.get(this.editor.state) === undefined) this.present(); });
	}

	private annotations() {
		return [ySyncAnnotation.of(this.editor), Transaction.addToHistory.of(false), Transaction.remote.of(true)];
	}

	private present(): void {
		if (!this.layout) return;
		const cm = this.editor, text = this.showChanges ? this.layout.doc : this.review.stash;
		const extension = [
			Prec.highest(EditorState.readOnly.of(true)), Prec.highest(EditorView.editable.of(false)),
			EditorState.changeFilter.of(() => false),
			EditorView.theme({ ".cm-cursorLayer": { display: "none" }, ".cm-content": { caretColor: "transparent" } }),
			this.showChanges ? EditorView.decorations.of(diffDecorations(Text.of(text.split("\n")), this.layout.blocks)) : [],
		];
		cm.dispatch({
			changes: diffTextChanges(cm.state.doc.toString(), text), filter: false,
			annotations: this.annotations(),
			effects: this.decorations.get(cm.state) === undefined
				? StateEffect.appendConfig.of(this.decorations.of(extension)) : this.decorations.reconfigure(extension),
		});
	}

	private cm(): EditorView { return this.editor; }
	private alignNoteControls(): void {
		this.columnObserver?.disconnect();
		const column = this.cm().contentDOM;
		const align = () => {
			const text = column.getBoundingClientRect();
			if (!column.isConnected || !text.width) return;
			const host = this.contentEl.getBoundingClientRect(), style = getComputedStyle(this.contentEl);
			const left = text.left - host.left - parseFloat(style.borderLeftWidth) - parseFloat(style.paddingLeft);
			// Follow the native editor's column, including its margins and scrollbar gutter.
			this.contentEl.style.setProperty("--relay-note-column-left", `${left}px`);
			this.contentEl.style.setProperty("--relay-note-column-width", `${text.width}px`);
		};
		this.columnObserver = new ResizeObserver(align);
		this.columnObserver.observe(this.contentEl);
		this.columnObserver.observe(this.cm().scrollDOM);
		this.columnObserver.observe(column);
		align();
	}
	private configureSourceMode(comparison: boolean): void {
		const source = (this.view as unknown as NativeMarkdownModes).modes.source;
		this.plainSourceMode ??= source.sourceMode;
		// Live Preview replaces callouts, tables and code blocks with widgets
		// that hide line decorations. Compare their Markdown rows, then restore
		// the native rendering preference when viewing the plain stash.
		if (source.sourceMode !== (comparison || this.plainSourceMode)) source.toggleSource();
	}
	private toggleChanges(on: boolean): void {
		if (!this.review || !this.layout || on === this.showChanges) return;
		const cm = this.cm(), before = cm.scrollDOM.scrollTop, text = on ? this.layout.doc : this.review.stash;
		const origin = cm.documentTop - cm.scrollDOM.getBoundingClientRect().top + before;
		let anchor = cm.state.doc.lineAt(cm.lineBlockAtHeight(Math.max(0, before - origin)).from);
		while ((!anchor.text.trim() || !text.includes(anchor.text)) && anchor.number < cm.state.doc.lines) anchor = cm.state.doc.line(anchor.number + 1);
		const relative = cm.lineBlockAt(anchor.from).top + origin - before, index = text.indexOf(anchor.text);
		this.showChanges = on;
		this.configureSourceMode(on);
		this.present();
		cm.requestMeasure({ read: view => index >= 0 ? view.lineBlockAt(index).top + view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop - relative : before,
			write: top => { cm.scrollDOM.scrollTop = before === 0 ? 0 : top; } });
	}

	private confirmDiscard(): void {
		if (this.busy || !this.review?.stillHeld()) return;
		const modal = this.modal = new Modal(this.app);
		modal.titleEl.setText("Discard stash?");
		modal.contentEl.createEl("p", { text: "The stashed edits will be discarded. The current note will stay open and continue receiving changes." });
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
		buttons.createEl("button", { text: "Discard stash", cls: "mod-warning" }).addEventListener("click", () => { modal.close(); void this.complete(false); });
		modal.open();
	}

	private async complete(copy: boolean): Promise<void> {
		if (!this.ownsFile() || this.busy || !this.review.stillHeld()) return;
		this.busy = true; this.box?.setBusy(true);
		try {
			let file: TFile | undefined;
			try {
				if (copy) file = await saveStashCopy(this.app, this.review);
				else await this.review.discard();
			} catch (error) {
				if (!(error instanceof StashCopySavedError)) throw error;
				new Notice(error.message);
				file = error.file;
			}
			if (!this.ownsFile()) return;
			await this.close();
			if (file && this.view.file === this.file && this.view.leaf.view === this.view) {
				await this.view.leaf.openFile(file, { active: true });
			}
		} catch (error) {
			new Notice(error instanceof Error ? error.message : "The stash could not be completed.");
		} finally { this.busy = false; this.queueUpdate(); }
	}

	private async close(): Promise<void> {
		this.restoreForUnload();
		if (this.view.file === this.file && this.view.leaf.view === this.view) {
			await setMarkdownViewMode(this.view, this.originalMode);
		}
	}

	/** Restore before the host reads an unloading note or Relay releases it. */
	restoreForUnload(): void {
		if (this.closed) return;
		const ownsFile = this.holdsFile();
		this.closed = true;
		this.unsubscribe?.(); this.unsubscribe = undefined;
		this.columnObserver?.disconnect();
		this.modal?.close(); this.box?.destroy(); this.toolbar?.remove();
		this.modal = undefined; this.box = undefined; this.toolbar = undefined;
		this.containerEl.removeClass("relay-stash-review");
		this.contentEl.removeClass("relay-has-conflict-box");
		this.contentEl.style.removeProperty("--relay-note-column-left");
		this.contentEl.style.removeProperty("--relay-note-column-width");
		try {
			const cm = this.editor;
			cm.dispatch({
				changes: ownsFile ? diffTextChanges(cm.state.doc.toString(), this.liveText()) : [],
				effects: this.decorations.get(cm.state) !== undefined ? this.decorations.reconfigure([]) : [],
				filter: false, annotations: this.annotations(),
			});
			if (ownsFile) this.configureSourceMode(false);
		} finally {
			this.disown?.(); this.disown = undefined;
			this.unpatch?.(); this.unpatch = undefined;
		}
	}
}

/** Reuse the original MarkdownView and leaf; no second note or workspace type. */
export async function openStashReview(view: MarkdownView, review: StashReviewSession): Promise<void> {
	const file = view.file;
	await finishMarkdownModeChanges(view);
	if (!file || view.file !== file || file.path !== review.sourcePath || !review.stillHeld() || sessionOf(view)) return;
	await new StashReviewNote(view, review).open();
}
