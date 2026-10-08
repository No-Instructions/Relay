import * as Y from "yjs";
import { curryLog } from "./debug";
import { applyTextChanges, diffTextChanges } from "./textChanges";
import { flags } from "./flagManager";
import { normalizeNoteText } from "./diskText";

export function diffMatchPatch(
	ydoc: Y.Doc,
	diskBuffer: string,
	origin?: unknown,
): void {
	// Get the YText from the YDoc
	const ytext = ydoc.getText("contents");

	// Get the current content of the YText
	const currentContent = ytext.toJSON();

	// The CRDT holds note text with canonical LF line endings; normalize the
	// incoming buffer so a CRLF disk read does not diff as a change on every
	// line against an LF CRDT (which would corrupt concurrent edits on merge).
	const normalizedBuffer = normalizeNoteText(diskBuffer);

	const changes = diffTextChanges(currentContent, normalizedBuffer);

	const log = flags().enableDeltaLogging
		? curryLog("[diffMatchPatch]", "debug")
		: (...args: unknown[]) => {};

	// Log the overall change
	log("Updating YDoc:");
	log("Current content length:", currentContent.length);
	log("Disk buffer length:", normalizedBuffer.length);

	if (changes.length === 0) return;

	ydoc.transact(() => {
		applyTextChanges(ytext, changes);
	}, origin);

	log("result", ytext.toJSON());

	// Log the final state
	log("Update complete. New content length:", ytext.toJSON().length);
}
