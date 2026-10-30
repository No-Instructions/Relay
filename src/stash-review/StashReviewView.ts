import { Compartment, EditorState, Prec, StateEffect, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MarkdownView, Modal, Notice, TFile, type App, type MarkdownSubView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { buildConflict } from "../merge-hsm/conflictValue";
import { buildPickDocument, type PickDocument } from "../conflict-note/pick";
import { diffDecorations } from "../conflict-note/diff";
import { SituationBox } from "../conflict-note/SituationBox";
import { saveStashCopy, StashCopySavedError, type StashReviewSession } from "./session";

export const STASH_REVIEW_VIEW = "relay-stash-review";
type ReviewState = { path?: string; review?: StashReviewSession };
interface NativeMarkdownModes {
	modes: { source: MarkdownSubView };
	setMode(mode: MarkdownSubView): Promise<boolean>;
}

/** A fileless native note pane: the stash and comparison never enter a vault file. */
export class StashReviewView extends MarkdownView {
	private review?: StashReviewSession;
	private layout?: PickDocument;
	private box?: SituationBox;
	private toolbar?: HTMLElement;
	private columnObserver?: ResizeObserver;
	private modal?: Modal;
	private readonly decorations = new Compartment();
	private showChanges = true;
	private busy = false;
	private generation = 0;
	private unsubscribe?: () => void;

	constructor(leaf: WorkspaceLeaf, private readonly resolve: (path: string) => StashReviewSession | null) {
		super(leaf);
		this.requestSave = () => {};
	}
	getViewType(): string { return STASH_REVIEW_VIEW; }
	getDisplayText(): string { return this.review ? `${this.review.sourcePath} — Stashed version` : "Stashed version"; }
	getIcon(): string { return "file-diff"; }
	// Opening a file must replace this fileless pane with its registered view.
	canAcceptExtension(_extension: string): boolean { return false; }
	getState(): Record<string, unknown> { return { path: this.review?.sourcePath }; }
	async save(): Promise<void> {}
	// Native commands also reach setMode; a comparison has no Markdown preview.
	async setMode(_mode: MarkdownSubView): Promise<boolean> {
		const native = this as unknown as NativeMarkdownModes;
		return (MarkdownView.prototype as unknown as NativeMarkdownModes).setMode.call(this, native.modes.source);
	}

	async setState(state: ReviewState, _result: ViewStateResult): Promise<void> {
		const generation = ++this.generation;
		this.unsubscribe?.(); this.unsubscribe = undefined;
		const review = state.review ?? (state.path ? this.resolve(state.path) : this.review);
		if (!review) {
			const file = state.path && this.app.vault.getAbstractFileByPath(state.path);
			if (file instanceof TFile) await this.leaf.openFile(file);
			else this.leaf.detach();
			return;
		}
		this.review = review;
		// FileView.setState opens a file or replaces the pane with EmptyView.
		// This pane owns no file, so select the native editor mode directly.
		const native = this as unknown as NativeMarkdownModes;
		await native.setMode(native.modes.source);
		if (generation !== this.generation) return;
		this.layout = buildPickDocument(buildConflict({ situation: "no-baseline", base: null,
			ours: { source: "remote", text: review.current }, theirs: { source: "record", text: review.stash },
		}), "diff");
		this.showChanges = true;
		this.setViewData(this.layout.doc, true);
		const cm = this.cm();
		if (cm.state.doc.toString() !== this.layout.doc) {
			cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: this.layout.doc }, filter: false });
		}
		const decorations = EditorView.decorations.of(diffDecorations(cm.state.doc, this.layout.blocks));
		cm.dispatch({ effects: this.decorations.get(cm.state) !== undefined
			? this.decorations.reconfigure(decorations)
			: StateEffect.appendConfig.of([
			Prec.highest(EditorState.readOnly.of(true)), Prec.highest(EditorView.editable.of(false)),
			EditorState.changeFilter.of(() => false),
			EditorView.theme({ ".cm-cursorLayer": { display: "none" }, ".cm-content": { caretColor: "transparent" } }),
			this.decorations.of(decorations),
		]) });
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
		this.containerEl.querySelectorAll<HTMLElement>(".inline-title").forEach(title => {
			title.textContent = review.sourcePath.split("/").pop()!.replace(/\.md$/i, "");
			title.contentEditable = "false";
		});
		this.alignNoteControls();
		this.unsubscribe = review.subscribe(() => {
			if (generation === this.generation) this.updateActions();
		});
		this.updateActions();
	}

	private updateActions(): void {
		const held = this.review?.stillHeld();
		this.box?.setBusy(this.busy || !held);
		if (!held) { this.modal?.close(); this.box?.setStatus("Stash no longer held"); }
	}

	private cm(): EditorView { return (this.editor as unknown as { cm: EditorView }).cm; }
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
	private toggleChanges(on: boolean): void {
		if (!this.review || !this.layout || on === this.showChanges) return;
		const cm = this.cm(), before = cm.scrollDOM.scrollTop, text = on ? this.layout.doc : this.review.stash;
		const origin = cm.documentTop - cm.scrollDOM.getBoundingClientRect().top + before;
		let anchor = cm.state.doc.lineAt(cm.lineBlockAtHeight(Math.max(0, before - origin)).from);
		while ((!anchor.text.trim() || !text.includes(anchor.text)) && anchor.number < cm.state.doc.lines) anchor = cm.state.doc.line(anchor.number + 1);
		const relative = cm.lineBlockAt(anchor.from).top + origin - before, index = text.indexOf(anchor.text);
		this.showChanges = on;
		cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text }, filter: false, effects: this.decorations.reconfigure(on ? EditorView.decorations.of(diffDecorations(Text.of(text.split("\n")), this.layout.blocks)) : []) });
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
		if (!this.review || this.busy || !this.review.stillHeld()) return;
		const generation = this.generation;
		this.busy = true; this.box?.setBusy(true);
		try {
			const review = this.review;
			let file;
			try {
				file = copy ? await saveStashCopy(this.app, review) : (await review.discard(), this.app.vault.getAbstractFileByPath(review.sourcePath));
			} catch (error) {
				if (!(error instanceof StashCopySavedError)) throw error;
				new Notice(error.message);
				file = error.file;
			}
			if (generation !== this.generation) return;
			if (file instanceof TFile) await this.leaf.openFile(file, { active: true });
			else this.leaf.detach();
		} catch (error) {
			new Notice(error instanceof Error ? error.message : "The stash could not be completed.");
		} finally { this.busy = false; this.updateActions(); }
	}

	async onClose(): Promise<void> {
		++this.generation;
		this.unsubscribe?.(); this.unsubscribe = undefined;
		this.columnObserver?.disconnect();
		this.contentEl.style.removeProperty("--relay-note-column-left");
		this.contentEl.style.removeProperty("--relay-note-column-width");
		this.modal?.close(); this.box?.destroy(); this.toolbar?.remove();
		this.modal = undefined; this.box = undefined; this.toolbar = undefined;
		await super.onClose();
	}
}

export async function openStashReview(app: App, review: StashReviewSession): Promise<void> {
	const existing = app.workspace.getLeavesOfType(STASH_REVIEW_VIEW).find(leaf => leaf.view.getState().path === review.sourcePath);
	const leaf = existing ?? app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: STASH_REVIEW_VIEW, active: true, state: { path: review.sourcePath, review } });
	await app.workspace.revealLeaf(leaf);
}
