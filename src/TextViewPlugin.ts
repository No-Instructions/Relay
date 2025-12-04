import { MarkdownView, type TextFileView } from "obsidian";
import { getPatcher } from "./Patcher";
import { HasLogging } from "src/debug";
import { Document } from "./Document";
import { ViewHookPlugin } from "./plugins/ViewHookPlugin";

import { isLive, type LiveView } from "./LiveViews";
import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { diffMatchPatch } from "./y-diffMatchPatch";

export class TextFileViewPlugin extends HasLogging {
	view: LiveView<TextFileView>;
	doc: Document | undefined;
	_ytext?: YText;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	unsubscribes: Array<() => void>;
	private destroyed = false;
	private saving = false;
	viewHookPlugin?: ViewHookPlugin;

	getDocument(): Document | undefined {
		const file = this.view.view.file;
		if (file) {
			if (this.doc?._tfile === file) {
				return this.doc;
			}
			this.warn("[TextViewPlugin] getDocument() lookup:", {
				filePath: file.path,
				currentDocPath: this.doc?.path,
				currentDocTFile: this.doc?._tfile?.path,
			});
			const folder = this.view.connectionManager.sharedFolders.lookup(
				file.path,
			);
			if (folder) {
				const newDoc = folder.proxy.getDoc(file.path);
				this.warn("[TextViewPlugin] getDocument() found:", {
					newDocPath: newDoc.path,
					newDocGuid: newDoc.guid,
					newDocTFile: newDoc._tfile?.path,
				});
				this.doc = newDoc;
				return this.doc;
			}
		}
		// Fallback to the LiveView's document
		if (this.view.document) {
			this.warn("[TextViewPlugin] getDocument() using fallback:", {
				fallbackDocPath: this.view.document.path,
				fallbackDocGuid: this.view.document.guid,
			});
			return this.view.document;
		}
	}

	constructor(view: LiveView<TextFileView>) {
		super();
		this.view = view;
		this.doc = view.document;
		this.unsubscribes = [];
		this.saving = false;

		// Validate that document TFile matches view file and get correct document
		const documentTFile = this.doc._tfile;
		const viewFile = this.view.view?.file;
		if (documentTFile !== viewFile) {
			this.error("[TextViewPlugin] CRITICAL: Document TFile mismatch!", {
				documentPath: this.doc.path,
				documentTFilePath: documentTFile?.path,
				viewFilePath: viewFile?.path,
				viewType: this.view.view?.getViewType?.(),
				documentGuid: this.doc.guid,
				tFilesSame: documentTFile === viewFile,
			});
			// Get the correct document instance
			const correctDoc = this.getDocument();
			if (correctDoc) {
				this.doc = correctDoc;
				this.warn("[TextViewPlugin] Switched to correct document:", {
					newDocPath: this.doc.path,
					newDocGuid: this.doc.guid,
				});
			}
		}

		if (this.view.view instanceof MarkdownView) {
			this.viewHookPlugin = new ViewHookPlugin(this.view.view, this.doc);
		}

		this.install();
	}

	async resync() {
		if (
			isLive(this.view) &&
			!this.view.tracking &&
			!this.destroyed &&
			this.view.view.file
		) {
			// Dynamically get the correct document
			this.doc = this.getDocument();
			if (!this.doc) {
				this.warn("resync() - no document available");
				return;
			}

			await this.doc.whenSynced();
			if (this.doc.text === this.view.view.getViewData()) {
				// Document and view content already match - set tracking immediately
				this.view.tracking = true;
				this.warn("resync() - content matches, setting tracking=true");
				return;
			} else {
				this.warn("diff in resync - DETAILED DEBUG:", {
					documentPath: this.doc.path,
					documentTFilePath: this.doc._tfile?.path,
					viewFilePath: this.view.view.file?.path,
					documentText: this.doc.text,
					viewData: this.view.view.getViewData(),
					documentGuid: this.doc.guid,
					tFilesMatching: this.doc._tfile === this.view.view.file,
					documentTextLength: this.doc.text?.length || 0,
					viewDataLength: this.view.view.getViewData()?.length || 0,
				});
			}
			if (!this.doc.hasLocalDB() && this.doc.text === "") {
				this.warn("local db missing, not setting buffer");
				return;
			}
			// Check if document is stale before overwriting view content
			const stale = await this.doc.checkStale();
			if (stale && this.view) {
				this.warn("Document is stale - showing merge banner");
				this.view.checkStale().then(async (stale) => {
					if (!stale) {
						await this.syncViewToCRDT();
					}
				}); // This will show the merge banner
			} else {
				// Document is authoritative, force view to match CRDT state (like getKeyFrame in LiveEditPlugin)
				this.warn("Document is authoritative - syncing view to CRDT state");
				await this.syncViewToCRDT();
			}
		}
	}

