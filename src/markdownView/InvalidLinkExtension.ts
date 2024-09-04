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

export const invalidLinkSyncAnnotation = Annotation.define();

export class InvalidLinkPluginValue {
	editor: EditorView;
	view?: S3View;
	connectionManager: LiveViewManager | null;
	decorations: DecorationSet;
	log: (message: string) => void = (message: string) => {};

	constructor(editor: EditorView) {
		this.editor = editor;
		this.connectionManager = this.editor.state.facet(connectionManagerFacet);
		this.decorations = Decoration.none;

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
					this.updateDecorations();
				});
			}
		}
	}

	updateDecorations() {
		if (!FeatureFlagManager.getInstance().flags.enableInvalidLinkDecoration) {
			this.decorations = Decoration.none;
			return;
		}

		if (!this.view || !this.view.document) return;

		const invalidLinks = this.view.document.getInvalidLinks();

		const decorations = invalidLinks.map(({ from, to }) =>
			Decoration.mark({
				class: "invalid-link",
				attributes: {
					title:
						"This link points outside the shared folder and may not be accessible to other users.",
				},
			}).range(from, to),
		);

		this.decorations = Decoration.set(decorations);
	}

	update(update: ViewUpdate) {
		if (this.connectionManager) {
			this.view = this.connectionManager.findView(update.view);
		}

		if (update.docChanged) {
			this.updateDecorations();
		}

		return this.decorations;
	}

	destroy() {
		this.decorations = Decoration.none;
		this.connectionManager = null;
		this.view = undefined;
		this.editor = null as any;
	}
}

export const InvalidLinkPlugin = ViewPlugin.fromClass(InvalidLinkPluginValue, {
	decorations: (v) => v.decorations,
});
