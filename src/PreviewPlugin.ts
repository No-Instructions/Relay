import { HasLogging } from "src/debug";
import { Document } from "./Document";
import type { ChangeSpec } from "@codemirror/state";

import { type MarkdownView } from "obsidian";

import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { MetadataEditorPlugin } from "./MetadataEditorPlugin";
import { around } from "monkey-around";
import { diffMatchPatch } from "./y-diffMatchPatch";
import diff_match_patch from "diff-match-patch";

export class PreviewPlugin extends HasLogging {
	view: MarkdownView;
	_ytext: YText;
	unsubscribes: Array<() => void>;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	destroyed = false;
	metadataEditorPlugin?: MetadataEditorPlugin;
	savefm = false;

	constructor(
		previewView: MarkdownView,
		private document: Document,
	) {
		super();
		this.warn("created", this.document.path);
		this.view = previewView;

		this.metadataEditorPlugin = new MetadataEditorPlugin(this.view, document);

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const that = this;

		this.unsubscribes = [];
		this.unsubscribes.push(
			around(this.view, {
				// @ts-ignore
				save(old: any) {
					return function (data: any) {
						// @ts-ignore
						const result = old.call(this, data);
						try {
							if (
								that.view.getMode() === "preview" &&
								that.metadataEditorPlugin?.saving
							) {
								diffMatchPatch(
									that.document.ydoc,
									// @ts-ignore
									that.view.text,
									that.document,
								);
							}
						} catch (e) {
							that.error(e);
						}
						return result;
					};
				},
			}),
		);
		this.unsubscribes.push(
			around(this.view.previewMode as any, {
				edit(old) {
					return function (data: string) {
						if (that.view.getMode() === "preview") {
							if (that.view.editor) {
								const changes = that.incrementalBufferChange(data);
								// @ts-ignore
								that.view.editor.cm.dispatch({
									changes,
								});
							} else {
								diffMatchPatch(
									that.document.ydoc,
									// @ts-ignore
									data,
									that.document,
								);
							}
						}

						// @ts-ignore
						return old.call(this, data);
					};
				},
			}),
		);
		this.observer = async (event, tr) => {
			if (!this.active(this.view)) {
				this.debug("Recived yjs event against a non-live view");
				return;
			}
			if (this.destroyed) {
				this.debug("Recived yjs event but editor was destroyed");
				return;
			}
			this.render();
		};
		this._ytext = this.document.ytext;
		this._ytext.observe(this.observer);
		this.document.whenReady().then(() => {
			// @ts-ignore
			this.view.previewMode.renderer.set(this.document.text);
		});
		this.document.connect();
	}

	active(view: MarkdownView) {
		return !this.destroyed;
	}

	public incrementalBufferChange(newBuffer: string): ChangeSpec[] {
		// @ts-ignore
		const currentBuffer = this.view.editor.cm.state.doc.toString();
		const dmp = new diff_match_patch();
		const diffs = dmp.diff_main(currentBuffer, newBuffer);
		dmp.diff_cleanupSemantic(diffs);

		const changes: ChangeSpec[] = [];
		let currentPos = 0;

		for (const [type, text] of diffs) {
			switch (type) {
				case 0: // EQUAL
					currentPos += text.length;
					break;
				case 1: // INSERT
					changes.push({
						from: currentPos,
						to: currentPos,
						insert: text,
					});
					currentPos += text.length;
					break;
				case -1: // DELETE
					changes.push({
						from: currentPos,
						to: currentPos + text.length,
						insert: "",
					});
					break;
			}
		}
		return changes;
	}

	public render() {
		if (this.view.getMode() === "preview") {
			// @ts-ignore
			this.view.text = this.document.text;
			// @ts-ignore
			this.view.previewMode.renderer.set(this.document.text);

			// This is only true for... some kind of preview views?
			// @ts-ignore
			this.view.onInternalDataChange?.();

			this.metadataEditorPlugin?.render();
		}
	}

	destroy() {
		this.warn("destroyed", this.document?.path);
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.unsubscribes.forEach((unsubscribe) => unsubscribe());
		this.unsubscribes.length = 0;
		this.metadataEditorPlugin?.destroy();
		this._ytext = null as any;
		this.view = null as any;
		this.document = null as any;
	}
}
