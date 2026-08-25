import type { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type { App, TFile, CachedMetadata } from "obsidian";
import type { SharedFolders } from "./SharedFolder";
import type { LiveViewManager } from "./LiveViews";

export interface MetadataBridge {
	onMeta(
		tfile: TFile,
		cb: (data: string, cache: CachedMetadata) => void,
	): void;
	offMeta(tfile: TFile): void;
}

interface RelayPlugin {
	sharedFolders: SharedFolders;
	app: App;
	metadataBridge?: MetadataBridge;
}

export function getRelayPlugin(editor: EditorView): RelayPlugin | null {
	const fileInfo = editor.state.field(editorInfoField, false);
	return (
		(fileInfo as {
			app?: { plugins?: { plugins?: Record<string, RelayPlugin | undefined> } };
		} | undefined)?.app?.plugins?.plugins?.["system3-relay"] ?? null
	);
}

export function getSharedFolders(editor: EditorView): SharedFolders | null {
	return getRelayPlugin(editor)?.sharedFolders ?? null;
}

export function getLiveViews(editor: EditorView): LiveViewManager | null {
	const plugin: (RelayPlugin & { _liveViews?: LiveViewManager }) | null =
		getRelayPlugin(editor);
	return plugin?._liveViews ?? null;
}

export function getApp(editor: EditorView): App | null {
	const fileInfo = editor.state.field(editorInfoField, false);
	return (fileInfo as { app?: App } | undefined)?.app ?? null;
}

export function getEditorFile(editor: EditorView) {
	const fileInfo = editor.state.field(editorInfoField, false);
	return fileInfo?.file ?? null;
}