	async syncViewToCRDT() {
		// Force view to match CRDT state (equivalent to getKeyFrame in LiveEditPlugin)
		if (
			isLive(this.view) &&
			!this.destroyed &&
			this.doc &&
			this.view.view.file
		) {
			this.warn("Syncing view to CRDT - setViewData");
			this.saving = true;
			this.view.view.setViewData(this.doc.text, false);
			this.doc.save();
			this.saving = false;
			this.view.tracking = true;
		}
	}

	private install() {
		if (!this.view) return;

		// Don't install if view file is not ready
		if (!this.view.view.file) {
			this.warn("view file not ready, deferring install");
			// Retry installation after a short delay
			setTimeout(() => {
				if (!this.destroyed && this.view?.view?.file) {
					this.install();
				}
			}, 100);
			return;
		}

		this.warn(
			"connecting textfile view",
			this.view.view.file?.path,
			this.view.document.path,
		);

		// eslint-disable-next-line
		const that = this;

		this.unsubscribes.push(
			getPatcher().patch(this.view.view, {
				setViewData(old: any) {
					return function (this: any, data: string, clear: boolean) {
						that.warn("instance hook: setViewData", this.getViewType());

						// Don't process if file isn't loaded yet
						if (!that.view.view.file) {
							that.warn(
								"setViewData called before file loaded, deferring to original",
							);
							return old.call(this, data, clear);
						}

						if (clear) {
							if (
								isLive(that.view) &&
								that.doc &&
								that.view.view.file === that.doc.tfile
							) {
								if (that.view.document.text === data) {
									that.view.tracking = true;
								}
							}
						}

						const result = old.call(this, data, clear);

						// Call resync AFTER original setViewData succeeds
						if (clear) {
							that.resync();
						}

						return result;
					};
				},
				requestSave(old: any) {
					return function (this: any) {
						that.warn("instance hook: requestSave called", this.getViewType());
						if (isLive(that.view) && !that.saving && that.doc) {
							if (that.view.tracking && !that.saving) {
								that.warn("tracking - applying diff");
								diffMatchPatch(
									that.doc.ydoc,
									that.view.view.getViewData(),
									that.doc,
								);
								that.doc.save();
								return;
							} else {
								that.warn("not tracking - resync");
								that.resync();
							}
						}
						return old.call(this);
					};
				},
			}),
		);

		this.observer = (event, tr) => {
			// Dynamically get the correct document
			this.doc = this.getDocument();
			if (!this.doc) {
				this.debug("observer - no document available");
				return;
			}

			if (!isLive(this.view)) {
				this.debug("Recived yjs event against a non-live view");
				return;
			}
			if (this.destroyed) {
				this.debug("Recived yjs event but editor was destroyed");
				return;
			}

			// Called when a yjs event is received. Results in view update
			if (tr.origin !== this.doc) {
				if (!this.view.tracking) {
					this.warn("resync from update, not tracking");
					this.resync();
				}
				this.warn("setting view data");
				this.saving = true;
				this.view.view.setViewData(this.doc.text, false);
				this.view.view.requestSave();
				this.saving = false;
				this.view.tracking = true;
			}
		};

		this.resync();

		// Use the dynamically retrieved document for ytext
		this.doc = this.getDocument();
		if (this.doc) {
			this._ytext = this.doc.ytext;
			this._ytext.observe(this.observer);
		}

		// Initialize ViewHookPlugin after sync state is established
		if (this.viewHookPlugin) {
			this.viewHookPlugin.initialize().catch((error) => {
				this.error("Error initializing ViewHookPlugin:", error);
			});
		}
	}

	destroy() {
		this.warn("destroying view");
		this.destroyed = true;
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.unsubscribes.forEach((unsubscribe) => unsubscribe());
		this.unsubscribes.length = 0;

		// Clean up ViewHookPlugin
		this.viewHookPlugin?.destroy();

		this.observer = null as any;
		this._ytext = null as any;
		this.view = null as any;
		this.doc = null as any;
	}
}
