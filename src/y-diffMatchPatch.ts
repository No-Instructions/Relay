import * as Y from "yjs";
import { curryLog } from "./debug";
import { diff_match_patch, type Diff } from "diff-match-patch";
import { flags } from "./flagManager";

export function diffMatchPatch(
	ydoc: Y.Doc,
	diskBuffer: string,
	origin?: any,
): void {
	// Get the YText from the YDoc
	const ytext = ydoc.getText("contents");

	// Get the current content of the YText
	const currentContent = ytext.toString();

	// Create a new diff_match_patch object
	const dmp = new diff_match_patch();

	// Compute the diff between the current content and the disk buffer
	const diffs: Diff[] = dmp.diff_main(currentContent, diskBuffer);

	// Optimize the diff
	dmp.diff_cleanupSemantic(diffs);

	// Initialize the cursor position
	let cursor = 0;

	const log = flags().enableDeltaLogging
		? curryLog("[diffMatchPatch]", "debug")
		: (...args: any) => {};

	// Log the overall change
	log("Updating YDoc:");
	log("Current content length:", currentContent.length);
	log("Disk buffer length:", diskBuffer.length);

	if (diffs.length == 0) {
		return;
	}

	// Apply the diffs as updates to the YDoc
	ydoc.transact(() => {
		for (const [operation, text] of diffs) {
			switch (operation) {
				case 1: // Insert
					log(`Inserting "${text}" at position ${cursor}`);
					ytext.insert(cursor, text);
					cursor += text.length;
					break;
				case 0: // Equal
					log(`Keeping "${text}" (length: ${text.length})`);
					cursor += text.length;
					break;
				case -1: // Delete
					log(`Deleting "${text}" at position ${cursor}`);
					ytext.delete(cursor, text.length);
					break;
			}
			log("intermediate", ytext.toString());
		}
	}, origin);

	log("result", ytext.toString());

	// Log the final state
	log("Update complete. New content length:", ytext.toString().length);
}
