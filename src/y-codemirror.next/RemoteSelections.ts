// Code in this file has been adapted from y-codemirror.next
// License
// [The MIT License](./LICENSE) © Kevin Jahns

import * as dom from "lib0/dom";
import * as pair from "lib0/pair";
import * as math from "lib0/math";
import { AnnotationType, Annotation, RangeSet, Range } from "@codemirror/state";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	WidgetType,
} from "@codemirror/view";

import type { PluginValue, DecorationSet } from "@codemirror/view";

import { getLiveViews } from "../editorContext";

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness.js";

/** The awareness fields the selection plugin reads from each peer. */
interface CursorAwarenessState {
	cursor?: { anchor: Y.RelativePosition; head: Y.RelativePosition } | null;
	user?: { color?: string; name?: string; colorLight?: string } | null;
}
import { curryLog } from "src/debug";
import { editorInfoField, type TFile } from "obsidian";
import { isDocument, type Document } from "../Document";
import type { CanvasNodeData } from "../CanvasView";
import { flags } from "../flagManager";

type LiveViewBridge = {
	document: Document;
};

/** A canvas view's model: the canvas's provider and the Y.Text behind each text card. */
type RelayCanvasViewBridge = {
	canvas: {
		_provider: { awareness: Awareness } | null;
		textNode(node: CanvasNodeData): Y.Text;
	};
};

type LiveViewManagerBridge = {
	findView(editor: EditorView): LiveViewBridge | undefined;
	findCanvas(editor: EditorView): RelayCanvasViewBridge | undefined;
	sharedFolders: {
		lookup(path: string): { getFile(file: TFile): unknown } | undefined;
	};
};

/**
 * What the plugin needs to publish and render carets: the awareness the
 * editor's peers share, the Y.Text the editor is bound to, and whether a
 * fork gate is holding local and remote apart so positions would not
 * resolve on peers. A markdown editor resolves through its Document; a
 * canvas text card through the canvas and the card's node.
 */
interface CaretTarget {
	awareness: Awareness;
	ytext: Y.Text;
	forked: boolean;
	/** True for a canvas text card, whose caret must be withdrawn when the card editor closes. */
	card: boolean;
}

function getConnectionManager(editor: EditorView): LiveViewManagerBridge | null {
	return getLiveViews(editor) as LiveViewManagerBridge | null;
}

export const yRemoteSelectionsTheme = EditorView.baseTheme({
	".cm-ySelection": {},
	".cm-yLineSelection": {
		padding: 0,
		margin: "0px 2px 0px 4px",
	},
	".cm-ySelectionCaret": {
		position: "relative",
		borderLeft: "1px solid black",
		borderRight: "1px solid black",
		marginLeft: "-1px",
		marginRight: "-1px",
		boxSizing: "border-box",
		display: "inline",
	},
	".cm-ySelectionCaretDot": {
		borderRadius: "50%",
		position: "absolute",
		width: ".4em",
		height: ".4em",
		top: "-.2em",
		left: "-.2em",
		backgroundColor: "inherit",
		transition: "transform .3s ease-in-out",
		boxSizing: "border-box",
	},
	".cm-ySelectionCaret:hover > .cm-ySelectionCaretDot": {
		transformOrigin: "bottom center",
		transform: "scale(0)",
	},
	".cm-ySelectionInfo": {
		position: "absolute",
		top: "-1.05em",
		left: "-1px",
		fontSize: ".75em",
		fontFamily: "serif",
		fontStyle: "normal",
		fontWeight: "normal",
		lineHeight: "normal",
		userSelect: "none",
		color: "white",
		paddingLeft: "2px",
		paddingRight: "2px",
		zIndex: 101,
		transition: "opacity .3s ease-in-out",
		backgroundColor: "inherit",
		// these should be separate
		opacity: 0,
		transitionDelay: "0s",
		whiteSpace: "nowrap",
	},
	".cm-ySelectionCaret:hover > .cm-ySelectionInfo": {
		opacity: 1,
		transitionDelay: "0s",
	},
});

/**
 * @todo specify the users that actually changed. Currently, we recalculate positions for every user.
 */
const yRemoteSelectionsAnnotation: AnnotationType<Array<number>> =
	Annotation.define();
export class YRemoteCaretWidget extends WidgetType {
	color: string;
	name: string;
	constructor(color: string, name: string) {
		super();
		this.color = color;
		this.name = name;
	}

