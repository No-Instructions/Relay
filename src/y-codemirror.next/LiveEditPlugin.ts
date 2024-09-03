// Code in this file has been adapted from y-codemirror.next
// License
// [The MIT License](./LICENSE) © Kevin Jahns

import { Facet, Annotation } from "@codemirror/state";
import type { ChangeSpec } from "@codemirror/state";
import { EditorView, ViewUpdate, ViewPlugin } from "@codemirror/view";
import type { PluginValue } from "@codemirror/view";
import { type S3View, LiveViewManager } from "../LiveViews";
import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { curryLog } from "src/debug";

export const connectionManagerFacet: Facet<LiveViewManager, LiveViewManager> =
	Facet.define({
		combine(inputs) {
			return inputs[inputs.length - 1];
		},
	});

export const ySyncAnnotation = Annotation.define();

export class LiveCMPluginValue implements PluginValue {
	editor: EditorView;
	view?: S3View;
	connectionManager: LiveViewManager;
	_observer?: (event: YTextEvent, tr: Transaction) => void;
	_ytext?: YText;
	log: (message: string) => void = (message: string) => {};

	constructor(editor: EditorView) {
		this.editor = editor;
		this.connectionManager = this.editor.state.facet(connectionManagerFacet);
		this.view = this.connectionManager.findView(editor);
		this.editor = editor;
		if (!this.view) {
			return;
		}
		this.log = curryLog(`[LiveCMPluginValue][${this.view.view.file?.path}]`);
		this.log("created");
		if (!this.view.document) {
			return;
		}
		this.view.plugin = this;
		this.view.document.whenSynced().then(() => {
			this.setBuffer();
			this.view?.view.requestSave();
		});

		this._observer = (event, tr) => {
			// Called when a yjs event is received. Results in updates to codemirror.
			if (tr.origin !== this) {
				const delta = event.delta;
				const changes: ChangeSpec[] = [];
				let pos = 0;
				for (let i = 0; i < delta.length; i++) {
					const d = delta[i];
					if (d.insert != null) {
						changes.push({
							from: pos,
							to: pos,
							insert: d.insert as string,
						});
					} else if (d.delete != null) {
						changes.push({
							from: pos,
							to: pos + d.delete,
							insert: "",
						});
						pos += d.delete;
					} else if (d.retain != null) {
						pos += d.retain;
					}
				}
				this.log("dispatch");
				editor.dispatch({
					changes,
					annotations: [ySyncAnnotation.of(this)],
				});
			}
		};
		this._ytext = this.view.document.ytext;
		this._ytext.observe(this._observer);
	}

	setBuffer(): boolean {
		if (
			this.view?.document &&
			this.view?.document.text !== this.editor.state.doc.toString()
		) {
			this.log(`setting buffer ${this.view?.document} ${this.editor}`);
			this.editor.dispatch({
				changes: {
					from: 0,
					to: this.editor.state.doc.length,
					insert: this.view.document.text,
				},
				annotations: [ySyncAnnotation.of(this)], // this should be ignored by the update handler
			});
			return true;
		}
		return false;
	}

	update(update: ViewUpdate): void {
		// When updates were made to the local editor. Forwarded to the ydoc.
		if (
			!update.docChanged ||
			(update.transactions.length > 0 &&
				update.transactions[0].annotation(ySyncAnnotation) === this)
		) {
			return;
		}
		const editor: EditorView = update.view;
		this.view = this.connectionManager.findView(editor);
		const ytext = this.view?.document?.ytext;
		if (!ytext) {
			return;
		}
		ytext.doc?.transact(() => {
			/**
			 * This variable adjusts the fromA position to the current position in the Y.Text type.
			 */
			let adj = 0;
			update.changes.iterChanges((fromA, toA, fromB, toB, insert) => {
				const insertText = insert.sliceString(0, insert.length, "\n");
				if (fromA !== toA) {
					ytext.delete(fromA + adj, toA - fromA);
				}
				if (insertText.length > 0) {
					ytext.insert(fromA + adj, insertText);
				}
				adj += insertText.length - (toA - fromA);
			});
		}, this);
	}

	destroy() {
		if (this._observer) {
			this._ytext?.unobserve(this._observer);
		}
	}
}

export const LiveEdit = ViewPlugin.fromClass(LiveCMPluginValue);
