// Code in this file has been adapted from y-codemirror.next
// License
// [The MIT License](./LICENSE) © Kevin Jahns

import type { ChangeSpec } from "@codemirror/state";
import { EditorView, ViewUpdate, ViewPlugin } from "@codemirror/view";
import type { PluginValue } from "@codemirror/view";
import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { curryLog } from "src/debug";
import type { CanvasNodeData } from "src/CanvasView";
import { isCanvas, type Canvas } from "../Canvas";
import { getSharedFolders } from "../editorContext";

// Import from shared location
import { ySyncAnnotation } from "../merge-hsm/integration/annotations";

export class LiveNodePluginValue implements PluginValue {
	editor: EditorView;
	canvas?: Canvas;
	initialSet = false;
	private destroyed = false;
	_observer?: (event: YTextEvent, tr: Transaction) => void;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	_ytext?: YText;
	keyFrameCounter = 0;
	debug: (...args: unknown[]) => void = (...args: unknown[]) => {};
	log: (...args: unknown[]) => void = (...args: unknown[]) => {};
	warn: (...args: unknown[]) => void = (...args: unknown[]) => {};
	embed = false;
	node?: CanvasNodeData;

	private getNode() {
		const state = (this.editor.state as any).values.find((state: any) => {
			if (state && state.node) return state.node;
		});
		if (!state) return;
		this.node = state.node;
		return this.node;
	}

	private resolveCanvas(): Canvas | undefined {
		const state = (this.editor.state as any).values.find((state: any) => {
			if (state && state.node) return state.node;
		});
		if (!state) return;
		const canvasFile = state.node.canvas?.file;
		if (!canvasFile) return;
		const sharedFolders = getSharedFolders(this.editor);
		if (!sharedFolders) return;
		const folder = sharedFolders.lookup(canvasFile.path);
		if (!folder) return;
		const file = folder.getFile(canvasFile);
		if (file && isCanvas(file)) return file;
		return;
	}

	private getYText(): YText | undefined {
		this.canvas = this.resolveCanvas();

		const state = (this.editor.state as any).values.find((state: any) => {
			if (state && state.node) return state.node;
		});
		if (!state) {
			if (this.observer) this._ytext?.unobserve(this.observer);
			return;
		}
		if (state.node.id !== this.node?.id && this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.node = state.node;
		return this.canvas?.textNode(state.node);
	}

	constructor(editor: EditorView) {
		this.editor = editor;
		this.canvas = this.resolveCanvas();
		this.node = this.getNode();
		this._ytext = this.getYText();
		if (!this._ytext) {
			return;
		}
		if (!this.canvas) {
			return;
		}
		this.log = curryLog(
			`[LiveNodePluginValue][${this.canvas.path}#${this.node?.id}]`,
			"log",
		);
		this.warn = curryLog(
			`[LiveNodePluginValue][${this.canvas.path}#${this.node?.id}]`,
			"warn",
		);
		this.debug = curryLog(
			`[LiveNodePluginValue][${this.canvas.path}#${this.node?.id}]`,
			"debug",
		);
		this.debug("created");

		this._observer = async (event, tr) => {
			this._ytext = this.getYText();

			if (this.destroyed) {
				this.debug("Recived yjs event but editor was destroyed");
				return;
			}

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
				if (this.canvas) {
					editor.dispatch({
						changes,
						annotations: [ySyncAnnotation.of(this.editor)],
					});
				}
			}
		};

		this.observer = (event, tr) => {
			try {
				this._observer?.(event, tr);
			} catch (e) {
				if (e instanceof RangeError) {
					console.warn("range errors!");
				}
			}
		};
		this._ytext.observe(this.observer);
	}

	update(update: ViewUpdate): void {
		// When updates were made to the local editor. Forwarded to the ydoc.
		if (
			!update.docChanged ||
			(update.transactions.length > 0 &&
				update.transactions[0].annotation(ySyncAnnotation) === this.editor)
		) {
			return;
		}
		const ytext = this.getYText();
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
		this.destroyed = true;
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.canvas = undefined;
		this._ytext = undefined;
		this.editor = null as any;
	}
}

export const LiveNode = ViewPlugin.fromClass(LiveNodePluginValue);
