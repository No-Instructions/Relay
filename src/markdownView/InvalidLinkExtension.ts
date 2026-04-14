import { Annotation, StateEffect } from "@codemirror/state";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	type DecorationSet,
} from "@codemirror/view";
import { WidgetType } from "@codemirror/view";
import { curryLog } from "src/debug";
import type { App, CachedMetadata, TFile } from "obsidian";
import { Document, isDocument } from "../Document";
import {
	getApp,
	getSharedFolders,
	getEditorFile,
	getRelayPlugin,
	type MetadataBridge,
} from "../editorContext";
import { trackPromise } from "../trackPromise";

export const invalidLinkSyncAnnotation = Annotation.define();

class FileWarningWidget extends WidgetType {
	toDOM() {
		const span = document.createElement("span");
		span.style.display = "inline-flex";
		span.addClass("invalid-link");
		span.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-warning"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
		span.title =
			"This link points outside the shared folder and may not be accessible to other users.";
		return span;
	}
}

interface CacheLink {
	from: number;
	to: number;
	link: string;
	original: string;
}

const metadataChangeEffect = StateEffect.define();

export class InvalidLinkPluginValue {
	app?: App;
	metadata: Map<number, CacheLink>;
	editor: EditorView;
	document?: Document;
	decorationAnchors: number[];
	decorations: DecorationSet;
	cb: (data: string, cache: CachedMetadata) => void;
	log: (message: string) => void = (message: string) => {};
	private subscribedTFile?: TFile;
	private metadataBridge?: MetadataBridge;
	private destroyed = false;

	constructor(editor: EditorView) {
		this.editor = editor;
		this.decorations = Decoration.none;
		this.decorationAnchors = [];
		this.metadata = new Map();
		this.cb = (data: string, cache: CachedMetadata) => {
			if (this.destroyed || !this.editor) return;
			this.updateFromMetadata(cache);
			this.editor.dispatch({
				effects: metadataChangeEffect.of(null),
			});
		};

		this.app = getApp(this.editor) ?? undefined;
		this.document = this.resolveDocument();

		if (!this.document) {
			return;
		}

		this.log = curryLog(
			`[InvalidLinkPluginValue][${this.document.path}]`,
			"debug",
		);
		this.log("created");

		const hsm = this.document.hsm;
		if (!hsm?.awaitState) return;
		trackPromise(
			`invalidLink:awaitActive:${this.document.path}`,
			hsm.awaitState((s) => s.startsWith("active.")),
		).then(() => {
			if (this.destroyed) return;
			const tfile = this.document?.getTFile();
			const plugin = getRelayPlugin(this.editor);
			const metadataBridge = plugin?.metadataBridge;
			if (metadataBridge && this.app && tfile) {
				this.metadataBridge = metadataBridge;
				metadataBridge.onMeta(tfile, this.cb);
				this.subscribedTFile = tfile;
				const fileCache = this.app.metadataCache.getFileCache(tfile);
				if (fileCache) {
					this.updateFromMetadata(fileCache);
					this.editor.dispatch({
						effects: metadataChangeEffect.of(null),
					});
				}
			} else {
				this.log("unable to subscribe to metadata updates");
			}
		});
	}

	private resolveDocument(): Document | undefined {
		if (this.destroyed || !this.editor) return undefined;
		if (this.document && this.document.tfile) {
			return this.document;
		}
		const file = getEditorFile(this.editor);
		if (!file) return undefined;
		const sharedFolders = getSharedFolders(this.editor);
		if (!sharedFolders) return undefined;
		const folder = sharedFolders.lookup(file.path);
		if (!folder) return undefined;
		const vpath = folder.getVirtualPath(file.path);
		const id = folder.syncStore.get(vpath);
		if (id === undefined) return undefined;
		const doc = folder.files.get(id);
		if (!doc || !isDocument(doc)) return undefined;
		return doc;
	}

	findInternalLinks(view: EditorView) {
		const links: {
			from: number;
			to: number;
		}[] = [];
		const decorationSets = view.state.facet(EditorView.decorations);
		decorationSets.forEach(
			(
				decoSetOrFunc: DecorationSet | ((view: EditorView) => DecorationSet),
			) => {
				const decoSet =
					typeof decoSetOrFunc === "function"
						? decoSetOrFunc(view)
						: decoSetOrFunc;

				decoSet.between(
					0,
					view.state.doc.length,
					(from: number, to: number, deco: Decoration) => {
						const classes = deco.spec?.class || "";
						const linkEnd = classes.contains("cm-formatting-link-end");
						if (linkEnd) {
							links.push({
								from,
								to,
							});
						}
					},
				);
			},
		);

		return links;
	}