	toDOM(editor: EditorView): HTMLElement {
		return <HTMLElement>(
			dom.element(
				"span",
				[
					pair.create("class", "cm-ySelectionCaret"),
					pair.create(
						"style",
						`background-color: ${this.color}; border-color: ${this.color}`,
					),
				],
				[
					dom.text("\u2060"),
					dom.element("div", [pair.create("class", "cm-ySelectionCaretDot")]),
					dom.text("\u2060"),
					dom.element(
						"div",
						[pair.create("class", "cm-ySelectionInfo")],
						[dom.text(this.name)],
					),
					dom.text("\u2060"),
				],
			)
		);
	}

	eq(widget: YRemoteCaretWidget) {
		return widget.color === this.color;
	}

	compare(widget: YRemoteCaretWidget) {
		return widget.color === this.color;
	}

	updateDOM() {
		return false;
	}

	get estimatedHeight() {
		return -1;
	}

	ignoreEvent() {
		return true;
	}
}

type AwarenessChangeEvent = {
	added: number[];
	updated: number[];
	removed: number[];
};

type AwarenessChangeHandler = (
	event: AwarenessChangeEvent,
	origin: unknown, // The type of origin can be very broad, depending on what triggered the change.
	awareness: Awareness,
) => void;

export class YRemoteSelectionsPluginValue implements PluginValue {
	editor: EditorView;
	connectionManager?: LiveViewManagerBridge;
	view?: LiveViewBridge;
	decorations: DecorationSet;
	_awareness?: Awareness;
	/** The instance the change listener is actually subscribed on. */
	private _boundAwareness?: Awareness;
	_listener?: AwarenessChangeHandler;
	document?: Document;
	/** True once this editor has published a card caret that must be withdrawn on close. */
	private publishedCardCaret = false;
	private destroyed = false;

	constructor(editor: EditorView) {
		this.editor = editor;
		this.decorations = RangeSet.of([]);
		this.connectionManager = getConnectionManager(this.editor) ?? undefined;

		// We do NOT check isLiveEditor() here and set destroyed=true, because the
		// relay-live-editor CSS class is added asynchronously by LiveViews after
		// acquireLock(). If we destroy here, the plugin will never initialize
		// when the class appears later. update() re-checks readiness on every
		// call instead of latching a permanent verdict here.
		if (this.isLiveEditor()) {
			this.ensureAwarenessListener();
		}
	}

	/**
	 * Check for either supported live-editing marker:
	 * the editor is inside a `.relay-live-editor` wrapper, or it's an embedded
	 * canvas editor (identified by `mod-inside-iframe` on its source view --
	 * we can't always find those via the connection manager).
	 */
	private isLiveEditor(): boolean {
		const sourceView = this.editor.dom.closest(".markdown-source-view");
		const isLiveEditor = this.editor.dom.closest(".relay-live-editor");
		const hasIframeClass = sourceView?.classList.contains("mod-inside-iframe");
		return !!(isLiveEditor || hasIframeClass);
	}

	/**
	 * Attach the awareness change listener that forces a redraw when a peer's
	 * cursor/selection moves without a local edit. Finding the view depends on
	 * LiveViews having attached, which can lag behind isLiveEditor() becoming
	 * true, so this is retried on every update until it succeeds.
	 */
	private ensureAwarenessListener() {
		if (this._listener) {
			return;
		}
		const awareness = this.resolveAwareness();
		if (!awareness) {
			return;
		}
		this._listener = ({ added, updated, removed }, s, t) => {
			// A captured listener can still fire after destroy() — e.g. when it
			// was attached to an awareness instance that was later superseded,
			// so destroy()'s off() call detached from the wrong instance. The
			// editor is gone by then; dispatching into it would throw, so a
			// stale callback is a no-op instead.
			if (this.destroyed || !this.editor) {
				return;
			}
			const clients = added.concat(updated).concat(removed);
			if (
				clients.findIndex((id) => id !== this._awareness?.doc.clientID) >= 0
			) {
				this.editor.dispatch({
					annotations: [yRemoteSelectionsAnnotation.of([])],
				});
			}
		};
		this.bindAwareness(awareness);
	}

	/**
	 * Only the awareness, without touching the text: a Document builds its
	 * remote doc and provider on first access to its text, and listener
	 * setup must not be what triggers that.
	 */
	private resolveAwareness(): Awareness | undefined {
		const document = this.getDocument();
		if (document) {
			return document._provider?.awareness;
		}
		if (!flags().enableCanvasPresence) return undefined;
		const node = this.getCardNode();
		const canvasView = node ? this.connectionManager?.findCanvas(this.editor) : undefined;
		return canvasView?.canvas._provider?.awareness;
	}

	/** The canvas text card this editor edits, when it is one. */
	private getCardNode(): CanvasNodeData | undefined {
		const values = (
			this.editor.state as unknown as { values?: Array<{ node?: CanvasNodeData }> }
		).values;
		return values?.find((value) => value && value.node)?.node;
	}

