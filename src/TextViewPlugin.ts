import { around } from "monkey-around";
import type { TextFileView } from "obsidian";
import { HasLogging } from "src/debug";
import { Document } from "./Document";

import { isLive, type LiveView } from "./LiveViews";
import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { diffMatchPatch } from "./y-diffMatchPatch";

export class TextFileViewPlugin extends HasLogging {
	view: LiveView<TextFileView>;
	doc: Document;
	_ytext?: YText;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	unsubscribes: Array<() => void>;
	private destroyed = false;
	private saving = false;

	constructor(view: LiveView<TextFileView>) {
		super();
		this.view = view;
		this.doc = view.document;
		this.unsubscribes = [];
		this.saving = false;
		this.install();
	}

	async resync() {
		if (isLive(this.view) && !this.view.tracking && !this.destroyed) {
			await this.view.document.whenSynced();
			const contents = await this.doc.sharedFolder.read(this.doc);
			if (this.view.document.text === contents) {
				this.view.tracking = true;
				return;
			}
			if (!this.view.document.hasLocalDB() && this.view.document.text === "") {
				this.warn("local db missing, not setting buffer");
				return;
			}

			if (!this.view.tracking) {
				this.warn("checking stale");
				this.view.checkStale();
			}

			if (isLive(this.view) && !this.destroyed && this.doc.text !== "") {
				this.warn("resolved!?");
				this.view.view.setViewData(this.doc.text, false);
				this.saving = true;
				this.doc.sharedFolder.flush(this.doc, this.doc.text);
				this.saving = false;
				this.view.tracking = true;
			}
		}
	}

	private install() {
		if (!this.view) return;

		this.warn(
			"connecting textfile view",
			this.view.view.file?.path,
			this.view.document.path,
		);

		// eslint-disable-next-line
		const that = this;

		this.unsubscribes.push(
			around(this.view.view, {
				setViewData(old: any) {
					return function (data: string, clear: boolean) {
						if (clear) {
							if (
								!that.destroyed &&
								isLive(that.view) &&
								that.view.view.file === that.doc.tfile
							) {
								if (that.view.document.text === data) {
									that.view.tracking = true;
								}
								that.resync();
							}
						}
						// @ts-ignore
						return old.call(this, data, clear);
					};
				},
				requestSave(old: any) {
					return function () {
						if (
							isLive(that.view) &&
							that.view.view.file === that.doc.tfile &&
							!that.saving &&
							!that.destroyed
						) {
							if (that.view.tracking) {
								diffMatchPatch(
									that.doc.ydoc,
									that.view.view.getViewData(),
									that,
								);
							} else {
								that.resync();
							}
						}
						// @ts-ignore
						return old.call(this);
					};
				},
			}),
		);

		this.observer = (event, tr) => {
			if (!isLive(this.view)) {
				this.debug("Recived yjs event against a non-live view");
				return;
			}
			if (this.destroyed) {
				this.debug("Recived yjs event but editor was destroyed");
				return;
			}

			// Called when a yjs event is received. Results in view update
			if (tr.origin !== this) {
				if (!this.view.tracking) {
					this.warn("resync from update, not tracking");
					this.resync();
				} else {
					this.warn("setting view data");
					this.saving = true;
					this.view.view.setViewData(this.doc.text, false);
					this.saving = false;
					this.view.tracking = true;
				}
			}
		};

		this._ytext = this.view.document.ytext;
		this._ytext.observe(this.observer);

		this.resync();
	}

	destroy() {
		this.destroyed = true;
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.unsubscribes.forEach((unsubscribe) => unsubscribe());
		this.unsubscribes.length = 0;
		this.view = null as any;
		this.doc = null as any;
	}
}