	updateFromMetadata(cache: CachedMetadata) {
		this.document = this.resolveDocument();
		if (!this.document || !this.app) return;
		if (!this.document.sharedFolder) return;
		if (!this.document.tfile) return;
		const cacheLinks = new Map();
		for (const link of cache?.links || []) {
			const linkedFile = this.app.metadataCache.getFirstLinkpathDest(
				link.link,
				this.document.path,
			);
			if (
				linkedFile &&
				!this.document.sharedFolder.checkPath(linkedFile.path)
			) {
				cacheLinks.set(link.position.start.offset, {
					from: link.position.start.offset,
					to: link.position.end.offset,
					link: link.link,
					original: link.original,
				});
			}
		}
		for (const embed of cache?.embeds || []) {
			const linkedFile = this.app.metadataCache.getFirstLinkpathDest(
				embed.link,
				this.document.path,
			);
			if (
				linkedFile &&
				!this.document.sharedFolder.checkPath(linkedFile.path)
			) {
				cacheLinks.set(embed.position.start.offset, {
					from: embed.position.start.offset,
					to: embed.position.end.offset,
					link: embed.link,
					original: embed.original,
				});
			}
		}
		this.metadata = cacheLinks;
	}

	updateMetadataPositions(update: ViewUpdate) {
		for (const [cacheFrom, cacheLink] of this.metadata) {
			try {
				this.metadata.set(cacheFrom, {
					from: update.changes.mapPos(cacheLink.from),
					to: update.changes.mapPos(cacheLink.to),
					link: cacheLink.link,
					original: cacheLink.original,
				});
			} catch (e) {
				this.metadata.delete(cacheFrom);
			}
		}
	}

	updateFromEditor(update: ViewUpdate) {
		// The metadata cache is slower to update than the document.
		// We use the cache to get link information, but rely on the document links for
		// position information to avoid any delays or positioning bugs.
		this.document = this.resolveDocument();
		if (!this.document || !this.app) return;
		if (!this.document.sharedFolder) return;
		if (!this.document.tfile) return;

		const invalidAnchors: number[] = [];
		const cacheLinks = new Map(this.metadata);
		const editorLinks = this.findInternalLinks(this.editor);
		for (const link of editorLinks) {
			let _cacheLink = null;
			for (const [cacheFrom, cacheLink] of cacheLinks) {
				if (link.from <= cacheLink.to && link.to >= cacheLink.from) {
					_cacheLink = cacheLink;
					cacheLinks.delete(cacheFrom);
					break;
				}
			}
			if (!_cacheLink) {
				continue;
			}
			const linkedFile = this.app.metadataCache.getFirstLinkpathDest(
				_cacheLink.link,
				this.document.path,
			);
			const isInvalid =
				linkedFile &&
				!this.document.sharedFolder.checkPath(linkedFile.path);
			if (isInvalid) {
				invalidAnchors.push(link.from);
			}
		}
		invalidAnchors.filter((a) => a <= update.state.doc.length);
		this.decorationAnchors = invalidAnchors;
	}

	updateDecorations() {
		// Sort the linkRanges by their 'to' position (since we're adding widgets at the end of links)
		this.decorationAnchors.sort();

		const decorations = this.decorationAnchors.map((anchor) =>
			Decoration.widget({
				widget: new FileWarningWidget(),
				side: 1,
			}).range(anchor),
		);

		if (decorations.length > 0) {
			this.decorations = Decoration.set(decorations, true); // The 'true' argument ensures the set is created as sorted
		} else {
			this.decorations = Decoration.none;
		}
	}

	update(update: ViewUpdate) {
		let metadataUpdate = false;
		update.transactions.forEach((tr) => {
			if (tr.effects.some((e) => e.is(metadataChangeEffect))) {
				metadataUpdate = true;
			}
		});
		if (update.docChanged || update.viewportChanged || metadataUpdate) {
			if (!metadataUpdate) {
				this.updateMetadataPositions(update);
			}
			this.updateFromEditor(update);
			this.updateDecorations();
		}
		return this.decorations;
	}

	destroy() {
		this.destroyed = true;
		if (this.subscribedTFile) {
			this.metadataBridge?.offMeta(this.subscribedTFile);
			this.subscribedTFile = undefined;
		}
		this.metadataBridge = undefined;
		this.document = undefined;
		this.metadata.clear();
		this.metadata = null as any;
		this.editor = null as any;
	}
}

export const InvalidLinkPlugin = ViewPlugin.fromClass(InvalidLinkPluginValue, {
	decorations: (v) => v.decorations,
});
