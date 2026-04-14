import { EditorView } from "@codemirror/view";
import { editorInfoField, type App, type TFile } from "obsidian";
import type Live from "./main";
import type { SharedFolders } from "./SharedFolder";

type AppWithPluginRegistry = App & {
	plugins?: {
		plugins?: Record<string, unknown>;
	};
};

function getEditorInfo(editor: EditorView): any | null {
	return editor.state.field(editorInfoField, false) ?? null;
}

export function getApp(editor: EditorView): App | null {
	return (getEditorInfo(editor)?.app as App | undefined) ?? null;
}

export function getRelayPlugin(editor: EditorView): Live | null {
	const app = getApp(editor) as AppWithPluginRegistry | null;
	return (app?.plugins?.plugins?.["system3-relay"] as Live | undefined) ?? null;
}

export function getEditorFile(editor: EditorView): TFile | null {
	return (getEditorInfo(editor)?.file as TFile | undefined) ?? null;
}

export function getSharedFolders(editor: EditorView): SharedFolders | null {
	return getRelayPlugin(editor)?.sharedFolders ?? null;
}
