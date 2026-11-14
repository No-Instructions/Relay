// Code in this file has been adapted from y-codemirror.next
// License
// [The MIT License](./LICENSE) © Kevin Jahns

import { applyTextChanges, type TextChange } from "../textChanges";
import { Compartment, StateEffect, type ChangeSpec } from "@codemirror/state";
import { EditorView, ViewUpdate, ViewPlugin, type PluginValue } from "@codemirror/view";
import type { Text as YText, YTextEvent, Transaction } from "yjs";
import { flags } from "src/flagManager";
import { syncDispatchAnnotations, ySyncAnnotation } from "../merge-hsm/integration/annotations";

interface CardBinding {
	ytext: YText;
	canvas: {
		readonly canEditContent: boolean;
		rejectReaderEdit(): void;
	};
}

/** An editor and its shared text, aligned by the canvas owner before installation. */
export class LiveNodePluginValue implements PluginValue {
	destroyed = false;

	constructor(private editor: EditorView, private binding: CardBinding) {
		binding.ytext.observe(this.observer);
	}

	private observer = (event: YTextEvent, tr: Transaction): void => {
		if (this.destroyed || tr.origin === this) return;
		// Native saves may adopt a buffer the editor already holds.
		if (this.editor.state.doc.toString() === event.target.toString()) return;
		const changes: ChangeSpec[] = [];
		let pos = 0;
		for (const delta of event.delta) {
			if (delta.insert != null) {
				changes.push({ from: pos, insert: delta.insert as string });
			} else if (delta.delete != null) {
				changes.push({ from: pos, to: pos + delta.delete, insert: "" });
				pos += delta.delete;
			} else if (delta.retain != null) {
				pos += delta.retain;
			}
		}
		this.editor.dispatch({
			changes,
			annotations: syncDispatchAnnotations(this.editor, flags().enableSingleUserHistory),
		});
	};

	update(update: ViewUpdate): void {
		if (
			this.destroyed || !update.docChanged ||
			(update.transactions.length > 0 &&
				update.transactions[0].annotation(ySyncAnnotation) === this.editor)
		) return;
		const { ytext, canvas } = this.binding;
		if (!canvas.canEditContent) {
			canvas.rejectReaderEdit();
			// CM6 forbids dispatching inside its update; restore after it completes.
			queueMicrotask(() => {
				if (this.destroyed) return;
				this.editor.dispatch({
					changes: { from: 0, to: this.editor.state.doc.length, insert: ytext.toString() },
					annotations: syncDispatchAnnotations(this.editor, flags().enableSingleUserHistory),
				});
			});
			return;
		}
		const changes: TextChange[] = [];
		update.changes.iterChanges((from, to, _fromB, _toB, insert) => {
			changes.push({ from, to, insert: insert.sliceString(0, insert.length, "\n") });
		});
		ytext.doc?.transact(() => applyTextChanges(ytext, changes), this);
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.binding.ytext.unobserve(this.observer);
	}
}

/** Install on this editor only; native editor destruction also releases the observer. */
export function bindLiveNode(editor: EditorView, binding: CardBinding): () => void {
	const compartment = new Compartment();
	let value: LiveNodePluginValue | undefined;
	const extension = ViewPlugin.define(view => (value = new LiveNodePluginValue(view, binding)));
	editor.dispatch({ effects: StateEffect.appendConfig.of(compartment.of(extension)) });
	return () => {
		// Obsidian may already have destroyed the editor when a node is released.
		if (value && !value.destroyed) {
			editor.dispatch({ effects: compartment.reconfigure([]) });
		}
		value = undefined;
	};
}
