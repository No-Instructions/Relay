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
import { around } from "monkey-around";

const TWEENS = 25;

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
	private destroyed = false;
	_observer?: (event: YTextEvent, tr: Transaction) => void;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	_ytext?: YText;
	keyFrameCounter = 0;
	private uninstallMonkeyPatch?: () => void;
	debug: (...args: unknown[]) => void = (...args: unknown[]) => {};
	log: (...args: unknown[]) => void = (...args: unknown[]) => {};
	warn: (...args: unknown[]) => void = (...args: unknown[]) => {};

	constructor(editor: EditorView) {
		this.editor = editor;
		this.connectionManager = this.editor.state.field(
			ConnectionManagerStateField,
		);
		this.view = this.connectionManager?.findView(editor);
		if (!this.view) {
			return;
		}
		this.log = curryLog(
			`[LiveCMPluginValue][${this.view.view.file?.path}]`,
			"log",
		);
		this.warn = curryLog(
			`[LiveCMPluginValue][${this.view.view.file?.path}]`,
			"warn",
		);
		this.debug = curryLog(
			`[LiveCMPluginValue][${this.view.view.file?.path}]`,
			"debug",
		);

		this.debug("created");
		if (!this.view.document) {
			return;
		}

		if (this.view.view.file !== this.view.document.tfile) {
			console.error("file mismatch!!!");
		}

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const liveEditPlugin = this;

		this.uninstallMonkeyPatch = around(this.view.view, {
			setViewData(old) {
				return function (data: string, clear: boolean) {
					if (clear) {
						if (isLive(liveEditPlugin.view)) {
							liveEditPlugin.view.contents = data;
						}
						liveEditPlugin.resync();
					} else {
						console.warn("setViewData", data);
					}
					// @ts-ignore
					return old.call(this, data, clear);
				};
			},
		});

		this.view.document.whenSynced().then(() => {
			this.resync();
		});

		this.view.document.onceConnected().then(() => {
			this.resync();
		});

		this._observer = async (event, tr) => {
			if (!isLive(this.view)) {
				this.debug("Recived yjs event against a non-live view");
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
				if (!this.view.tracking || this.keyFrameCounter > TWEENS) {
					this.keyFrameCounter = 0;
					changes = await this.getKeyFrame();
					this.debug(`dispatch (full)`);
				} else {
					this.keyFrameCounter += 1;
					this.debug(`dispatch (incremental + ${this.keyFrameCounter})`);
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

	async resync() {
		if (isLive(this.view) && !this.view.tracking && !this.destroyed) {
			await this.view.document.whenSynced();
			const keyFrame = await this.getKeyFrame();
			if (isLive(this.view) && !this.view.tracking && !this.destroyed) {
				this.editor.dispatch({
					changes: keyFrame,
					annotations: [ySyncAnnotation.of(this)],
				});
			}
		}
	}

	async getKeyFrame(): Promise<ChangeSpec[]> {
		// goal: sync editor state to ytext state so we can accept delta edits.
		if (!isLive(this.view) || this.destroyed) {
			return [];
		}

		if (this.view.contents === undefined) {
			this.view.contents = this.view.view.getViewData();
			return [];
		}

		if (this.view.document.text === this.view.contents) {
			// disk and ytext were already the same.
			this.view.tracking = true;
			return [];
		} else {
			this.warn(`|${this.view.document.text}|\n|${this.view.contents}|`);
		}

		this.warn(`ytext and editor buffer need syncing`);
		if (!this.view.document.hasLocalDB() && this.view.document.text === "") {
			this.warn("local db missing, not setting buffer");
			return [];
		}

		// disk and ytext differ
		if (!this.view.tracking) {
			await this.view.checkStale();
		}

		if (isLive(this.view) && !this.destroyed) {
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
		this.destroyed = true;
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		if (this.uninstallMonkeyPatch) {
			this.uninstallMonkeyPatch();
			this.uninstallMonkeyPatch = undefined;
		}
		this.connectionManager = null as any;
		this.view = undefined;
		this._ytext = undefined;
		this.editor = null as any;
	}
}

export const LiveEdit = ViewPlugin.fromClass(LiveCMPluginValue);