	/**
	 * Resolve what this editor publishes to and renders from. A markdown
	 * editor resolves through its Document, whose localDoc holds the text.
	 * A canvas text card resolves through the canvas view and the card's
	 * node: peers share the canvas's awareness, each card is its own
	 * top-level Y.Text keyed by node id, and relative positions carry that
	 * key, so carets in other cards resolve to other types and are skipped.
	 */
	private resolveTarget(): CaretTarget | null {
		const document = this.getDocument();
		if (document) {
			this.document = document;
			const ytext = document.localDoc?.getText("contents") ?? document.ytext;
			const awareness = document._provider?.awareness;
			if (!ytext || !ytext.doc || !awareness) return null;
			return {
				awareness,
				ytext,
				forked: document.hsm?.hasFork() ?? false,
				card: false,
			};
		}
		// Card carets are part of canvas presence.
		if (!flags().enableCanvasPresence) return null;
		const node = this.getCardNode();
		const canvasView = node ? this.connectionManager?.findCanvas(this.editor) : undefined;
		if (!node || !canvasView) return null;
		let ytext: Y.Text;
		try {
			ytext = canvasView.canvas.textNode(node);
		} catch {
			return null;
		}
		const awareness = canvasView.canvas._provider?.awareness;
		if (!ytext.doc || !awareness) return null;
		return { awareness, ytext, forked: false, card: true };
	}

	/**
	 * Keep the change listener on the awareness instance the plugin is
	 * currently rendering. The same editor is rebound to other documents by
	 * view reuse, and a document's provider can be rebuilt — either replaces
	 * the Awareness instance. If the field moved without the subscription,
	 * destroy() would unsubscribe from the new instance while the listener
	 * stayed registered on the old one, outliving the plugin.
	 *
	 * Subscription state is tracked separately from the rendered instance:
	 * the rendered instance can be recorded before the listener exists (the
	 * document resolves by folder lookup before the view registry catches
	 * up), and keying the subscription on instance identity alone would then
	 * skip attaching forever.
	 */
	private bindAwareness(awareness: Awareness) {
		this._awareness = awareness;
		if (!this._listener || this._boundAwareness === awareness) {
			return;
		}
		this._boundAwareness?.off("change", this._listener);
		awareness.on("change", this._listener);
		this._boundAwareness = awareness;
	}

	getDocument(): Document | undefined {
		const fileInfo = this.editor.state.field(editorInfoField);
		const file = fileInfo.file;
		
		if (file) {
			if (this.document?._tfile === file) {
				return this.document;
			}
			const folder = this.connectionManager?.sharedFolders.lookup(file.path);
			if (folder) {
				try {
					const doc = folder.getFile(file);
					if (isDocument(doc)) {
						this.document = doc;
						return this.document;
					}
				} catch {
					// No shared handle (membership refused or undecided):
					// fall through to the view fallback.
				}
			}
		}
		
		// Fallback to using view
		this.view = this.connectionManager?.findView(this.editor);
		return this.view?.document;
	}

	destroy() {
		this.destroyed = true;
		if (this.publishedCardCaret && this._awareness) {
			// A card editor closes when editing ends; a document's presence is
			// withdrawn with its lock, but a card's caret would otherwise stay
			// on peers until the whole canvas closed.
			try {
				if (this._awareness.getLocalState() !== null) {
					this._awareness.setLocalStateField("cursor", null);
				}
			} catch {
				// Presence is cosmetic; a throwing subscriber must not block teardown.
			}
			this.publishedCardCaret = false;
		}
		if (this._listener) {
			this._boundAwareness?.off("change", this._listener);
			this._listener = undefined;
		}
		this._boundAwareness = undefined;
		this._awareness = undefined;
		this.document = undefined;
		this.decorations = Decoration.none;
		this.connectionManager = null as unknown as typeof this.connectionManager;
		this.view = null as unknown as typeof this.view;
		this.editor = null as unknown as typeof this.editor;
	}

