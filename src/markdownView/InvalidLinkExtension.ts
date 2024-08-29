import { Annotation } from "@codemirror/state";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	type DecorationSet,
} from "@codemirror/view";
import { connectionManagerFacet } from "src/y-codemirror.next/LiveEditPlugin";
import { type S3View, LiveViewManager } from "../LiveViews";
import { curryLog } from "src/debug";
import { FeatureFlagManager } from "src/flagManager";
import type { CachedMetadata, TFile } from "obsidian";

export const invalidLinkSyncAnnotation = Annotation.define();

export class InvalidLinkPluginValue {
	editor: EditorView;
	view?: S3View;
	connectionManager: LiveViewManager | null;
	linkRanges: { from: number; to: number }[];
	decorations: DecorationSet;
	log: (message: string) => void = (message: string) => {};
	offMetadataUpdates = () => {};

	constructor(editor: EditorView) {
		this.editor = editor;
		this.connectionManager = this.editor.state.facet(connectionManagerFacet);
		this.decorations = Decoration.none;
		this.linkRanges = [];
		const cb = (tfile: TFile, data: string, cache: CachedMetadata) => {
			if (tfile !== this.view?.document?.tfile) {
				return;
			}
			this.updateFromMetadata();
		};
		const offRef = app.metadataCache.on("changed", cb);
		this.offMetadataUpdates = () => {
			app.metadataCache.offref(offRef);
		};

		if (FeatureFlagManager.getInstance().flags.enableInvalidLinkDecoration) {
			if (!this.connectionManager) {
				curryLog(
					"[InvalidLinkPluginValue]",
					"warn",
				)("ConnectionManager not found in InvalidLinkPlugin");
				return;
			}

			this.view = this.connectionManager.findView(editor);

			if (!this.view) {
				return;
			}

			this.log = curryLog(
				`[InvalidLinkPluginValue][${this.view.view.file?.path}]`,
				"debug",
			);
			this.log("created");

			if (this.view.document) {
				this.view.document.whenSynced().then(() => {
					this.updateFromMetadata();
					this.updateDecorations();
				});
			}
		}
	}

	updateFromMetadata() {
		if (!this.view || !this.view.document) return;
		this.linkRanges = this.view.document.getInvalidLinks();
	}

	updateDecorations() {
		if (!FeatureFlagManager.getInstance().flags.enableInvalidLinkDecoration) {
			this.decorations = Decoration.none;
			return;
		}

		const decorations = this.linkRanges.map(({ from, to }) =>
			Decoration.mark({
				class: "invalid-link",
				attributes: {
					title:
						"This link points outside the shared folder and may not be accessible to other users.",
				},
			}).range(from, to),
		);
		if (decorations) {
			this.decorations = Decoration.set(decorations);
		} else {
			this.decorations = Decoration.none;
		}
	}
	update(update: ViewUpdate) {
		if (this.connectionManager) {
			this.view = this.connectionManager.findView(update.view);
		}

		if (update.docChanged) {
			this.linkRanges = this.linkRanges
				.map((range) => {
					const newFrom = update.changes.mapPos(range.from);
					const newTo = update.changes.mapPos(range.to);
					return { from: newFrom, to: newTo };
				})
				.filter((value) => value.from !== value.to)
				.filter((value) => value.to < update.state.doc.length);
			this.updateDecorations();
		}

		return this.decorations;
	}

	destroy() {
		this.offMetadataUpdates();
		this.decorations = Decoration.none;
		this.connectionManager = null;
		this.view = undefined;
		this.editor = null as any;
	}
}

export const InvalidLinkPlugin = ViewPlugin.fromClass(InvalidLinkPluginValue, {
	decorations: (v) => v.decorations,
});
