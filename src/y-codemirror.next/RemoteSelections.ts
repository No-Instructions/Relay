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

import {
	LiveViewManager,
	LiveView,
	ConnectionManagerStateField,
} from "../LiveViews";

import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness.js";
import { curryLog } from "src/debug";
import { TextFileView, editorInfoField } from "obsidian";
import { Document } from "../Document";

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
	origin: any, // The type of origin can be very broad, depending on what triggered the change.
	awareness: Awareness,
) => void;

export class YRemoteSelectionsPluginValue implements PluginValue {
	editor: EditorView;
	connectionManager?: LiveViewManager;
	view?: LiveView<TextFileView>;
	decorations: DecorationSet;
	_awareness?: Awareness;
	_listener?: AwarenessChangeHandler;
	document?: Document;
	private destroyed = false;

	constructor(editor: EditorView) {
		this.editor = editor;
		this.decorations = RangeSet.of([]);
		this.connectionManager = this.editor.state.field(
			ConnectionManagerStateField,
		);

		// Allowlist: Check for live editing markers (same as LiveEditPlugin)
		const sourceView = this.editor.dom.closest(".markdown-source-view");
		const isLiveEditor = this.editor.dom.closest(".relay-live-editor");
		const hasIframeClass = sourceView?.classList.contains("mod-inside-iframe");

		// For embedded canvas editors, we can't always find the canvas via ConnectionManager
		// but if it has mod-inside-iframe, it's likely a legitimate embedded editor
		const isEmbeddedInCanvas = hasIframeClass;

		if (!isLiveEditor && !isEmbeddedInCanvas) {
			this.destroyed = true;
			return;
		}

		this.view = this.connectionManager?.findView(editor);
		if (this.view && this.view instanceof LiveView) {
			const provider = this.view.document?._provider;
			this._listener = ({ added, updated, removed }, s, t) => {
				const clients = added.concat(updated).concat(removed);
				if (
					clients.findIndex((id) => id !== this._awareness?.doc.clientID) >= 0
				) {
					editor.dispatch({
						annotations: [yRemoteSelectionsAnnotation.of([])],
					});
				}
			};
			if (provider) {
				this._awareness = provider.awareness;
				this._awareness.on("change", this._listener);
			}
		}
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
				this.document = folder.proxy.getDoc(file.path);
				return this.document;
			}
		}
		
		// Fallback to using view
		this.view = this.connectionManager?.findView(this.editor);
		return this.view?.document;
	}

	destroy() {
		this.destroyed = true;
		if (this._listener) {
			this._awareness?.off("change", this._listener);
			this._listener = undefined;
		}
		this.connectionManager = null as any;
		this.view = null as any;
		this.editor = null as any;
	}

	update(update: ViewUpdate) {
		if (this.destroyed) {
			return;
		}
		const editor: EditorView = update.view;
		this.document = this.getDocument();
		const ytext = this.document?.ytext;
		if (!(this.document && ytext && ytext.doc)) {
			return;
		}
		const provider = this.document._provider;
		if (!provider) {
			return;
		}
		this._awareness = provider.awareness;
		const awareness = this._awareness;

		const ydoc: Y.Doc = ytext.doc;
		const decorations: Array<Range<Decoration>> = [];
		const localAwarenessState = this._awareness.getLocalState();

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
							// eslint-disable-next-line no-mixed-spaces-and-tabs
						);
			const currentHead =
				localAwarenessState.cursor == null
					? null
					: Y.createRelativePositionFromJSON(
							localAwarenessState.cursor.head,
							// eslint-disable-next-line no-mixed-spaces-and-tabs
						);

			if (sel != null) {
				const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
				const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
				if (
					localAwarenessState.cursor == null ||
					!Y.compareRelativePositions(currentAnchor, anchor) ||
					!Y.compareRelativePositions(currentHead, head)
				) {
					awareness.setLocalStateField("cursor", {
						anchor,
						head,
					});
				}
			} else if (localAwarenessState.cursor != null && hasFocus) {
				awareness.setLocalStateField("cursor", null);
			}
		}

		// update decorations (remote selections)
		awareness.getStates().forEach((state, clientid) => {
			if (clientid === awareness.doc.clientID) {
				return;
			}
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
			const { color = "#30bced", name = "Anonymous" } = state.user || {};
			const colorLight = (state.user && state.user.colorLight) || color + "33";
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
