import * as Y from "yjs";

import { SyncStore } from "../src/SyncStore";

// The offline-removal witness (SharedFolder.captureOfflineRemovalWitness)
// reads a scratch doc built from the persisted pre-session updates. These
// tests pin the read against both map generations and against the
// merge-then-read shape the witness capture actually performs.

function encodeFolderState(populate: (doc: Y.Doc) => void): Uint8Array {
	const doc = new Y.Doc();
	populate(doc);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return update;
}

describe("SyncStore.readCommittedPaths", () => {
	test("reads meta and legacy entries from a scratch doc", () => {
		const update = encodeFolderState((doc) => {
			doc.getMap("filemeta_v0").set("notes/current.md", { id: "guid-1" });
			doc.getMap("docs").set("legacy/old.md", "guid-2");
		});
		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, update);
		expect(SyncStore.readCommittedPaths(scratch)).toEqual(
			new Set(["notes/current.md", "legacy/old.md"]),
		);
		scratch.destroy();
	});

	test("a path deleted in a later persisted update does not read as committed", () => {
		const doc = new Y.Doc();
		doc.getMap("filemeta_v0").set("moved/away.md", { id: "guid-3" });
		const first = Y.encodeStateAsUpdate(doc);
		doc.getMap("filemeta_v0").delete("moved/away.md");
		const second = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(new Y.Doc()));
		doc.destroy();

		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, Y.mergeUpdates([first, second]));
		expect(SyncStore.readCommittedPaths(scratch).has("moved/away.md")).toBe(
			false,
		);
		scratch.destroy();
	});

	test("empty doc reads as no committed paths", () => {
		const scratch = new Y.Doc();
		expect(SyncStore.readCommittedPaths(scratch).size).toBe(0);
		scratch.destroy();
	});
});
