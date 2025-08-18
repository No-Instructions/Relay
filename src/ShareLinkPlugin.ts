import { Annotation, ChangeSet } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { PluginValue } from "@codemirror/view";
import { TextFileView } from "obsidian";
import { LiveView, LiveViewManager } from "./LiveViews";
import { connectionManagerFacet } from "./y-codemirror.next/LiveEditPlugin";
import { hasKey, updateFrontMatter } from "./Frontmatter";
import { diffChars } from "diff";

export const shareLinkAnnotation = Annotation.define();

function diffToChangeSet(originalText: string, newText: string): ChangeSet {
	const changes: { from: number; to?: number; insert?: string }[] = [];
	const diffResult = diffChars(originalText, newText);

	let index = 0;
	for (const part of diffResult) {
		if (!part.count) {
			continue;
		}
		if (part.added) {
			changes.push({ from: index, insert: part.value });
		} else if (part.removed) {
			changes.push({ from: index, to: index + part.count });
			index += part.value.length;
		} else {
			index += part.count;
		}
	}
	const reduced: { from: number; to?: number; insert?: string }[] = [];
	let lastChange: { from: number; to?: number; insert?: string } | null = null;
	changes.forEach((_change) => {
		if (
			lastChange &&
			lastChange.to === _change.from &&
			!lastChange.insert &&
			_change.insert
		) {
			reduced.push({
				from: lastChange.from,
				to: lastChange.to,
				insert: _change.insert,
			});
			lastChange = null;
		} else if (lastChange) {
			reduced.push(lastChange);
			lastChange = _change;
		} else {
			lastChange = _change;
		}
	});
	return ChangeSet.of(changes, originalText.length);
}

export class ShareLinkPluginValue implements PluginValue {
	editor: EditorView;
	view?: LiveView<TextFileView>;
	connectionManager: LiveViewManager;

	constructor(editor: EditorView) {
		this.editor = editor;
		this.connectionManager = this.editor.state.facet(connectionManagerFacet);
		this.view = this.connectionManager.findView(editor);
		this.editor = editor;
		if (this.view) {
			this.view.document?.whenSynced().then(async () => {
				const hasKnownPeers = await this.view?.document?.hasKnownPeers();
				if (this.view?.document?.text || !hasKnownPeers) {
					this.updateFrontMatter();
				}
			});
		}
	}

	updateFrontMatter() {
		if (!(this.view instanceof LiveView)) {
			return;
		}
		if (!this.view || !this.view.shouldConnect) {
			return;
		}
		if (this.view.document.text != this.editor.state.doc.toString()) {
			return;
		}
		const text = this.editor.state.doc.toString();
		const shareLink = `https://ydoc.live/${this.view.document.guid}`;
		const withShareLink = updateFrontMatter(text, {
			shareLink: shareLink,
		});
		if (!(text || this.view.document.text)) {
			// document is empty
			this.editor.dispatch({
				changes: { from: 0, insert: withShareLink },
				annotations: [shareLinkAnnotation.of(this)],
			});
		} else if (!text.startsWith("---")) {
			// frontmatter is missing
			this.editor.dispatch({
				changes: {
					from: 0,
					insert: `---\nshareLink: '${shareLink}'\n---\n`,
				},
				annotations: [shareLinkAnnotation.of(this)],
			});
		} else if (!hasKey(text, "shareLink")) {
			// frontmatter exists, but the key is missing
			this.editor.dispatch({
				changes: { from: 3, insert: `\nshareLink: '${shareLink}'\n` },
				annotations: [shareLinkAnnotation.of(this)],
			});
		} else {
			// frontmatter exists, and the key is present
			const changeSet = diffToChangeSet(text, withShareLink);
			if (changeSet.empty) {
				return;
			}
			this.editor.dispatch({
				changes: changeSet,
				annotations: [shareLinkAnnotation.of(this)],
			});
		}
	}
}

export const ShareLinkPlugin = ViewPlugin.fromClass(ShareLinkPluginValue);
