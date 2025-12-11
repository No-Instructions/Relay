// Code in this file has been adapted from y-codemirror.next
// License
// [The MIT License](./LICENSE) © Kevin Jahns

import { Facet, Annotation } from "@codemirror/state";
import type { ChangeSpec } from "@codemirror/state";
import { EditorView, ViewUpdate, ViewPlugin } from "@codemirror/view";
import type { PluginValue } from "@codemirror/view";
import {
	LiveView,
	LiveViewManager,
	ConnectionManagerStateField,
	type S3View,
	isLiveMd,
} from "../LiveViews";
import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { curryLog } from "src/debug";
import { getPatcher } from "../Patcher";
import diff_match_patch from "diff-match-patch";
import { flags } from "src/flagManager";
import { MarkdownView, editorInfoField } from "obsidian";
import { Document } from "src/Document";
import { EmbedBanner } from "src/ui/EmbedBanner";
import { ViewHookPlugin } from "src/plugins/ViewHookPlugin";

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
	view?: LiveView<MarkdownView>;
	connectionManager?: LiveViewManager;
	initialSet = false;
	sourceView: Element | null;
	banner?: EmbedBanner;
	private destroyed = false;
	_observer?: (event: YTextEvent, tr: Transaction) => void;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	_ytext?: YText;
	keyFrameCounter = 0;
	unsubscribes: Array<() => void>;
	debug: (...args: unknown[]) => void = (...args: unknown[]) => {};
	log: (...args: unknown[]) => void = (...args: unknown[]) => {};
	warn: (...args: unknown[]) => void = (...args: unknown[]) => {};
	error: (...args: unknown[]) => void = (...args: unknown[]) => {};
	document?: Document;
	embed = false;
	viewHookPlugin?: ViewHookPlugin;

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
		this.view = this.connectionManager?.findView(this.editor);
		if (this.view && this.view.document instanceof Document) {
			return this.view.document;
		}
	}

	active(view?: S3View) {
		const live = isLiveMd(view);
		return live || (this.embed && this.document);
	}

	mergeBanner(): () => void {
		if (this.destroyed || !this.editor) {
			return () => {};
		}
		
		this.banner = new EmbedBanner(
			this.sourceView,
			this.editor.dom,
			"Merge conflict -- click to resolve",
			async () => {
				if (!this.document) return true;
				const diskBuffer = await this.document.diskBuffer();
				const stale = await this.document.checkStale();
				if (!stale) {
					return true;
				}
				this.connectionManager?.openDiffView({
					file1: this.document,
					file2: diskBuffer,
					showMergeOption: true,
					onResolve: async () => {
						if (this.destroyed || !this.editor || !this.document) {
							return;
						}
						this.document.clearDiskBuffer();
						this.resync();
					},
				});
				return true;
			},
		);
		return () => {};
	}

	constructor(editor: EditorView) {
		this.unsubscribes = [];
		this.editor = editor;
		this.sourceView = this.editor.dom.closest(".markdown-source-view");
		this.connectionManager = this.editor.state.field(
			ConnectionManagerStateField,
		);

		// Allowlist: Check for live editing markers
		const isLiveEditor = this.editor.dom.closest(".relay-live-editor");
		const hasIframeClass =
			this.sourceView?.classList.contains("mod-inside-iframe");

		// For embedded canvas editors, we can't always find the canvas via ConnectionManager
		// but if it has mod-inside-iframe, it's likely a legitimate embedded editor
		const isEmbeddedInCanvas = hasIframeClass;

		if (!isLiveEditor && !isEmbeddedInCanvas) {
			this.destroyed = true;
			return;
		}

		this.view = this.connectionManager?.findView(this.editor);
		this.document = this.getDocument();
		if (!this.document) {
			this.destroyed = true;
			return;
		}
		if (!this.view) {
			this.embed = true;
		} else {
			this.viewHookPlugin = new ViewHookPlugin(this.view.view, this.document);
		}
		this.log = curryLog(`[LiveCMPluginValue][${this.document.path}]`, "log");
		this.warn = curryLog(`[LiveCMPluginValue][${this.document.path}]`, "warn");
		this.error = curryLog(
			`[LiveCMPluginValue][${this.document.path}]`,
			"error",
		);
		this.debug = curryLog(
			`[LiveCMPluginValue][${this.document.path}]`,
			"debug",
		);
		this.debug("created");

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const liveEditPlugin = this;
		let fmSave = false;

		if (this.view?.view) {
			this.unsubscribes.push(
				getPatcher().patch(this.view.view, {
					setViewData(old: any) {
						return function (data: string, clear: boolean) {
							if (clear) {
								if (isLiveMd(liveEditPlugin.view)) {
									if (liveEditPlugin.view.document.text === data) {
										liveEditPlugin.view.tracking = true;
									}
								}
								liveEditPlugin.resync();
							} else if (fmSave) {
								const changes = liveEditPlugin.incrementalBufferChange(data);
								editor.dispatch({
									changes,
								});
								return;
							}
							// @ts-ignore
							return old.call(this, data, clear);
						};
					},
					// @ts-ignore
					saveFrontmatter(old: any) {
						return function (data: any) {
							fmSave = true;
							// @ts-ignore
							const result = old.call(this, data);
							fmSave = false;
							return result;
						};
					},
					requestSave(old: any) {
						return function () {
							// @ts-ignore
							const result = old.call(this);
							try {
								// @ts-ignore
								this.app.metadataCache.trigger("resolve", this.file);
							} catch (e) {
								// pass
							}
							return result;
						};
					},
				}),
			);
		} else {
			this.document.connect();
		}

		if (this.document.connected) {
			this.resync();
		} else {
			this.document.onceConnected().then(() => {
				this.resync();
			});
		}

		// Initialize ViewHookPlugin
		if (this.viewHookPlugin) {
			this.viewHookPlugin.initialize().catch((error) => {
				this.error("Error initializing ViewHookPlugin:", error);
			});
		}

		this._observer = async (event, tr) => {
			this.document = this.getDocument();

			if (!this.active(this.view)) {
				this.debug("Recived yjs event against a non-live view");
				return;
			}
			if (this.destroyed) {
				this.debug("Recived yjs event but editor was destroyed");
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
				if (
					(isLiveMd(this.view) && !this.view.tracking) ||
					(flags().enableEditorTweens && this.keyFrameCounter > TWEENS)
				) {
					this.keyFrameCounter = 0;
					changes = await this.getKeyFrame(true);
					this.debug(`dispatch (full)`);
				} else {
					this.keyFrameCounter += 1;
					this.debug(`dispatch (incremental + ${this.keyFrameCounter})`);
				}
				if (this.active(this.view)) {
					editor.dispatch({
						changes,
						annotations: [ySyncAnnotation.of(this.editor)],
					});
					if (isLiveMd(this.view)) {
						this.view.tracking = true;
					}
				}
			}
		};

		this.observer = (event, tr) => {
			try {
				this._observer?.(event, tr);
			} catch (e) {
				if (e instanceof RangeError) {
					if (isLiveMd(this.view)) {
						this.view.tracking = false;
					}
				}
			}
		};
		this._ytext = this.document.ytext;
		this._ytext.observe(this.observer);
	}

	public incrementalBufferChange(newBuffer: string): ChangeSpec[] {
		const currentBuffer = this.editor.state.doc.toString();
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

	public getBufferChange(newBuffer: string, incremental = false): ChangeSpec[] {
		if (incremental) {
			return this.incrementalBufferChange(newBuffer);
		}
		return [
			{
				from: 0,
				to: this.editor.state.doc.length,
				insert: newBuffer,
			},
		];
	}

	async resync() {
		if (isLiveMd(this.view) && !this.view.tracking && !this.destroyed) {
			await this.view.document.whenSynced();
			const keyFrame = await this.getKeyFrame();
			if (isLiveMd(this.view) && !this.view.tracking && !this.destroyed) {
				this.editor.dispatch({
					changes: keyFrame,
					annotations: [ySyncAnnotation.of(this.editor)],
				});
			}
		} else if (this.active(this.view) && this.document) {
			await this.document.whenSynced();
			const keyFrame = await this.getKeyFrame();
			if (this.active(this.view) && !this.destroyed) {
				this.editor.dispatch({
					changes: keyFrame,
					annotations: [ySyncAnnotation.of(this.editor)],
				});
			}
		}
	}

	async getKeyFrame(incremental = false): Promise<ChangeSpec[]> {
		// goal: sync editor state to ytext state so we can accept delta edits.
		if (!this.active(this.view) || this.destroyed) {
			return [];
		}

		if (this.document?.text === this.editor.state.doc.toString()) {
			// disk and ytext were already the same.
			if (isLiveMd(this.view)) {
				this.view.tracking = true;
			}
			return [];
		} else if (flags().enableDeltaLogging) {
			this.warn(
				`|${this.document?.text}|\n|${this.editor.state.doc.toString()}|`,
			);
		}

		if (!this.document) {
			this.warn("no document");
			return [];
		}

		this.warn(`ytext and editor buffer need syncing`);
		if (!this.document.hasLocalDB() && this.document.text === "") {
			this.warn("local db missing, not setting buffer");
			return [];
		}

		// disk and ytext differ
		if (isLiveMd(this.view) && !this.view.tracking) {
			this.view.checkStale();
		} else if (this.document) {
			const stale = await this.document.checkStale();
			if (stale && !this.destroyed && this.editor) {
				this.mergeBanner();
			}
		}

		if (this.active(this.view) && !this.destroyed) {
			return [this.getBufferChange(this.document.text, incremental)];
		}
		return [];
	}

	update(update: ViewUpdate): void {
		// When updates were made to the local editor. Forwarded to the ydoc.
		if (
			!update.docChanged ||
			(update.transactions.length > 0 &&
				update.transactions[0].annotation(ySyncAnnotation) === this.editor) ||
			this.destroyed
		) {
			return;
		}
		this.document = this.getDocument();
		const ytext = this.document?.ytext;
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

		if (this.embed && this.document) {
			this.document.requestSave();
		}
	}

	destroy() {
		this.destroyed = true;
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.unsubscribes.length = 0;
		this.viewHookPlugin?.destroy();
		this.connectionManager = null as any;
		this.view = undefined;
		this._ytext = undefined;
		this.editor = null as any;
	}
}

export const LiveEdit = ViewPlugin.fromClass(LiveCMPluginValue);
