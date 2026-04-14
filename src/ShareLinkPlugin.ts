import { Annotation, ChangeSet } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { PluginValue } from "@codemirror/view";
import { hasKey, updateFrontMatter } from "./Frontmatter";
import { diffChars } from "diff";
import { Document } from "./Document";
import { getSharedFolders, getEditorFile } from "./editorContext";
import { trackPromise } from "./trackPromise";

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
	document?: Document;

	constructor(editor: EditorView) {
		this.editor = editor;
		this.document = this.resolveDocument();
		if (this.document) {
			const hsm = this.document.hsm;
			if (!hsm?.awaitState) return;
			trackPromise(
				`shareLink:awaitActive:${this.document.guid}`,
				hsm.awaitState((s) => s.startsWith("active.")),
			).then(async () => {
				const hasKnownPeers = await this.document?.hasKnownPeers();
				if (this.document?.text || !hasKnownPeers) {
					this.updateFrontMatter();
				}
			});
		}
	}

	private resolveDocument(): Document | undefined {
		const file = getEditorFile(this.editor);
		if (!file) return undefined;
		const sharedFolders = getSharedFolders(this.editor);
		if (!sharedFolders) return undefined;
		const folder = sharedFolders.lookup(file.path);
		if (!folder) return undefined;
		return folder.proxy.getDoc(file.path);
	}

	updateFrontMatter() {
		if (!this.document) {
			return;
		}
		if (this.document.localText != this.editor.state.doc.toString()) {
			return;
		}
		const text = this.editor.state.doc.toString();
		const shareLink = `https://ydoc.live/${this.document.guid}`;
		const withShareLink = updateFrontMatter(text, {
			shareLink: shareLink,
		});
		if (!(text || this.document.localText)) {
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
