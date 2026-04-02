/**
 * Tests for deltaToPositionedChanges — verifying that Y.js deltas
 * are correctly converted to CM6 positioned changes.
 *
 * Uses actual CM6 EditorState to validate that applying the converted
 * changes to the old document produces the expected new document.
 */

import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { createTestHSM, loadAndActivate } from "src/merge-hsm/testing";

/**
 * Apply positioned changes to a CM6 EditorState and return the result.
 */
function applyCM6Changes(
	oldText: string,
	changes: Array<{ from: number; to: number; insert: string }>,
): string {
	const state = EditorState.create({ doc: oldText });
	const tr = state.update({ changes });
	return tr.state.doc.toString();
}

/**
 * Get access to deltaToPositionedChanges via the HSM instance.
 * The method is private, so we access it through the prototype.
 */
async function getDeltaConverter() {
	const t = await createTestHSM();
	await loadAndActivate(t, "dummy");
	const convert = (t.hsm as any).deltaToPositionedChanges.bind(t.hsm);
	return convert;
}

/**
 * Use actual Y.js to produce a delta from two strings, then verify
 * that deltaToPositionedChanges + CM6 produces the correct result.
 */
function getYjsDelta(
	oldText: string,
	editFn: (ytext: Y.Text) => void,
): { delta: any[]; newText: string } {
	const doc = new Y.Doc();
	const ytext = doc.getText("test");
	ytext.insert(0, oldText);

	let capturedDelta: any[] = [];
	ytext.observe((event) => {
		capturedDelta = event.delta;
	});

	doc.transact(() => {
		editFn(ytext);
	});

	const newText = ytext.toString();
	doc.destroy();
	return { delta: capturedDelta, newText };
}