	update(update: ViewUpdate) {
		if (this.destroyed) {
			return;
		}
		// Readiness is re-checked on every update rather than latched once at
		// construction, since the relay-live-editor class can appear well
		// after this plugin is constructed (see isLiveEditor()).
		if (!this.isLiveEditor()) {
			return;
		}
		this.ensureAwarenessListener();
		const target = this.resolveTarget();
		if (!target) {
			return;
		}
		// Disable cursors when the fork gate is blocking local↔remote traffic.
		// Positions created from localDoc won't resolve correctly on remote peers
		// when the docs have diverged.
		if (target.forked) {
			this.decorations = Decoration.none;
			return;
		}
		this.bindAwareness(target.awareness);
		const { awareness, ytext } = target;
		const isCard = target.card;

		const ydoc: Y.Doc = ytext.doc as Y.Doc;
		const decorations: Array<Range<Decoration>> = [];
		const localAwarenessState =
			awareness.getLocalState() as CursorAwarenessState | null;

		// set local awareness state (update cursors)
		if (localAwarenessState != null) {
			const hasFocus =
				update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
			const sel = hasFocus ? update.state.selection.main : null;
			const currentAnchor =
				localAwarenessState.cursor == null
					? null
					: Y.createRelativePositionFromJSON(
							localAwarenessState.cursor.anchor,
						);
			const currentHead =
				localAwarenessState.cursor == null
					? null
					: Y.createRelativePositionFromJSON(
							localAwarenessState.cursor.head,
						);

			if (sel != null) {
				const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
				const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
				if (
					localAwarenessState.cursor == null ||
					!Y.compareRelativePositions(currentAnchor, anchor) ||
					!Y.compareRelativePositions(currentHead, head)
				) {
					// Defer awareness update to avoid re-entrant EditorView.update calls.
					// awareness.setLocalStateField emits synchronously, and listeners
					// may dispatch to the editor which is not allowed during update().
					if (isCard) this.publishedCardCaret = true;
					queueMicrotask(() => {
						awareness.setLocalStateField("cursor", {
							anchor,
							head,
						});
					});
				}
			} else if (localAwarenessState.cursor != null && hasFocus) {
				queueMicrotask(() => {
					awareness.setLocalStateField("cursor", null);
				});
			}
		}

		// update decorations (remote selections)
		awareness.getStates().forEach((rawState, clientid) => {
			if (clientid === awareness.doc.clientID) {
				return;
			}
			const state = rawState as CursorAwarenessState;
			const cursor = state.cursor;
			if (cursor == null || cursor.anchor == null || cursor.head == null) {
				return;
			}
			const anchor = Y.createAbsolutePositionFromRelativePosition(
				cursor.anchor,
				ydoc,
			);
			const head = Y.createAbsolutePositionFromRelativePosition(
				cursor.head,
				ydoc,
			);
			if (
				anchor == null ||
				head == null ||
				anchor.type !== ytext ||
				head.type !== ytext
			) {
				return;
			}
			if (
				anchor.index > update.state.doc.length ||
				head.index > update.state.doc.length
			) {
				curryLog(
					"[RemoteSelections]",
					"warn",
				)(
					`cursor positions (${anchor.index}, ${head.index}) out of range of document length: ${update.state.doc.length}`,
				);
				this.decorations = Decoration.none;
				return;
			}
			const { color = "#30bced", name = "Anonymous" } = state.user ?? {};
			const colorLight = state.user?.colorLight ?? color + "33";
			const start = math.min(anchor.index, head.index);
			const end = math.max(anchor.index, head.index);
			const startLine = update.view.state.doc.lineAt(start);
			const endLine = update.view.state.doc.lineAt(end);
			if (startLine.number === endLine.number) {
				// selected content in a single line.
				decorations.push({
					from: start,
					to: end,
					value: Decoration.mark({
						attributes: {
							style: `background-color: ${colorLight}`,
						},
						class: "cm-ySelection",
					}),
				});
			} else {
				// selected content in multiple lines
				// first, render text-selection in the first line
				decorations.push({
					from: start,
					to: startLine.from + startLine.length,
					value: Decoration.mark({
						attributes: {
							style: `background-color: ${colorLight}`,
						},
						class: "cm-ySelection",
					}),
				});
				// render text-selection in the last line
				decorations.push({
					from: endLine.from,
					to: end,
					value: Decoration.mark({
						attributes: {
							style: `background-color: ${colorLight}`,
						},
						class: "cm-ySelection",
					}),
				});
				for (let i = startLine.number + 1; i < endLine.number; i++) {
					const linePos = update.view.state.doc.line(i).from;
					decorations.push({
						from: linePos,
						to: linePos,
						value: Decoration.line({
							attributes: {
								style: `background-color: ${colorLight}`,
								class: "cm-yLineSelection",
							},
						}),
					});
				}
			}
			decorations.push({
				from: head.index,
				to: head.index,
				value: Decoration.widget({
					side: head.index - anchor.index > 0 ? -1 : 1, // the local cursor should be rendered outside the remote selection
					block: false,
					widget: new YRemoteCaretWidget(color, name),
				}),
			});
		});
		this.decorations = Decoration.set(decorations, true);
	}
}

export const yRemoteSelections = ViewPlugin.fromClass(
	YRemoteSelectionsPluginValue,
	{
		decorations: (v) => v.decorations,
	},
);
