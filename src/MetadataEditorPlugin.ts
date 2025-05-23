import { HasLogging } from "src/debug";
import { Document } from "./Document";

import { getFrontMatterInfo, parseYaml, type MarkdownView } from "obsidian";

import { YText, YTextEvent, Transaction } from "yjs/dist/src/internals";
import { around } from "monkey-around";

// MetadataEditorPlugin attaches to the MetadataEditor and renders updates
// from the CRDT. It also sets "saving" when frontmatter is being saved,
// however is up to the parent/owner of this plugin to handle writes.
// This is because the write path may be directly into the CRDT, or it may
// go through the editor as an intermediary.
export class MetadataEditorPlugin extends HasLogging {
	view: MarkdownView;
	_ytext: YText;
	unsubscribes: Array<() => void>;
	observer?: (event: YTextEvent, tr: Transaction) => void;
	destroyed = false;
	saving = false;

	constructor(
		previewView: MarkdownView,
		private document: Document,
	) {
		super();
		this.log("created", this.document.path);
		this.view = previewView;

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const that = this;

		this.unsubscribes = [];
		this.unsubscribes.push(
			around(this.view, {
				// @ts-ignore
				saveFrontmatter(old) {
					return function (data: any) {
						that.saving = true;
						// @ts-ignore
						const result = old.call(this, data);
						that.saving = false;
						return result;
					};
				},
			}),
		);
		this.observer = async (event, tr) => {
			if (!this.active(this.view)) {
				this.warn("Received yjs event against a non-live view");
				return;
			}
			this.render();
		};
		this._ytext = this.document.ytext;
		this._ytext.observe(this.observer);
	}

	active(view: MarkdownView) {
		return !!view && !this.destroyed;
	}

	public render() {
		// @ts-ignore
		const metadataEditor = this.view.metadataEditor;
		const fmi = getFrontMatterInfo(this.document.text);
		const fm = fmi.frontmatter;
		if (fm) metadataEditor.synchronize(parseYaml(fm));
	}

	destroy() {
		this.destroyed = true;
		this.log("destroyed", this.document?.path);
		if (this.observer) {
			this._ytext?.unobserve(this.observer);
		}
		this.unsubscribes.forEach((unsubscribe) => unsubscribe());
		this.unsubscribes.length = 0;
		this._ytext = null as any;
		this.view = null as any;
		this.document = null as any;
	}
}