describe("deltaToPositionedChanges", () => {
	let convert: (
		delta: Array<{
			insert?: string | object;
			delete?: number;
			retain?: number;
		}>,
	) => Array<{ from: number; to: number; insert: string }>;

	beforeAll(async () => {
		convert = await getDeltaConverter();
	});

	// =========================================================================
	// Basic operations
	// =========================================================================

	test("empty delta — no changes", () => {
		const changes = convert([]);
		expect(changes).toEqual([]);
	});

	test("retain only — no changes", () => {
		const changes = convert([{ retain: 10 }]);
		expect(changes).toEqual([]);
	});

	test("simple insert at beginning", () => {
		const oldText = "hello";
		const changes = convert([{ insert: "XX" }]);
		expect(applyCM6Changes(oldText, changes)).toBe("XXhello");
	});

	test("simple insert in middle", () => {
		const oldText = "hello world";
		const changes = convert([{ retain: 5 }, { insert: " beautiful" }]);
		expect(applyCM6Changes(oldText, changes)).toBe("hello beautiful world");
	});

	test("simple insert at end", () => {
		const oldText = "hello";
		const changes = convert([{ retain: 5 }, { insert: " world" }]);
		expect(applyCM6Changes(oldText, changes)).toBe("hello world");
	});

	test("insert into empty document", () => {
		const changes = convert([{ insert: "hello" }]);
		expect(applyCM6Changes("", changes)).toBe("hello");
	});

	test("simple delete at beginning", () => {
		const oldText = "hello world";
		const changes = convert([{ delete: 6 }]);
		expect(applyCM6Changes(oldText, changes)).toBe("world");
	});

	test("simple delete in middle", () => {
		const oldText = "hello world";
		const changes = convert([{ retain: 5 }, { delete: 1 }]);
		expect(applyCM6Changes(oldText, changes)).toBe("helloworld");
	});

	test("simple delete at end", () => {
		const oldText = "hello world";
		const changes = convert([{ retain: 5 }, { delete: 6 }]);
		expect(applyCM6Changes(oldText, changes)).toBe("hello");
	});

	test("delete entire document", () => {
		const oldText = "hello";
		const changes = convert([{ delete: 5 }]);
		expect(applyCM6Changes(oldText, changes)).toBe("");
	});

	// =========================================================================
	// Delete + Insert (replacement) — the critical bug case
	// =========================================================================

	test("delete then insert (replacement)", () => {
		const oldText = "ABCDEFGHIJ";
		const changes = convert([{ retain: 3 }, { delete: 2 }, { insert: "XY" }]);
		expect(applyCM6Changes(oldText, changes)).toBe("ABCXYFGHIJ");
	});

	test("delete then insert at beginning", () => {
		const oldText = "ABCDE";
		const changes = convert([{ delete: 2 }, { insert: "XY" }]);
		expect(applyCM6Changes(oldText, changes)).toBe("XYCDE");
	});

	test("delete then insert — different lengths", () => {
		const oldText = "ABCDE";
		const changes = convert([{ retain: 1 }, { delete: 3 }, { insert: "X" }]);
		expect(applyCM6Changes(oldText, changes)).toBe("AXE");
	});

	test("delete then insert — insert longer than delete", () => {
		const oldText = "ABCDE";
		const changes = convert([
			{ retain: 1 },
			{ delete: 1 },
			{ insert: "XXXX" },
		]);
		expect(applyCM6Changes(oldText, changes)).toBe("AXXXXCDE");
	});

	test("insert then delete", () => {
		const oldText = "ABCDEFGHIJ";
		const changes = convert([{ retain: 2 }, { insert: "XY" }, { delete: 2 }]);
		expect(applyCM6Changes(oldText, changes)).toBe("ABXYEFGHIJ");
	});

	// =========================================================================
	// Multiple operations
	// =========================================================================

	test("multiple deletes — no retain between", () => {
		const oldText = "ABCDEF";
		// Delete AB then delete CD in sequence
		const changes = convert([{ delete: 2 }, { delete: 2 }]);
		expect(applyCM6Changes(oldText, changes)).toBe("EF");
	});

	test("multiple deletes — with retain", () => {
		const oldText = "ABCDEFGHIJ";
		const changes = convert([{ delete: 2 }, { retain: 2 }, { delete: 2 }]);
		expect(applyCM6Changes(oldText, changes)).toBe("CDGHIJ");
	});

	test("multiple inserts — no retain between", () => {
		const oldText = "AB";
		const changes = convert([{ insert: "X" }, { insert: "Y" }]);
		expect(applyCM6Changes(oldText, changes)).toBe("XYAB");
	});

	test("multiple inserts — with retain", () => {
		const oldText = "ABCDEF";
		const changes = convert([
			{ retain: 2 },
			{ insert: "XX" },
			{ retain: 2 },
			{ insert: "YY" },
		]);
		expect(applyCM6Changes(oldText, changes)).toBe("ABXXCDYYEF");
	});

	test("multiple replacements", () => {
		const oldText = "AABBBCCDDDD";
		// Replace BBB with X, replace DD with YYY
		const changes = convert([
			{ retain: 2 },
			{ delete: 3 },
			{ insert: "X" },
			{ retain: 2 },
			{ delete: 2 },
			{ insert: "YYY" },
			// remaining DD untouched
		]);
		expect(applyCM6Changes(oldText, changes)).toBe("AAXCCYYYDD");
	});

	test("complex mixed operations", () => {
		const oldText = "The quick brown fox";
		const changes = convert([
			{ delete: 3 },
			{ insert: "A" },
			{ retain: 1 },
			{ delete: 5 },
			{ insert: "slow" },
			{ retain: 1 },
			{ delete: 5 },
			{ insert: "red" },
			{ retain: 4 },
		]);
		expect(applyCM6Changes(oldText, changes)).toBe("A slow red fox");
	});

	// =========================================================================
	// Single character operations
	// =========================================================================

	test("single char insert", () => {
		const oldText = "AC";
		const changes = convert([{ retain: 1 }, { insert: "B" }]);
		expect(applyCM6Changes(oldText, changes)).toBe("ABC");
	});

	test("single char delete", () => {
		const oldText = "ABC";
		const changes = convert([{ retain: 1 }, { delete: 1 }]);
		expect(applyCM6Changes(oldText, changes)).toBe("AC");
	});

	test("single char replace", () => {
		const oldText = "ABC";
		const changes = convert([{ retain: 1 }, { delete: 1 }, { insert: "X" }]);
		expect(applyCM6Changes(oldText, changes)).toBe("AXC");
	});

	// =========================================================================
	// Edge cases
	// =========================================================================

	test("embedded object in insert — ignored", () => {
		const oldText = "AB";
		const changes = convert([{ retain: 1 }, { insert: {} as any }]);
		// Non-string inserts should be ignored
		expect(applyCM6Changes(oldText, changes)).toBe("AB");
	});

	test("delete at position 0", () => {
		const oldText = "ABCDE";
		const changes = convert([{ delete: 3 }]);
		expect(applyCM6Changes(oldText, changes)).toBe("DE");
	});

	test("replace at position 0", () => {
		const oldText = "ABCDE";
		const changes = convert([{ delete: 3 }, { insert: "XYZ" }]);
		expect(applyCM6Changes(oldText, changes)).toBe("XYZDE");
	});

	// =========================================================================
	// Frontmatter-specific scenarios
	// =========================================================================

	test("frontmatter timestamp replacement", () => {
		const oldText =
			"---\nmodified: 2026-03-31T12:53:18-07:00\nname: test\n---\nbody";
		const newText =
			"---\nmodified: 2026-03-31T12:53:33-07:00\nname: test\n---\nbody";
		// "18" is at position 31
		const changes = convert([{ retain: 31 }, { delete: 2 }, { insert: "33" }]);
		expect(applyCM6Changes(oldText, changes)).toBe(newText);
	});

	test("frontmatter property value change", () => {
		const oldText = "---\nin stock: true\n---\nbody";
		const newText = "---\nin stock: false\n---\nbody";
		// "true" starts at position 14
		const changes = convert([
			{ retain: 14 },
			{ delete: 4 },
			{ insert: "false" },
		]);
		expect(applyCM6Changes(oldText, changes)).toBe(newText);
	});


	// =========================================================================
	// Y.js integration: use real Y.js to generate deltas
	// =========================================================================

	test("Y.js: simple insert via Y.Text", () => {
		const oldText = "hello world";
		const { delta, newText } = getYjsDelta(oldText, (ytext) => {
			ytext.insert(5, " beautiful");
		});
		const changes = convert(delta);
		expect(applyCM6Changes(oldText, changes)).toBe(newText);
	});

	test("Y.js: simple delete via Y.Text", () => {
		const oldText = "hello beautiful world";
		const { delta, newText } = getYjsDelta(oldText, (ytext) => {
			ytext.delete(5, 10);
		});
		const changes = convert(delta);
		expect(applyCM6Changes(oldText, changes)).toBe(newText);
	});

	test("Y.js: replace via delete + insert", () => {
		const oldText = "hello world";
		const { delta, newText } = getYjsDelta(oldText, (ytext) => {
			ytext.delete(6, 5);
			ytext.insert(6, "earth");
		});
		const changes = convert(delta);
		expect(applyCM6Changes(oldText, changes)).toBe(newText);
	});

	test("Y.js: multiple edits in one transaction", () => {
		const oldText = "ABCDEFGHIJ";
		const { delta, newText } = getYjsDelta(oldText, (ytext) => {
			ytext.delete(0, 2); // remove AB
			ytext.insert(0, "XY"); // insert XY at start
			ytext.delete(6, 2); // remove GH (positions shifted)
			ytext.insert(6, "ZZ"); // insert ZZ
		});
		const changes = convert(delta);
		expect(applyCM6Changes(oldText, changes)).toBe(newText);
	});

	test("Y.js: frontmatter timestamp update", () => {
		const oldText =
			"---\nmodified: 2026-03-31T12:53:18-07:00\nname: test\n---\nbody";
		const { delta, newText } = getYjsDelta(oldText, (ytext) => {
			// Replace "18" with "33"
			ytext.delete(33, 2);
			ytext.insert(33, "33");
		});
		const changes = convert(delta);
		expect(applyCM6Changes(oldText, changes)).toBe(newText);
	});

	test("Y.js: concurrent edits via two docs merging", () => {
		// Simulate two peers editing the same Y.Text concurrently
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		const ytext1 = doc1.getText("test");
		const ytext2 = doc2.getText("test");

		// Initial state
		ytext1.insert(0, "ABCDEFGHIJ");
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Peer 1: replace CD with XX
		doc1.transact(() => {
			ytext1.delete(2, 2);
			ytext1.insert(2, "XX");
		});

		// Peer 2: replace GH with YY
		doc2.transact(() => {
			ytext2.delete(6, 2);
			ytext2.insert(6, "YY");
		});

		// Capture delta when peer 2's changes arrive at peer 1
		const beforeMerge = ytext1.toString();
		let capturedDelta: any[] = [];
		ytext1.observe((event) => {
			capturedDelta = event.delta;
		});

		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)));
		const afterMerge = ytext1.toString();

		if (capturedDelta.length > 0) {
			const changes = convert(capturedDelta);
			const result = applyCM6Changes(beforeMerge, changes);
			expect(result).toBe(afterMerge);
		}

		doc1.destroy();
		doc2.destroy();
	});

	test("Y.js: concurrent frontmatter timestamp edits", () => {
		// This is the exact scenario that causes corruption
		const initialText =
			"---\nmodified: 2026-03-31T12:53:18-07:00\nname: test\n---\nbody";

		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		const ytext1 = doc1.getText("test");
		const ytext2 = doc2.getText("test");

		ytext1.insert(0, initialText);
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

		// Peer 1: change "18" to "33"
		doc1.transact(() => {
			ytext1.delete(33, 2);
			ytext1.insert(33, "33");
		});

		// Peer 2: change "18" to "45"
		doc2.transact(() => {
			ytext2.delete(33, 2);
			ytext2.insert(33, "45");
		});

		// Apply peer 2's changes to peer 1
		const beforeMerge = ytext1.toString();
		let capturedDelta: any[] = [];
		ytext1.observe((event) => {
			capturedDelta = event.delta;
		});

		Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)));
		const afterMerge = ytext1.toString();

		if (capturedDelta.length > 0) {
			const changes = convert(capturedDelta);
			const result = applyCM6Changes(beforeMerge, changes);
			expect(result).toBe(afterMerge);
		}

		doc1.destroy();
		doc2.destroy();
	});
});
