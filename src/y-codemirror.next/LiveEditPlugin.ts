// Code in this file has been adapted from y-codemirror.next
// License
// [The MIT License](./LICENSE) © Kevin Jahns

import { Facet, Annotation } from "@codemirror/state";
import type { ChangeSpec } from "@codemirror/state";
import { EditorView, ViewUpdate, ViewPlugin } from "@codemirror/view";
import type { PluginValue } from "@codemirror/view";
import {
	type S3View,
	LiveViewManager,
	isLive,
	ConnectionManagerStateField,
} from "../LiveViews";
import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { curryLog } from "src/debug";
import { withFlag } from "src/flagManager";
import { flag } from "src/flags";

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
	connectionManager?: LiveViewManager;
	initialSet = false;
	_observer?: (event: YTextEvent, tr: Transaction) => void;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	_ytext?: YText;
	log: (message: string) => void = (message: string) => {};

	constructor(editor: EditorView) {
		this.editor = editor;
		this.connectionManager = this.editor.state.field(
			ConnectionManagerStateField,
		);
		this.view = this.connectionManager?.findView(editor);
		if (!this.view) {
			return;
		}
		this.log = curryLog(`[LiveCMPluginValue][${this.view.view.file?.path}]`);
		this.log("created");
		if (!this.view.document) {
			return;
		}
		this.view.document.whenSynced().then(async () => {
			if (isLive(this.view) && !this.view.tracking) {
				this.editor.dispatch({
					changes: await this.getKeyFrame(),
					annotations: [ySyncAnnotation.of(this)],
				});
			}
		});

		this._observer = async (event, tr) => {
			if (!isLive(this.view)) {
				this.log("Recived yjs event against a non-live view");
				return;
			}

			// Called when a yjs event is received. Results in updates to codemirror.
			if (tr.origin !== this) {
				const delta = event.delta;
				let changes: ChangeSpec[] = [];
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
				if (!this.view.tracking) {
					changes = await this.getKeyFrame();
					this.log(`dispatch (full)`);
				} else {
					this.log("dispatch (incremental)");
				}
				editor.dispatch({
					changes,
					annotations: [ySyncAnnotation.of(this)],
				});
				this.view.tracking = true;
			}
		};

		this.observer = (event, tr) => {
			try {
				this._observer?.(event, tr);
			} catch (e) {
				if (e instanceof RangeError) {
					if (isLive(this.view)) {
						this.view.tracking = false;
						this._observer?.(event, tr);
					}
				}
			}
		};
		this._ytext = this.view.document.ytext;
		this._ytext.observe(this.observer);
	}

	public getBufferChange(buffer: string) {
		return {
			from: 0,
			to: this.editor.state.doc.length,
			insert: buffer,
		};
	}

	async getKeyFrame(): Promise<ChangeSpec[]> {
		// goal: sync editor state to ytext state so we can accept delta edits.
		if (!isLive(this.view)) {
			return [];
		}
		const contents = this.editor.state.doc.toString();
		await this.view.document.whenSynced();

		if (this.view.document.text === contents) {
			// disk and ytext were already the same.
			this.view.tracking = true;
			return [];
		}

		this.log(`ytext and editor buffer need syncing`);
		if (!this.view.document.hasLocalDB() && this.view.document.text === "") {
			this.log("local db missing, not setting buffer");
			return [];
		}

		// disk and ytext differ
		if (!this.view.tracking) {
			await this.view.checkStale();
		}

		if (isLive(this.view)) {
			return [this.getBufferChange(this.view.document.text)];
		}
		return [];
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
		this.view = this.connectionManager?.findView(editor);
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
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.connectionManager = null as any;
		this.view = undefined;
		this._ytext = undefined;
		this.editor = null as any;
	}
}

export const LiveEdit = ViewPlugin.fromClass(LiveCMPluginValue);
